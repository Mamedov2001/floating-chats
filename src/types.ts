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

/** Состояние, которое main пересылает в оверлей. */
export interface OverlayState {
    tiles: ChatTile[];
    activeChannelId: string | null;
}

/** Действия из оверлея в main (через preload). */
export type OverlayAction =
    | { type: "layout"; width: number; height: number; }
    | { type: "tileClick"; channelId: string; };

/** События из main в renderer Discord (long-poll через nextEvent). */
export type OverlayEvent =
    | { type: "tileClick"; channelId: string; };

export interface MessageCreateEvent {
    channelId: string;
    message: RawMessage;
    optimistic: boolean;
    isPushNotification?: boolean;
}
