// Какие чаты попадают в оверлей и как из них собираются плитки.

import type { Channel, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, MessageStore, ReadStateStore, RelationshipStore,
    SelectedChannelStore, UserGuildSettingsStore, UserStore, WindowStore
} from "@webpack/common";

import { settings } from "./settings";
import type { ChatTile, RawMessage, ReactionAddEvent } from "./types";

const CDN = "https://cdn.discordapp.com";
const DISCORD_EPOCH = 1420070400000n;

/** channelId → время последнего сообщения (мс). Порядок плиток определяется этим временем. */
const recent = new Map<string, number>();
/** Новые реакции на мои сообщения по каналам: Discord их в непрочитанное не считает — считаем сами. */
const reactions = new Map<string, number>();
/** Сколько чатов помнить (с запасом над maxTiles: часть может быть скрыта настройками). */
const MAX_REMEMBERED = 50;

function remember(channelId: string, at: number) {
    recent.set(channelId, Math.max(at, recent.get(channelId) ?? 0));
    if (recent.size <= MAX_REMEMBERED) return;
    const oldest = [...recent].sort((a, b) => a[1] - b[1]).slice(0, recent.size - MAX_REMEMBERED);
    for (const [id] of oldest) recent.delete(id);
}

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
        remember(channel.id, at);
        return true;
    }

    if (RelationshipStore.isBlocked(message.author.id)) return false;
    if (!channelAllowed(channel)) return false;
    if (!isPrivate(channel) && !mentionsMe(message, channel, me.id)) return false;

    // Чат открыт в активном окне Discord — я его и так вижу.
    if (SelectedChannelStore.getChannelId() === channel.id && WindowStore.isFocused()) return false;

    remember(channel.id, at);
    return true;
}

/**
 * Реакция на сообщение. Плитку поднимает только чужая реакция на МОЁ сообщение.
 * Возвращает true, если набор плиток мог измениться.
 */
export function handleReaction(ev: ReactionAddEvent): boolean {
    if (!settings.store.includeReactions || ev.optimistic) return false;

    const me = UserStore.getCurrentUser();
    if (!me || ev.userId === me.id) return false;

    const authorId = ev.messageAuthorId ?? MessageStore.getMessage(ev.channelId, ev.messageId)?.author?.id;
    if (authorId !== me.id) return false;

    const channel = ChannelStore.getChannel(ev.channelId);
    if (!channel || !channelAllowed(channel)) return false;
    if (RelationshipStore.isBlocked(ev.userId)) return false;
    if (SelectedChannelStore.getChannelId() === channel.id && WindowStore.isFocused()) return false;

    reactions.set(channel.id, (reactions.get(channel.id) ?? 0) + 1);
    remember(channel.id, Date.now());
    return true;
}

/** Реакции в канале просмотрены (открыли чат в оверлее или в самом Discord). */
export function clearReactions(channelId: string) {
    return reactions.delete(channelId);
}

/** Подхватить ЛС и группы, где уже есть непрочитанное (вызывать после загрузки данных Discord). */
export function seedFromUnread() {
    for (const channel of ChannelStore.getSortedPrivateChannels()) {
        if (recent.has(channel.id) || !channelAllowed(channel)) continue;
        if (ReadStateStore.getMentionCount(channel.id) <= 0) continue;
        const lastId = channel.lastMessageId ?? ReadStateStore.lastMessageId(channel.id);
        remember(channel.id, lastId ? snowflakeTime(lastId) : 0);
    }
}

/** Снимок списка чатов для сохранения между перезапусками. */
export function exportChats(): [string, number][] {
    return [...recent];
}

export function importChats(saved: unknown) {
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number")
            remember(entry[0], entry[1]);
    }
}

/** Отметить канал прочитанным (как кнопка «прочитать всё» в Vencord: BULK_ACK по последнему сообщению). */
export function markRead(channelId: string) {
    clearReactions(channelId);
    if (!ReadStateStore.hasUnread(channelId)) return;
    const messageId = ReadStateStore.lastMessageId(channelId);
    if (!messageId) return;
    FluxDispatcher.dispatch({
        type: "BULK_ACK",
        context: "APP",
        channels: [{ channelId, messageId, readStateType: 0 }],
    });
}

export function removeChat(channelId: string) {
    recent.delete(channelId);
}

export function clearChats() {
    recent.clear();
    reactions.clear();
}

export function userAvatarUrl(userId: string, user: User | undefined) {
    if (user?.avatar) return `${CDN}/avatars/${userId}/${user.avatar}.png?size=128`;

    // Стандартные аватарки: у новых ников (discriminator "0") индекс считается от id.
    const index = user && user.discriminator && user.discriminator !== "0"
        ? Number(user.discriminator) % 5
        : Number((BigInt(userId) >> 22n) % 6n);
    return `${CDN}/embed/avatars/${index}.png`;
}

export function makeInitials(name: string) {
    const words = name.replace(/[#@]/g, " ").trim().split(/\s+/).filter(Boolean);
    const letters = words.length >= 2
        ? [...words[0]][0] + [...words[1]][0]
        : [...(words[0] ?? "?")].slice(0, 2).join("");
    return letters.toUpperCase();
}

export function userName(userId: string, user: User | undefined) {
    return RelationshipStore.getNickname(userId) || user?.globalName || user?.username || "Неизвестный";
}

export function describe(channel: Channel): Pick<ChatTile, "title" | "avatarUrl" | "initials" | "name" | "context"> {
    if (channel.type === ChannelType.DM) {
        const userId = channel.getRecipientId() ?? channel.recipients?.[0];
        const user = userId ? UserStore.getUser(userId) : undefined;
        const title = userId ? userName(userId, user) : (channel.name || "ЛС");
        return { title, name: title, avatarUrl: userId ? userAvatarUrl(userId, user) : undefined, initials: makeInitials(title) };
    }

    if (channel.type === ChannelType.GROUP_DM) {
        const title = channel.name
            || channel.recipients.map(id => userName(id, UserStore.getUser(id))).join(", ")
            || "Группа";
        return {
            title,
            name: title,
            avatarUrl: channel.icon ? `${CDN}/channel-icons/${channel.id}/${channel.icon}.png?size=128` : undefined,
            initials: makeInitials(title),
        };
    }

    const guild = GuildStore.getGuild(channel.guild_id);
    const guildName = guild?.name ?? "Сервер";
    return {
        title: `#${channel.name} · ${guildName}`,
        name: `#${channel.name}`,
        context: guildName,
        avatarUrl: guild?.icon ? `${CDN}/icons/${guild.id}/${guild.icon}.png?size=128` : undefined,
        initials: makeInitials(guildName),
    };
}

/**
 * Собрать плитки: самые свежие первыми, не больше maxTiles.
 * keepChannelId — открытый сейчас чат: его плитка остаётся, даже если всё прочитано.
 */
export function buildTiles(keepChannelId: string | null = null): ChatTile[] {
    const sorted = [...recent].sort((a, b) => b[1] - a[1]);
    const tiles: ChatTile[] = [];

    for (const [channelId, lastMessageAt] of sorted) {
        // Канала нет в сторе: Discord ещё не загрузил данные или канал удалён — просто не показываем.
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) continue;
        // Отключённые настройками чаты не забываем — вернутся, если настройку включить обратно.
        if (!channelAllowed(channel)) continue;

        // Сверх лимита не показываем, но помним (лимит памяти — MAX_REMEMBERED).
        if (tiles.length >= settings.store.maxTiles) break;

        const unread = ReadStateStore.getMentionCount(channelId) + (reactions.get(channelId) ?? 0);
        // Прочитанные чаты прячем; вернутся с новым сообщением (чат остаётся в памяти).
        if (settings.store.hideRead && unread <= 0 && channelId !== keepChannelId) continue;

        tiles.push({
            channelId,
            ...describe(channel),
            unread,
            lastMessageAt,
        });
    }
    return tiles;
}
