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

export interface MessageCreateEvent {
    channelId: string;
    message: RawMessage;
    optimistic: boolean;
    isPushNotification?: boolean;
}
