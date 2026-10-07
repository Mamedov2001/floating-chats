/*
 * FloatingChats — floating Discord chat tiles for Vencord
 * Copyright (c) 2026 Mamedov2001
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Какие чаты попадают в оверлей и как из них собираются плитки.

import type { Channel, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, MessageStore, ReadStateStore, RelationshipStore,
    SelectedChannelStore, UserGuildSettingsStore, UserStore, WindowStore
} from "@webpack/common";

import { settings } from "./settings";
import type { ChatTile, RawMessage, RawUser, ReactionAddEvent, TileEvent, TileEventKind } from "./types";

const CDN = "https://cdn.discordapp.com";
const DISCORD_EPOCH = 1420070400000n;

/** channelId → время последнего сообщения (мс). Порядок плиток определяется этим временем. */
const recent = new Map<string, number>();
/** События по каналам с момента последнего прочтения (для списка в карточке при наведении). */
const events = new Map<string, TileEvent[]>();
/** Сколько событий помнить на канал (в карточке показываются последние из них). */
const MAX_EVENTS = 20;
/** Новые реакции на мои сообщения по каналам: Discord их в непрочитанное не считает — считаем сами. */
const reactions = new Map<string, number>();
/** Сколько чатов помнить (с запасом над maxTiles: часть может быть скрыта настройками). */
const MAX_REMEMBERED = 50;

function remember(channelId: string, at: number) {
    recent.set(channelId, Math.max(at, recent.get(channelId) ?? 0));
    if (recent.size <= MAX_REMEMBERED) return;
    const oldest = [...recent].sort((a, b) => a[1] - b[1]).slice(0, recent.size - MAX_REMEMBERED);
    for (const [id] of oldest) {
        recent.delete(id);
        events.delete(id);
        reactions.delete(id);
    }
}

/** Добавить событие; подряд идущее такое же (тот же человек, вид, эмодзи) — склеить со счётчиком. */
function addEvent(channelId: string, ev: Omit<TileEvent, "count">) {
    const list = events.get(channelId) ?? [];
    const last = list.at(-1);
    if (last && last.userId === ev.userId && last.kind === ev.kind && last.emoji === ev.emoji) {
        last.count++;
        last.at = Math.max(last.at, ev.at);
    } else {
        list.push({ ...ev, count: 1 });
        if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    }
    events.set(channelId, list);
}

function snowflakeTime(id: string) {
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

/** Почему сообщение касается меня: ответ мне, упоминание меня, моей роли, @everyone/@here. null — не касается. */
function mentionKind(message: RawMessage, channel: Channel, myId: string): TileEventKind | null {
    // Ответ на моё сообщение — даже если пинг при ответе выключен.
    if (message.referenced_message?.author?.id === myId) return "reply";
    if (message.mentions?.some(u => u.id === myId)) return "mention";

    const guildId = channel.guild_id;
    if (!guildId) return message.mention_everyone ? "everyone" : null;

    if (message.mention_roles?.length && !UserGuildSettingsStore.isSuppressRolesEnabled(guildId)) {
        const myRoles = GuildMemberStore.getMember(guildId, myId)?.roles ?? [];
        if (message.mention_roles.some(r => myRoles.includes(r))) return "role";
    }
    if (message.mention_everyone && !UserGuildSettingsStore.isSuppressEveryoneEnabled(guildId)) return "everyone";
    return null;
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
    const kind = mentionKind(message, channel, me.id);
    if (!isPrivate(channel) && !kind) return false;

    // Чат открыт в активном окне Discord — я его и так вижу.
    if (SelectedChannelStore.getChannelId() === channel.id && WindowStore.isFocused()) return false;

    // В обычном ЛС отправитель — это и есть плитка; в группе и на сервере запишем, кто и что сделал.
    if (channel.type !== ChannelType.DM)
        addEvent(channel.id, { ...personOf(channel, message.author.id, message.author), kind: kind ?? "message", at });

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

    const at = Date.now();
    reactions.set(channel.id, (reactions.get(channel.id) ?? 0) + 1);
    addEvent(channel.id, { ...personOf(channel, ev.userId), kind: "reaction", emoji: emojiText(ev.emoji), at });
    remember(channel.id, at);
    return true;
}

/** Активность в канале просмотрена (открыли его в самом Discord): реакции и список событий. */
export function clearActivity(channelId: string) {
    const hadReactions = reactions.delete(channelId);
    const hadEvents = events.delete(channelId);
    return hadReactions || hadEvents;
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

/** Что сохраняется о чате помимо времени: события для карточки и счётчик реакций (их Discord не хранит). */
interface SavedExtra {
    events?: TileEvent[];
    reactions?: number;
}

/** Снимок списка чатов для сохранения между перезапусками: [channelId, время, доп. данные?]. */
export function exportChats(): [string, number, SavedExtra?][] {
    return [...recent].map(([id, at]) => {
        const extra: SavedExtra = {};
        const list = events.get(id);
        const count = reactions.get(id);
        if (list?.length) extra.events = list;
        if (count) extra.reactions = count;
        return list?.length || count ? [id, at, extra] : [id, at];
    });
}

const optionalString = (v: unknown) => v === undefined || typeof v === "string";
const EVENT_KINDS = new Set<TileEventKind>(["mention", "reply", "role", "everyone", "message", "reaction"]);

/** Сохранённое событие пришло из хранилища — проверяем форму, прежде чем показывать. */
function parseEvent(v: unknown): TileEvent | undefined {
    if (!v || typeof v !== "object") return undefined;
    const e = v as Record<string, unknown>;
    if (typeof e.userId !== "string" || typeof e.name !== "string") return undefined;
    if (![e.username, e.avatarUrl, e.emoji].every(optionalString)) return undefined;
    if (!EVENT_KINDS.has(e.kind as TileEventKind)) return undefined;
    if (typeof e.count !== "number" || e.count < 1 || typeof e.at !== "number") return undefined;
    return {
        userId: e.userId,
        name: e.name,
        username: e.username as string | undefined,
        avatarUrl: e.avatarUrl as string | undefined,
        kind: e.kind as TileEventKind,
        emoji: e.emoji as string | undefined,
        count: Math.floor(e.count),
        at: e.at,
    };
}

/** Восстановить список. Понимает и старые форматы: [channelId, время] и { from } вместо { events }. */
export function importChats(saved: unknown) {
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "number") continue;
        const [id, at, extra] = entry as [string, number, Record<string, unknown> | undefined];
        remember(id, at);

        if (!events.has(id)) {
            const list = Array.isArray(extra?.events)
                ? extra.events.map(parseEvent).filter((e): e is TileEvent => !!e).slice(-MAX_EVENTS)
                : [];
            // Старый формат: один отправитель { from } — превращаем в одно событие.
            const from = extra?.from as Record<string, unknown> | undefined;
            if (!list.length && from) {
                const ev = parseEvent({ ...from, kind: from.emoji ? "reaction" : "mention", count: 1, at });
                if (ev) list.push(ev);
            }
            if (list.length) events.set(id, list);
        }
        const count = extra?.reactions;
        if (typeof count === "number" && count > 0 && !reactions.has(id)) reactions.set(id, Math.floor(count));
    }
}

/** Отметить канал прочитанным (как кнопка «прочитать всё» в Vencord: BULK_ACK по последнему сообщению). */
export function markRead(channelId: string) {
    clearActivity(channelId);
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
    reactions.delete(channelId);
    events.delete(channelId);
}

export function clearChats() {
    recent.clear();
    reactions.clear();
    events.clear();
}

/** URL аватара по id и полям avatar/discriminator — подходит и для User из стора, и для сырого автора из события. */
function userAvatarUrl(userId: string, user: Pick<User, "avatar" | "discriminator"> | Pick<RawUser, "avatar" | "discriminator"> | undefined) {
    if (user?.avatar) return `${CDN}/avatars/${userId}/${user.avatar}.png?size=128`;

    // Стандартные аватарки: у новых ников (discriminator "0") индекс считается от id.
    const index = user && user.discriminator && user.discriminator !== "0"
        ? Number(user.discriminator) % 5
        : Number((BigInt(userId) >> 22n) % 6n);
    return `${CDN}/embed/avatars/${index}.png`;
}

/** Кто это: имя с учётом ника на сервере, @username, аватар. raw — автор из события (если стор ещё не знает). */
function personOf(channel: Channel, userId: string, raw?: RawUser): Pick<TileEvent, "userId" | "name" | "username" | "avatarUrl"> {
    const user = UserStore.getUser(userId);
    const nick = channel.guild_id
        ? GuildMemberStore.getNick(channel.guild_id, userId)
        : RelationshipStore.getNickname(userId);
    const name = nick || raw?.global_name || user?.globalName || raw?.username || user?.username || "Unknown user";
    return { userId, name, username: raw?.username ?? user?.username, avatarUrl: userAvatarUrl(userId, user ?? raw) };
}

/** Эмодзи реакции текстом: юникод как есть, кастомный — :name:. */
function emojiText(emoji: ReactionAddEvent["emoji"]) {
    if (!emoji?.name) return undefined;
    return emoji.id ? `:${emoji.name}:` : emoji.name;
}

function makeInitials(name: string) {
    const words = name.replace(/[#@]/g, " ").trim().split(/\s+/).filter(Boolean);
    const letters = words.length >= 2
        ? [...words[0]][0] + [...words[1]][0]
        : [...(words[0] ?? "?")].slice(0, 2).join("");
    return letters.toUpperCase();
}

function userName(userId: string, user: User | undefined) {
    return RelationshipStore.getNickname(userId) || user?.globalName || user?.username || "Unknown user";
}

export function describe(channel: Channel): Pick<ChatTile, "title" | "avatarUrl" | "initials" | "name" | "context"> {
    if (channel.type === ChannelType.DM) {
        const userId = channel.getRecipientId() ?? channel.recipients?.[0];
        const user = userId ? UserStore.getUser(userId) : undefined;
        const title = userId ? userName(userId, user) : (channel.name || "Direct message");
        return { title, name: title, avatarUrl: userId ? userAvatarUrl(userId, user) : undefined, initials: makeInitials(title) };
    }

    if (channel.type === ChannelType.GROUP_DM) {
        const title = channel.name
            || channel.recipients.map(id => userName(id, UserStore.getUser(id))).join(", ")
            || "Group";
        return {
            title,
            name: title,
            avatarUrl: channel.icon ? `${CDN}/channel-icons/${channel.id}/${channel.icon}.png?size=128` : undefined,
            initials: makeInitials(title),
        };
    }

    const guild = GuildStore.getGuild(channel.guild_id);
    const guildName = guild?.name ?? "Server";
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
            events: events.get(channelId)?.map(e => ({ ...e })),
        });
    }
    return tiles;
}
