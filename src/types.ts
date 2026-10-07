/*
 * FloatingChats — floating Discord chat tiles for Vencord
 * Copyright (c) 2026 Mamedov2001
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Автор сообщения в сыром виде, как он приходит в Flux-событии MESSAGE_CREATE. */
export interface RawUser {
    id: string;
    username: string;
    global_name?: string | null;
    avatar: string | null;
    discriminator?: string;
    bot?: boolean;
}

/** Сообщение из MESSAGE_CREATE — это объект API (snake_case), а не запись Message из MessageStore. */
export interface RawMessage {
    id: string;
    channel_id: string;
    guild_id?: string;
    author: RawUser;
    content: string;
    timestamp: string;
    mentions: RawUser[];
    mention_everyone: boolean;
    mention_roles: string[];
    /** Сообщение, на которое это — ответ (есть у ответов). */
    referenced_message?: { author?: { id: string; }; } | null;
    attachments: unknown[];
    embeds: unknown[];
}

/** Плитка чата в оверлее. Порядок в массиве: первый элемент — самый свежий (рисуется у края экрана). */
export interface ChatTile {
    channelId: string;
    title: string;
    /** URL аватара; допускается только https://cdn.discordapp.com (ограничено CSP оверлея). */
    avatarUrl?: string;
    /** Подпись-заглушка, если аватара нет или он не загрузился. */
    initials: string;
    /** Подпись под плиткой: имя собеседника / название группы / #канал. */
    name: string;
    /** Вторая строка подписи: сервер (для ЛС и групп нет). */
    context?: string;
    /** События с момента последнего прочтения, по времени (старые первыми). В обычных ЛС — только реакции. */
    events?: TileEvent[];
    unread: number;
    lastMessageAt: number;
}

/** Что произошло: тегнули, ответили, тегнули роль/всех, написали в группе, поставили реакцию. */
export type TileEventKind = "mention" | "reply" | "role" | "everyone" | "message" | "reaction";

/** Событие в чате для списка в карточке. Подряд идущие одинаковые склеиваются (count). */
export interface TileEvent {
    userId: string;
    name: string;
    username?: string;
    avatarUrl?: string;
    kind: TileEventKind;
    /** Эмодзи — для реакций. */
    emoji?: string;
    count: number;
    /** Время последнего из склеенных событий, мс. */
    at: number;
}

export type Orientation = "horizontal" | "vertical";

export interface OverlayState {
    orientation: Orientation;
    showLabels: boolean;
    /** Прятать виджет, пока активно основное окно Discord. */
    hideWhenDiscordFocused: boolean;
    /** Без чатов показывать заглушку (чтобы было видно, где появятся сообщения), а не прятать виджет. */
    showWhenEmpty: boolean;
    tiles: ChatTile[];
    /** Чат, открытый сейчас в попауте, — его плитка подсвечена. */
    activeChannelId: string | null;
}

/** Пункты меню по правому клику на плитке. */
export type TileMenuAction = "markRead" | "openInDiscord" | "remove";

/** Действия из оверлея в main (через preload). */
export type OverlayAction =
    /** Размер содержимого и прямоугольник самих плиток (относительно окна) — по нему ставится окно чата. */
    | { type: "layout"; width: number; height: number; tiles?: WindowRect; }
    /** Курсор над прозрачной частью окна — пропускать клики насквозь (движение мыши всё равно приходит). */
    | { type: "passThrough"; value: boolean; }
    /** Наведение на плитку / уход с неё (channelId: null). rect — элемент плитки в координатах окна. */
    | { type: "hover"; channelId: string | null; rect?: WindowRect; }
    /** Правый клик по плитке — показать меню. */
    | { type: "menu"; channelId: string; rect: WindowRect; }
    /** Из всплывающего окна: его размер (main ставит окно рядом с плиткой) и просьба закрыться (Esc). */
    | { type: "popupLayout"; width: number; height: number; }
    | { type: "popupClose"; }
    | { type: "tileClick"; channelId: string; }
    | { type: "tileMenu"; channelId: string; action: TileMenuAction; }
    /** Перетаскивание виджета за ручку: экранные координаты курсора. */
    | { type: "dragStart"; x: number; y: number; }
    | { type: "dragMove"; x: number; y: number; }
    | { type: "dragEnd"; };

export interface WindowRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Что показать во всплывающем окне рядом с плиткой: карточку «кто был активен» или меню. */
export type PopupContent = { mode: "card" | "menu"; tile: ChatTile; } | null;

/** События из main в renderer Discord (long-poll через nextEvent). */
export type OverlayEvent =
    | { type: "tileClick"; channelId: string; }
    | { type: "tileMenu"; channelId: string; action: TileMenuAction; };

/** Flux-событие MESSAGE_REACTION_ADD (поля как их кладёт Discord из гейтвея). */
export interface ReactionAddEvent {
    channelId: string;
    messageId: string;
    userId: string;
    optimistic?: boolean;
    emoji?: { id?: string | null; name?: string | null; };
    /** Автор сообщения, на которое поставили реакцию (message_author_id из гейтвея). */
    messageAuthorId?: string;
}

export interface MessageCreateEvent {
    channelId: string;
    message: RawMessage;
    optimistic: boolean;
    isPushNotification?: boolean;
}
