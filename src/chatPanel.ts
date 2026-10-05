// Содержимое раскрытой панели чата: история канала из MessageStore в простом текстовом виде.

import { Logger } from "@utils/Logger";
import type { Channel, Message } from "@vencord/discord-types";
import { ChannelType, MessageType } from "@vencord/discord-types/enums";
import {
    ChannelStore, GuildMemberStore, GuildRoleStore, MessageActions, MessageStore,
    RelationshipStore, UserStore
} from "@webpack/common";

import { describe, makeInitials, userAvatarUrl } from "./chats";
import type { ChatMessage, ChatPanel } from "./types";

const logger = new Logger("FloatingChats");

const HISTORY_LIMIT = 50;
const SHOWN_TYPES = new Set<number>([MessageType.DEFAULT, MessageType.REPLY, MessageType.CHAT_INPUT_COMMAND, MessageType.CONTEXT_MENU_COMMAND]);

/** Каналы, для которых уже запрошена история (чтобы не дёргать API на каждое обновление). */
const requested = new Set<string>();

export function resetHistoryRequests() {
    requested.clear();
}

/** Подгрузить историю канала, если Discord её ещё не загрузил (канал не открывался в этой сессии). */
export function ensureHistory(channelId: string) {
    const msgs = MessageStore.getMessages(channelId);
    if (msgs?.ready || requested.has(channelId)) return;
    requested.add(channelId);

    if (typeof MessageActions?.fetchMessages !== "function") {
        logger.warn("MessageActions.fetchMessages не найден — история не будет подгружена");
        return;
    }
    try {
        MessageActions.fetchMessages({ channelId, limit: HISTORY_LIMIT });
    } catch (e) {
        logger.error("Не удалось загрузить историю", channelId, e);
    }
}

function authorName(channel: Channel, userId: string) {
    const user = UserStore.getUser(userId);
    if (channel.guild_id) {
        const nick = GuildMemberStore.getNick(channel.guild_id, userId);
        if (nick) return nick;
    } else {
        const nick = RelationshipStore.getNickname(userId);
        if (nick) return nick;
    }
    return user?.globalName || user?.username || "Неизвестный";
}

/** Заменить разметку упоминаний Discord (<@id>, <#id>, <:emoji:id>, <t:…>) на читаемый текст. */
function formatContent(content: string, channel: Channel) {
    return content
        .replace(/<@!?(\d+)>/g, (_, id) => "@" + authorName(channel, id))
        .replace(/<@&(\d+)>/g, (_, id) => "@" + (channel.guild_id && GuildRoleStore.getRole(channel.guild_id, id)?.name || "роль"))
        .replace(/<#(\d+)>/g, (_, id) => "#" + (ChannelStore.getChannel(id)?.name ?? "канал"))
        .replace(/<a?(:\w+:)\d+>/g, "$1")
        .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, sec) => new Date(Number(sec) * 1000).toLocaleString("ru-RU"));
}

function preview(text: string, max: number) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function toChatMessage(m: Message, channel: Channel, myId: string): ChatMessage {
    const authorId = m.author.id;
    const mine = authorId === myId;
    const name = mine ? "Вы" : authorName(channel, authorId);

    const extras: string[] = [];
    for (const a of m.attachments ?? []) extras.push(`📎 ${a.filename}`);
    for (const s of m.stickerItems ?? []) extras.push(`Стикер: ${s.name}`);
    if (!m.content && !extras.length && m.embeds?.length) extras.push("[встроенное содержимое]");

    let replyTo: string | undefined;
    const ref = m.messageReference;
    if (m.type === MessageType.REPLY && ref?.message_id) {
        const orig = MessageStore.getMessage(ref.channel_id, ref.message_id);
        replyTo = orig
            ? `${orig.author.id === myId ? "Вы" : authorName(channel, orig.author.id)}: ${preview(formatContent(orig.content || "вложение", channel), 80)}`
            : "сообщение недоступно";
    }

    return {
        id: m.id,
        authorId,
        authorName: name,
        avatarUrl: userAvatarUrl(authorId, m.author),
        initials: makeInitials(name),
        content: formatContent(m.content ?? "", channel),
        timestamp: +m.timestamp,
        mine,
        edited: !!m.editedTimestamp,
        replyTo,
        extras,
    };
}

function placeholderFor(channel: Channel, title: string) {
    if (channel.type === ChannelType.DM) return `Написать @${title}`;
    if (channel.type === ChannelType.GROUP_DM) return `Написать в ${title}`;
    return `Написать в #${channel.name}`;
}

export function buildChatPanel(channelId: string): ChatPanel | null {
    const channel = ChannelStore.getChannel(channelId);
    const me = UserStore.getCurrentUser();
    if (!channel || !me) return null;

    const msgs = MessageStore.getMessages(channelId);
    const all: Message[] = msgs?._array ?? [];
    const messages = all
        .filter(m => SHOWN_TYPES.has(m.type) && !m.blocked)
        .slice(-HISTORY_LIMIT)
        .map(m => toChatMessage(m, channel, me.id));

    const head = describe(channel);
    return {
        channelId,
        ...head,
        placeholder: placeholderFor(channel, head.title),
        messages,
        loading: !msgs?.ready && !messages.length,
    };
}
