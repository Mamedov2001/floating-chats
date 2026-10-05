import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ReadStateStore } from "@webpack/common";

import { buildTiles, clearChats, handleMessage, seedFromUnread } from "./chats";
import { onTilesSettingChanged, settings } from "./settings";
import type { MessageCreateEvent, OverlayEvent } from "./types";

const logger = new Logger("FloatingChats", "#5865f2");
const Native = VencordNative.pluginHelpers.FloatingChats as PluginNative<typeof import("./native")>;

// Номер текущего цикла опроса: при stop()/повторном start() старый цикл видит чужой номер и выходит,
// иначе два цикла бесконечно сбрасывали бы ожидание друг друга в nextEvent.
let pollGeneration = 0;
let running = false;
let activeChannelId: string | null = null;
let lastSent = "";
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function pushTiles() {
    if (!running) return;

    const tiles = buildTiles();
    if (activeChannelId && !tiles.some(t => t.channelId === activeChannelId)) activeChannelId = null;

    // ReadStateStore меняется на каждое сообщение в любом канале — не гоняем IPC без изменений.
    const payload = JSON.stringify([tiles, activeChannelId]);
    if (payload === lastSent) return;
    lastSent = payload;

    Native.setOverlayState(tiles, activeChannelId)
        .catch(e => logger.error("Не удалось обновить оверлей", e));
}

/** Отложенное обновление: сторы Discord обрабатывают событие раньше или позже нас — дадим им закончить. */
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(pushTiles, 50);
}

function handleOverlayEvent(ev: OverlayEvent) {
    switch (ev.type) {
        case "tileClick":
            activeChannelId = activeChannelId === ev.channelId ? null : ev.channelId;
            pushTiles();
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
            if (handleMessage(message)) scheduleRefresh();
        },
    },

    async start() {
        running = true;
        lastSent = "";
        onTilesSettingChanged.fn = scheduleRefresh;
        ReadStateStore.addChangeListener(scheduleRefresh);

        await Native.initOverlay();
        seedFromUnread();
        pushTiles();
        pollOverlayEvents(++pollGeneration);
        logger.info("Плагин запущен");
    },

    stop() {
        running = false;
        pollGeneration++;
        clearTimeout(refreshTimer);
        onTilesSettingChanged.fn = () => { };
        ReadStateStore.removeChangeListener(scheduleRefresh);
        clearChats();
        activeChannelId = null;
        Native.disposeOverlay();
        logger.info("Плагин остановлен");
    },
});
