import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ReadStateStore, UserStore } from "@webpack/common";

import { buildTiles, clearChats, clearReactions, exportChats, handleMessage, handleReaction, importChats, markRead, seedFromUnread } from "./chats";
import { closeChatPopout, openChatPopout, resetHistoryRequests, resetPopoutPosition } from "./popoutChat";
import { onResetPositions, onTilesSettingChanged, settings } from "./settings";
import type { MessageCreateEvent, OverlayEvent, OverlayState, ReactionAddEvent } from "./types";

const logger = new Logger("FloatingChats", "#5865f2");
const Native = VencordNative.pluginHelpers.FloatingChats as PluginNative<typeof import("./native")>;

// Номер текущего цикла опроса: при stop()/повторном start() старый цикл видит чужой номер и выходит,
// иначе два цикла бесконечно сбрасывали бы ожидание друг друга в nextEvent.
let pollGeneration = 0;
let running = false;
/** Чат, открытый сейчас в попауте (его плитка подсвечена и не прячется, даже если всё прочитано). */
let openChannelId: string | null = null;
let lastSent = "";
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

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

    const tiles = buildTiles(openChannelId);
    saveChats();

    // ReadStateStore меняется на каждое сообщение в любом канале — не гоняем IPC без изменений.
    const state: OverlayState = {
        orientation: settings.store.orientation === "vertical" ? "vertical" : "horizontal",
        showLabels: settings.store.showLabels,
        tiles,
        activeChannelId: openChannelId,
    };
    const payload = JSON.stringify(state);
    if (payload === lastSent) return;
    lastSent = payload;

    Native.setOverlayState(state)
        .catch(e => logger.error("Не удалось обновить оверлей", e));
}

/** Отложенное обновление: сторы Discord обрабатывают событие раньше или позже нас — дадим им закончить. */
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(pushState, 50);
}

function onTileClick(channelId: string) {
    // Повторный клик по открытой плитке — закрыть чат.
    if (openChannelId === channelId) {
        closeChatPopout();
        return;
    }
    // Переключились на другой чат — предыдущий просмотрен.
    if (openChannelId) markRead(openChannelId);
    openChannelId = channelId;
    markRead(channelId);

    openChatPopout(channelId, () => {
        // Закрыли чат — всё, что пришло, пока он был открыт, тоже просмотрено.
        if (openChannelId) markRead(openChannelId);
        openChannelId = null;
        scheduleRefresh();
    }).catch(e => {
        logger.error("Не удалось открыть чат", e);
        openChannelId = null;
        scheduleRefresh();
    });
    scheduleRefresh();
}

function handleOverlayEvent(ev: OverlayEvent) {
    switch (ev.type) {
        case "tileClick":
            onTileClick(ev.channelId);
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
    description: "Floating chat tiles on top of all windows: see who messaged you and reply without switching to Discord",
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
        MESSAGE_REACTION_ADD(ev: ReactionAddEvent) {
            if (!running) return;
            if (handleReaction(ev)) {
                logger.info("Реакция на моё сообщение:", ev.channelId);
                scheduleRefresh();
            }
        },
        // Открыли канал в самом Discord — его реакции просмотрены.
        CHANNEL_SELECT({ channelId }: { channelId?: string | null; }) {
            if (running && channelId && clearReactions(channelId)) scheduleRefresh();
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
        openChannelId = null;
        onTilesSettingChanged.fn = () => { };
        onResetPositions.fn = () => { };
        ReadStateStore.removeChangeListener(scheduleRefresh);
        clearChats();
        storeKey = null;
        lastSaved = "";
        resetHistoryRequests();
        Native.disposeOverlay();
        logger.info("Плагин остановлен");
    },
});
