import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";

import type { MessageCreateEvent } from "./types";

const logger = new Logger("FloatingChats", "#5865f2");

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

    start() {
        logger.info("Плагин запущен");
    },

    stop() {
        logger.info("Плагин остановлен");
    },
});
