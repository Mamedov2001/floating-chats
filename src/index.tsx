import * as DataStore from "@api/DataStore";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { MessageStore, ReadStateStore, UserStore } from "@webpack/common";

import { buildChatPanel, ensureHistory, maxMessageLength, resetHistoryRequests } from "./chatPanel";
import { buildTiles, clearChats, exportChats, handleMessage, importChats, markRead, seedFromUnread } from "./chats";
import { onResetPositions, onTilesSettingChanged, settings } from "./settings";
import { closeChatPopout, openChatPopout, resetPopoutPosition } from "./spike/popoutChat";
import type { MessageCreateEvent, OverlayEvent } from "./types";

const logger = new Logger("FloatingChats", "#5865f2");
const Native = VencordNative.pluginHelpers.FloatingChats as PluginNative<typeof import("./native")>;

// Номер текущего цикла опроса: при stop()/повторном start() старый цикл видит чужой номер и выходит,
// иначе два цикла бесконечно сбрасывали бы ожидание друг друга в nextEvent.
let pollGeneration = 0;
/** ВРЕМЕННО (spike): открывать чат в попауте Discord вместо своей панели. */
const SPIKE_DISCORD_POPOUT = true;
let popoutChannelId: string | null = null;
let running = false;
let activeChannelId: string | null = null;
let lastSent = "";
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Ошибка последней отправки по каналу — показывается в панели до следующей удачной отправки. */
const sendErrors = new Map<string, string>();

// Список чатов переживает перезапуск Discord. Ключ — по аккаунту, чтобы не смешивать несколько аккаунтов.
let storeKey: string | null = null;
let lastSaved = "";

const dataKey = (userId: string) => `FloatingChats_chats_${userId}`;

/** Восстановить сохранённый список и подхватить непрочитанное. Нужны загруженные данные Discord. */
async function restoreChats() {
    const me = UserStore.getCurrentUser();
    if (!me || !running) return;

    const key = dataKey(me.id);
    if (storeKey !== key) {
        clearChats();
        importChats(await DataStore.get(key));
        if (!running) return;
        storeKey = key;
        lastSaved = JSON.stringify(exportChats());
    }
    seedFromUnread();
    scheduleRefresh();
}

function saveChats() {
    // До восстановления не сохраняем — иначе затрём сохранённый список пустым.
    if (!storeKey) return;
    const snapshot = JSON.stringify(exportChats());
    if (snapshot === lastSaved) return;
    lastSaved = snapshot;
    DataStore.set(storeKey, exportChats())
        .catch(e => logger.error("Не удалось сохранить список чатов", e));
}

function pushState() {
    if (!running) return;

    const tiles = buildTiles(activeChannelId ?? popoutChannelId);
    saveChats();
    if (activeChannelId && !tiles.some(t => t.channelId === activeChannelId)) activeChannelId = null;
    const chat = activeChannelId ? buildChatPanel(activeChannelId, sendErrors.get(activeChannelId)) : null;
    if (!chat) activeChannelId = null;

    // Сторы Discord меняются на каждое сообщение в любом канале — не гоняем IPC без изменений.
    const state = {
        orientation: settings.store.orientation === "vertical" ? "vertical" as const : "horizontal" as const,
        tiles,
        activeChannelId: activeChannelId ?? popoutChannelId,
        chat,
    };
    const payload = JSON.stringify(state);
    if (payload === lastSent) return;
    lastSent = payload;

    Native.setOverlayState(state)
        .catch(e => logger.error("Не удалось обновить оверлей", e));
}

function setActive(channelId: string | null) {
    activeChannelId = channelId;
    if (channelId) ensureHistory(channelId);
    pushState();
}

/** Отложенное обновление: сторы Discord обрабатывают событие раньше или позже нас — дадим им закончить. */
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(pushState, 50);
}

async function sendFromOverlay(channelId: string, content: string) {
    // Оверлей может писать только в открытый в нём чат.
    if (channelId !== activeChannelId) return;

    const limit = maxMessageLength();
    if (content.length > limit) {
        sendErrors.set(channelId, `Сообщение длиннее ${limit} символов`);
        scheduleRefresh();
        return;
    }

    sendErrors.delete(channelId);
    try {
        // waitForChannelReady = false: канал не открыт в Discord, ждать его загрузки не нужно.
        // Сообщение сразу попадает в MessageStore со статусом SENDING — панель покажет его мгновенно.
        await sendMessage(channelId, { content }, false);
    } catch (e) {
        logger.error("Не удалось отправить сообщение", channelId, e);
        sendErrors.set(channelId, "Не удалось отправить сообщение");
    }
    scheduleRefresh();
}

function handleOverlayEvent(ev: OverlayEvent) {
    switch (ev.type) {
        case "tileClick":
            // ВРЕМЕННО (spike): вместо своей панели — настоящий чат Discord в его попауте.
            if (SPIKE_DISCORD_POPOUT) {
                // Повторный клик по открытой плитке — закрыть чат.
                if (popoutChannelId === ev.channelId) {
                    closeChatPopout();
                    break;
                }
                // Переключились на другой чат — предыдущий просмотрен.
                if (popoutChannelId) markRead(popoutChannelId);
                popoutChannelId = ev.channelId;
                markRead(ev.channelId);
                openChatPopout(ev.channelId, () => {
                    // Закрыли чат — всё, что пришло, пока он был открыт, тоже просмотрено.
                    if (popoutChannelId) markRead(popoutChannelId);
                    popoutChannelId = null;
                    scheduleRefresh();
                }).catch(e => logger.error("Не удалось открыть чат", e));
                scheduleRefresh();
                break;
            }
            setActive(activeChannelId === ev.channelId ? null : ev.channelId);
            break;
        case "send":
            sendFromOverlay(ev.channelId, ev.content);
            break;
        case "close":
            if (activeChannelId) setActive(null);
            break;
    }
}

async function pollOverlayEvents(generation: number) {
    while (generation === pollGeneration) {
        let ev: OverlayEvent | null;
        try {
            ev = await Native.nextEvent();
        } catch (e) {
            logger.error("nextEvent упал, останавливаю опрос", e);
            return;
        }
        if (generation !== pollGeneration) return;
        if (ev) {
            try {
                handleOverlayEvent(ev);
            } catch (e) {
                logger.error("Ошибка обработки события оверлея", ev, e);
            }
        }
    }
}

export default definePlugin({
    name: "FloatingChats",
    description: "Плавающая панель чатов поверх всех окон",
    authors: [{ name: "Zaur", id: 0n }],
    settings,

    flux: {
        MESSAGE_CREATE({ message, optimistic }: MessageCreateEvent) {
            if (optimistic || !running) return;
            if (handleMessage(message)) {
                logger.info("Плитка обновлена:", message.channel_id);
                scheduleRefresh();
            }
        },
        // Данные Discord (каналы, непрочитанное) загружены — после старта или переподключения.
        CONNECTION_OPEN() {
            restoreChats().catch(e => logger.error("Не удалось восстановить список чатов", e));
        },
    },

    async start() {
        running = true;
        lastSent = "";
        onTilesSettingChanged.fn = scheduleRefresh;
        onResetPositions.fn = () => {
            Native.resetWidgetPosition().catch(e => logger.error("Не удалось сбросить позицию виджета", e));
            resetPopoutPosition().catch(e => logger.error("Не удалось сбросить позицию чата", e));
        };
        ReadStateStore.addChangeListener(scheduleRefresh);
        // История открытого чата: новые, изменённые, удалённые сообщения и догрузка.
        MessageStore.addChangeListener(scheduleRefresh);

        await Native.initOverlay();
        await restoreChats();
        pushState();
        pollOverlayEvents(++pollGeneration);
        logger.info("Плагин запущен");
    },

    stop() {
        running = false;
        pollGeneration++;
        clearTimeout(refreshTimer);
        closeChatPopout();
        onTilesSettingChanged.fn = () => { };
        onResetPositions.fn = () => { };
        ReadStateStore.removeChangeListener(scheduleRefresh);
        MessageStore.removeChangeListener(scheduleRefresh);
        clearChats();
        sendErrors.clear();
        storeKey = null;
        lastSaved = "";
        resetHistoryRequests();
        activeChannelId = null;
        Native.disposeOverlay();
        logger.info("Плагин остановлен");
    },
});
