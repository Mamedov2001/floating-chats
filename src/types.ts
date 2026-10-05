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
    /** Подпись под плиткой: имя собеседника / название группы / #канал. */
    name: string;
    /** Вторая строка подписи: сервер (для ЛС и групп нет). */
    context?: string;
    unread: number;
    lastMessageAt: number;
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
    | { type: "layout"; width: number; height: number; }
    | { type: "tileClick"; channelId: string; }
    | { type: "tileMenu"; channelId: string; action: TileMenuAction; }
    /** Перетаскивание виджета за ручку: экранные координаты курсора. */
    | { type: "dragStart"; x: number; y: number; }
    | { type: "dragMove"; x: number; y: number; }
    | { type: "dragEnd"; };

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
    /** Автор сообщения, на которое поставили реакцию (message_author_id из гейтвея). */
    messageAuthorId?: string;
}

export interface MessageCreateEvent {
    channelId: string;
    message: RawMessage;
    optimistic: boolean;
    isPushNotification?: boolean;
}
