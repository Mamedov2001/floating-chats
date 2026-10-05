/** Автор сообщения в сыром виде, как он приходит в Flux-событии MESSAGE_CREATE. */
export interface RawUser {
    id: string;
    username: string;
    global_name?: string | null;
    avatar: string | null;
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
    unread: number;
    lastMessageAt: number;
}

/** Сообщение в панели чата. Весь текст — простой (без разметки), оверлей вставляет его через textContent. */
export interface ChatMessage {
    id: string;
    authorId: string;
    authorName: string;
    avatarUrl?: string;
    initials: string;
    content: string;
    timestamp: number;
    mine: boolean;
    edited: boolean;
    /** Ответ на сообщение: «Имя: начало текста». */
    replyTo?: string;
    /** Вложения, стикеры и т.п. одной строкой каждое. */
    extras: string[];
    /** Своё сообщение ещё отправляется или не отправилось. */
    status?: "sending" | "failed";
}

/** Раскрытая панель чата. */
export interface ChatPanel {
    channelId: string;
    title: string;
    avatarUrl?: string;
    initials: string;
    placeholder: string;
    messages: ChatMessage[];
    loading: boolean;
    /** Ошибка последней отправки из оверлея. */
    error?: string;
    /** Максимальная длина сообщения (2000, с Nitro 4000). */
    maxLength: number;
}

/** Состояние, которое main пересылает в оверлей. */
export type Orientation = "horizontal" | "vertical";

export interface OverlayState {
    orientation: Orientation;
    tiles: ChatTile[];
    activeChannelId: string | null;
    chat: ChatPanel | null;
}

/** Действия из оверлея в main (через preload). */
export type OverlayAction =
    | { type: "layout"; width: number; height: number; }
    | { type: "tileClick"; channelId: string; }
    | { type: "send"; channelId: string; content: string; }
    | { type: "close"; }
    /** Перетаскивание виджета за ручку: экранные координаты курсора. */
    | { type: "dragStart"; x: number; y: number; }
    | { type: "dragMove"; x: number; y: number; }
    | { type: "dragEnd"; };

/** События из main в renderer Discord (long-poll через nextEvent). */
export type OverlayEvent =
    | { type: "tileClick"; channelId: string; }
    | { type: "send"; channelId: string; content: string; }
    /** Свернуть панель: Esc в оверлее или клик мимо (окно потеряло фокус). */
    | { type: "close"; };

/** Flux-событие MESSAGE_REACTION_ADD (поля как их кладёт Discord из гейтвея). */
export interface ReactionAddEvent {
    channelId: string;
    messageId: string;
    userId: string;
    optimistic?: boolean;
    /** Автор сообщения, на которое поставили реакцию (message_author_id из гейтвея). */
    messageAuthorId?: string;
}

export interface MessageCreateEvent {
    channelId: string;
    message: RawMessage;
    optimistic: boolean;
    isPushNotification?: boolean;
}
