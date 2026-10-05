// Какие чаты попадают в оверлей и как из них собираются плитки.

import type { Channel, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    ChannelStore, GuildMemberStore, GuildStore, ReadStateStore, RelationshipStore,
    SelectedChannelStore, UserGuildSettingsStore, UserStore, WindowStore
} from "@webpack/common";

import { settings } from "./settings";
import type { ChatTile, RawMessage } from "./types";

const CDN = "https://cdn.discordapp.com";
const DISCORD_EPOCH = 1420070400000n;

/** channelId → время последнего сообщения (мс). Порядок плиток определяется этим временем. */
const recent = new Map<string, number>();

export function snowflakeTime(id: string) {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function isPrivate(channel: Channel) {
    return channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM;
}

/** Канал разрешён текущими настройками (тип + заглушение). Не зависит от конкретного сообщения. */
function channelAllowed(channel: Channel) {
    const { includeDMs, includeGroupDMs, includeMentions, respectMuted } = settings.store;

    if (channel.type === ChannelType.DM) {
        if (!includeDMs) return false;
    } else if (channel.type === ChannelType.GROUP_DM) {
        if (!includeGroupDMs) return false;
    } else if (!includeMentions || !channel.guild_id) {
        return false;
    }

    if (respectMuted) {
        if (isPrivate(channel)) {
            if (UserGuildSettingsStore.isChannelMuted(null, channel.id)) return false;
        } else if (UserGuildSettingsStore.isGuildOrCategoryOrChannelMuted(channel.guild_id, channel.id)) {
            return false;
        }
    }
    return true;
}

function mentionsMe(message: RawMessage, channel: Channel, myId: string) {
    if (message.mentions?.some(u => u.id === myId)) return true;

    const guildId = channel.guild_id;
    if (message.mention_everyone && !UserGuildSettingsStore.isSuppressEveryoneEnabled(guildId)) return true;

    if (message.mention_roles?.length && !UserGuildSettingsStore.isSuppressRolesEnabled(guildId)) {
        const myRoles = GuildMemberStore.getMember(guildId, myId)?.roles ?? [];
        if (message.mention_roles.some(r => myRoles.includes(r))) return true;
    }
    return false;
}

/**
 * Обработать входящее сообщение. Возвращает true, если набор плиток мог измениться.
 */
export function handleMessage(message: RawMessage): boolean {
    const me = UserStore.getCurrentUser();
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!me || !channel) return false;

    const at = Date.parse(message.timestamp) || Date.now();

    // Свой ответ (например, из самого Discord) лишь поднимает уже существующую плитку.
    if (message.author.id === me.id) {
        if (!recent.has(channel.id)) return false;
        recent.set(channel.id, at);
        return true;
    }

    if (RelationshipStore.isBlocked(message.author.id)) return false;
    if (!channelAllowed(channel)) return false;
    if (!isPrivate(channel) && !mentionsMe(message, channel, me.id)) return false;

    // Чат открыт в активном окне Discord — я его и так вижу.
    if (SelectedChannelStore.getChannelId() === channel.id && WindowStore.isFocused()) return false;

    recent.set(channel.id, at);
    return true;
}

/** При старте подхватить ЛС и группы, где уже есть непрочитанное. */
export function seedFromUnread() {
    for (const channel of ChannelStore.getSortedPrivateChannels()) {
        if (recent.has(channel.id) || !channelAllowed(channel)) continue;
        if (ReadStateStore.getMentionCount(channel.id) <= 0) continue;
        const lastId = channel.lastMessageId ?? ReadStateStore.lastMessageId(channel.id);
        recent.set(channel.id, lastId ? snowflakeTime(lastId) : 0);
    }
}

export function removeChat(channelId: string) {
    recent.delete(channelId);
}

export function clearChats() {
    recent.clear();
}

function userAvatarUrl(userId: string, user: User | undefined) {
    if (user?.avatar) return `${CDN}/avatars/${userId}/${user.avatar}.png?size=128`;

    // Стандартные аватарки: у новых ников (discriminator "0") индекс считается от id.
    const index = user && user.discriminator && user.discriminator !== "0"
        ? Number(user.discriminator) % 5
        : Number((BigInt(userId) >> 22n) % 6n);
    return `${CDN}/embed/avatars/${index}.png`;
}

function makeInitials(name: string) {
    const words = name.replace(/[#@]/g, " ").trim().split(/\s+/).filter(Boolean);
    const letters = words.length >= 2
        ? [...words[0]][0] + [...words[1]][0]
        : [...(words[0] ?? "?")].slice(0, 2).join("");
    return letters.toUpperCase();
}

function userName(userId: string, user: User | undefined) {
    return RelationshipStore.getNickname(userId) || user?.globalName || user?.username || "Неизвестный";
}

function describe(channel: Channel): Pick<ChatTile, "title" | "avatarUrl" | "initials"> {
    if (channel.type === ChannelType.DM) {
        const userId = channel.getRecipientId() ?? channel.recipients?.[0];
        const user = userId ? UserStore.getUser(userId) : undefined;
        const title = userId ? userName(userId, user) : (channel.name || "ЛС");
        return { title, avatarUrl: userId ? userAvatarUrl(userId, user) : undefined, initials: makeInitials(title) };
    }

    if (channel.type === ChannelType.GROUP_DM) {
        const title = channel.name
            || channel.recipients.map(id => userName(id, UserStore.getUser(id))).join(", ")
            || "Группа";
        return {
            title,
            avatarUrl: channel.icon ? `${CDN}/channel-icons/${channel.id}/${channel.icon}.png?size=128` : undefined,
            initials: makeInitials(title),
        };
    }

    const guild = GuildStore.getGuild(channel.guild_id);
    const guildName = guild?.name ?? "Сервер";
    return {
        title: `#${channel.name} · ${guildName}`,
        avatarUrl: guild?.icon ? `${CDN}/icons/${guild.id}/${guild.icon}.png?size=128` : undefined,
        initials: makeInitials(guildName),
    };
}

/** Собрать плитки: самые свежие первыми, не больше maxTiles. Лишние и исчезнувшие чаты забываются. */
export function buildTiles(): ChatTile[] {
    const sorted = [...recent].sort((a, b) => b[1] - a[1]);
    const tiles: ChatTile[] = [];

    for (const [channelId, lastMessageAt] of sorted) {
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) {
            recent.delete(channelId);
            continue;
        }
        // Отключённые настройками чаты не забываем — вернутся, если настройку включить обратно.
        if (!channelAllowed(channel)) continue;

        if (tiles.length >= settings.store.maxTiles) {
            recent.delete(channelId);
            continue;
        }

        tiles.push({
            channelId,
            ...describe(channel),
            unread: ReadStateStore.getMentionCount(channelId),
            lastMessageAt,
        });
    }
    return tiles;
}
