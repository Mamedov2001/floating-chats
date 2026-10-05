import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";

import type { ChatTile, MessageCreateEvent, OverlayEvent } from "./types";

const logger = new Logger("FloatingChats", "#5865f2");
const Native = VencordNative.pluginHelpers.FloatingChats as PluginNative<typeof import("./native")>;

// Этап 2: тестовые плитки, пока нет реальных данных. Первая — самая свежая (у правого края).
const TEST_TILES: ChatTile[] = [
    { channelId: "test-da", title: "Дмитрий А.", initials: "ДА", unread: 1, lastMessageAt: 5 },
    { channelId: "test-ol", title: "Ольга", initials: "ОЛ", unread: 12, lastMessageAt: 4 },
    { channelId: "test-ti", title: "Тимур И.", initials: "ТИ", unread: 0, lastMessageAt: 3 },
    { channelId: "test-al", title: "Алексей", initials: "АЛ", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png", unread: 3, lastMessageAt: 2 },
    { channelId: "test-gd", title: "Game Dev · #general", initials: "GD", avatarUrl: "https://cdn.discordapp.com/embed/avatars/9999.png", unread: 0, lastMessageAt: 1 },
];

// Номер текущего цикла опроса: при stop()/повторном start() старый цикл видит чужой номер и выходит,
// иначе два цикла бесконечно сбрасывали бы ожидание друг друга в nextEvent.
let pollGeneration = 0;
let activeChannelId: string | null = null;

function handleOverlayEvent(ev: OverlayEvent) {
    switch (ev.type) {
        case "tileClick":
            logger.info("Клик по плитке", ev.channelId);
            activeChannelId = activeChannelId === ev.channelId ? null : ev.channelId;
            Native.setOverlayState(TEST_TILES, activeChannelId);
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

function channelTypeName(type: number) {
    switch (type) {
        case ChannelType.DM: return "DM";
        case ChannelType.GROUP_DM: return "GROUP_DM";
        case ChannelType.GUILD_TEXT: return "GUILD_TEXT";
        case ChannelType.GUILD_ANNOUNCEMENT: return "GUILD_ANNOUNCEMENT";
        case ChannelType.PUBLIC_THREAD: return "PUBLIC_THREAD";
        case ChannelType.PRIVATE_THREAD: return "PRIVATE_THREAD";
        default: return `type ${type}`;
    }
}

export default definePlugin({
    name: "FloatingChats",
    description: "Плавающая панель чатов поверх всех окон",
    authors: [{ name: "Zaur", id: 0n }],

    flux: {
        MESSAGE_CREATE({ message, optimistic }: MessageCreateEvent) {
            if (optimistic) return;

            const me = UserStore.getCurrentUser();
            if (!me || message.author.id === me.id) return;

            const channel = ChannelStore.getChannel(message.channel_id);
            const guild = message.guild_id ? GuildStore.getGuild(message.guild_id) : null;
            const mentionsMe = message.mentions.some(u => u.id === me.id);

            logger.info(
                `[${channel ? channelTypeName(channel.type) : "unknown channel"}]`,
                `${message.author.global_name ?? message.author.username} (${message.author.id})`,
                "→",
                guild ? `#${channel?.name} · ${guild.name}` : (channel?.name || message.channel_id),
                mentionsMe ? "[упоминание]" : "",
                message.mention_everyone ? "[@everyone]" : "",
                "\n",
                message.content || "(без текста)",
            );
        },
    },

    async start() {
        logger.info("Плагин запущен");
        await Native.initOverlay();
        await Native.setOverlayState(TEST_TILES, activeChannelId);
        pollOverlayEvents(++pollGeneration);
    },

    stop() {
        pollGeneration++;
        Native.disposeOverlay();
        logger.info("Плагин остановлен");
    },
});
