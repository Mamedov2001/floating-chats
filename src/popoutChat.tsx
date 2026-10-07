/*
 * FloatingChats — floating Discord chat tiles for Vencord
 * Copyright (c) 2026 Mamedov2001
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Чат канала — настоящий интерфейс Discord в его же попауте (окне, которое Discord открывает для звонков,
// саундборда и т.п.). Компоненты Discord ищутся по устойчивым строкам кода, а не по номерам модулей.
//
// Как устроено у Discord (сверено по исходникам клиента):
//  - PopoutActions.open(key, render, features) открывает window.open и рендерит render(key) в #app-mount попаута
//    в ТОМ ЖЕ JS-контексте (сторы общие, стили копируются). Main-процесс Discord пропускает в BrowserWindow
//    только ALLOWED_FEATURES: width/height/left/top, frame, transparent, backgroundColor, skipTaskbar, … ;
//  - PopoutWindow — обёртка всех попаутов (тема, слои, хоткеи); так сделан попаут саундборда:
//    withTitleBar: false + onBlur → закрыть;
//  - ChannelChat — компонент чата канала; для канала, не открытого в основном окне, Discord сам
//    использует chatInputType = ChatInputTypes.SIDEBAR. Историю он не грузит — это делает вызывающий.

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { filters, find } from "@webpack";
import { ChannelRouter, ChannelStore, GuildStore, MessageActions, MessageStore, PopoutActions, PopoutWindowStore, React, useStateFromStores } from "@webpack/common";

import { describe } from "./chats";
import { POPOUT_KEY } from "./constants";
import { placeBeside } from "./placement";
import { settings } from "./settings";

const logger = new Logger("FloatingChats");
const Native = VencordNative.pluginHelpers.FloatingChats as PluginNative<typeof import("./native")>;

// ---------- Внутренние части Discord ----------
//
// Ищутся по устойчивым строкам кода. После обновления Discord что-то может не найтись — тогда чат
// открывается в основном окне Discord, а пользователь один раз за сессию получает уведомление.

interface DiscordParts {
    PopoutWindow: React.ComponentType<any>;
    ChannelChat: React.ComponentType<any>;
    /** ChatInputTypes.SIDEBAR — режим ввода для канала, не открытого в основном окне. */
    sidebarInputType: unknown;
    /** CSS-класс обёртки чата в боковой панели; не критичен (есть инлайн-стили). */
    chatClassName: string;
}

let parts: DiscordParts | null = null;
let missingReported = false;

/** Найти нужные части Discord (один раз). Возвращает список того, что найти не удалось. */
export function resolveDiscordParts(): string[] {
    if (parts) return [];

    const PopoutWindow = find(filters.componentByCode("Missing guestWindow reference"), { isIndirect: true });
    const ChannelChat = find(filters.componentByCode('location:"ChannelChat"'), { isIndirect: true });
    const inputTypes = find(m => m?.SIDEBAR?.analyticsName === "sidebar", { isIndirect: true });
    // Модуль, экспортирующий единственный класс chat_<hash>, — обёртка чата в боковой панели.
    const chatCss = find(m => {
        if (!m || typeof m !== "object") return false;
        const values = Object.values(m);
        return values.length === 1 && typeof values[0] === "string" && /^chat_[0-9a-f]+$/.test(values[0]);
    }, { isIndirect: true, topLevelOnly: true });

    let popoutOpen: unknown;
    try { popoutOpen = PopoutActions.open; } catch { }

    const missing: string[] = [];
    if (!PopoutWindow) missing.push("PopoutWindow");
    if (!ChannelChat) missing.push("ChannelChat");
    if (!inputTypes) missing.push("ChatInputTypes.SIDEBAR");
    if (typeof popoutOpen !== "function") missing.push("PopoutActions.open");
    if (missing.length) return missing;

    if (!chatCss) logger.warn("Sidebar chat CSS class not found — the chat may look slightly off");
    parts = {
        PopoutWindow,
        ChannelChat,
        sidebarInputType: inputTypes.SIDEBAR,
        chatClassName: chatCss ? Object.values(chatCss)[0] as string : "",
    };
    return [];
}

function reportMissing(missing: string[]) {
    logger.error(`Discord internals not found: ${missing.join(", ")}. Discord was probably updated — `
        + "chats will open in the main Discord window until the plugin is updated.");
    if (missingReported) return;
    missingReported = true;
    showNotification({
        title: "FloatingChats",
        body: "Discord was updated and the floating chat window can't be shown. "
            + "Chats will open in the main Discord window until the plugin is updated.",
    });
}

/** Чат упал при отрисовке — вместо пустого окна сообщение и выход в основное окно Discord. */
function ChatCrashed({ channelId }: { channelId: string; }) {
    return (
        <div className="fc-crashed">
            <div>This chat can't be shown here.</div>
            <button className="fc-crashed-button" onClick={() => openInDiscord(channelId)}>Open in Discord</button>
        </div>
    );
}

const WIDTH = 400;
const HEIGHT = 640;
const GAP = 8;
/** Клик по плитке тоже уводит фокус из попаута — даём событию плитки шанс отменить закрытие. */
const BLUR_CLOSE_DELAY = 250;
const POSITION_KEY = "FloatingChats_popoutPosition";
const STYLE_ID = "floating-chats-popout-style";

const HISTORY_LIMIT = 50;
/** Каналы, для которых уже запрошена история (чтобы не дёргать API на каждое открытие). */
const historyRequested = new Set<string>();

export function resetHistoryRequests() {
    historyRequested.clear();
}

/** ChannelChat историю сам не грузит (это делает экран, который его показывает) — подгружаем, если её нет. */
function ensureHistory(channelId: string) {
    if (MessageStore.getMessages(channelId)?.ready || historyRequested.has(channelId)) return;
    historyRequested.add(channelId);

    if (typeof MessageActions?.fetchMessages !== "function") {
        logger.warn("MessageActions.fetchMessages not found — chat history will not be loaded");
        return;
    }
    try {
        MessageActions.fetchMessages({ channelId, limit: HISTORY_LIMIT });
    } catch (e) {
        logger.error("Failed to load chat history", channelId, e);
    }
}

let switchChannel: ((channelId: string) => void) | null = null;
let onClosed: (() => void) | null = null;
let isOpen = false;
let blurTimer: ReturnType<typeof setTimeout> | undefined;

function popoutWindow(): Window | undefined {
    const w = PopoutWindowStore?.getWindow(POPOUT_KEY);
    return w && !w.closed ? w : undefined;
}

export function closeChatPopout() {
    clearTimeout(blurTimer);
    if (!isOpen) return;
    isOpen = false;
    switchChannel = null;
    PopoutActions.close(POPOUT_KEY);
    onClosed?.();
}

export async function resetPopoutPosition() {
    await DataStore.del(POSITION_KEY);
}

function popoutCss(baseColor: string, opacity: number) {
    return `
html, body { background: transparent !important; }
#app-mount {
    height: 100vh;
    border-radius: 12px;
    overflow: hidden;
    background: color-mix(in srgb, ${baseColor} ${opacity}%, transparent) !important;
}
/* Фоны чата Discord берутся из этих переменных — обнуляем, фон даёт #app-mount (полупрозрачный). */
#app-mount, #app-mount * {
    --background-base-lower: transparent !important;
    --background-base-lowest: transparent !important;
    --background-gradient-chat: transparent !important;
}
.fc-header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 36px;
    padding: 0 6px 0 14px;
    color: var(--header-primary, #f2f3f5);
    font-size: 15px;
    font-weight: 600;
    border-bottom: 1px solid rgb(255 255 255 / 6%);
    cursor: grab;
    touch-action: none;
    user-select: none;
}
.fc-header.fc-dragging { cursor: grabbing; }
.fc-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-button {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--interactive-normal, #b5bac1);
    font-size: 15px;
    cursor: pointer;
}
.fc-button:hover { background: rgb(255 255 255 / 8%); color: var(--interactive-hover, #fff); }
.fc-crashed {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-muted, #949ba4);
    font-size: 14px;
}
.fc-crashed-button {
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    background: var(--brand-500, #5865f2);
    color: #fff;
    font-size: 14px;
    cursor: pointer;
}
`;
}

/** Открыть канал в основном окне Discord и вывести его на передний план (чат в попауте закрывается). */
export function openInDiscord(channelId: string) {
    closeChatPopout();
    ChannelRouter.transitionToChannel(channelId);
    Native.focusDiscord().catch(e => logger.error("Failed to focus the Discord window", e));
}

/** Иконка «открыть во внешнем окне» (стрелка из квадрата). */
function OpenIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 4h6v6" />
            <path d="M20 4l-9 9" />
            <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
    );
}

function PopoutChat({ windowKey, initialChannelId }: { windowKey: string; initialChannelId: string; }) {
    const { PopoutWindow, ChannelChat, sidebarInputType, chatClassName } = parts!;
    const [channelId, setChannelId] = React.useState(initialChannelId);
    React.useEffect(() => {
        switchChannel = setChannelId;
        return () => { if (switchChannel === setChannelId) switchChannel = null; };
    }, []);

    // Свой стиль — в документ попаута (у него свой document; Discord копирует туда только свои <link>).
    // Базовый цвет фона читаем из темы ДО того, как наш стиль обнулит переменную.
    const { popoutOpacity } = settings.use(["popoutOpacity"]);
    const rootRef = React.useRef<HTMLDivElement>(null);
    const baseColor = React.useRef<string | null>(null);
    React.useLayoutEffect(() => {
        const el = rootRef.current;
        const doc = el?.ownerDocument;
        if (!el || !doc) return;
        baseColor.current ??= getComputedStyle(el).getPropertyValue("--background-base-lower").trim() || "#2b2d31";

        let style = doc.getElementById(STYLE_ID);
        if (!style) {
            style = doc.createElement("style");
            style.id = STYLE_ID;
            doc.head.append(style);
        }
        style.textContent = popoutCss(baseColor.current, popoutOpacity);
    }, [popoutOpacity]);

    // В режиме SIDEBAR у Discord отключён автофокус поля ввода — ставим курсор сами (поле появляется не сразу).
    React.useEffect(() => {
        let tries = 0;
        const timer = setInterval(() => {
            const box = rootRef.current?.querySelector<HTMLElement>('[role="textbox"]');
            if (box) box.focus();
            if (box || ++tries >= 20) clearInterval(timer);
        }, 100);
        return () => clearInterval(timer);
    }, [channelId]);

    const channel = useStateFromStores([ChannelStore], () => ChannelStore.getChannel(channelId), [channelId]);
    const guild = useStateFromStores([GuildStore], () => channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null, [channel]);
    const title = channel ? describe(channel).title : "";

    // Перетаскивание за шапку — вручную через main: так окно не уедет за край монитора
    // (системное перетаскивание Windows ограничить нельзя).
    // Флаг — в ref (обработчики видят его сразу), состояние — только для курсора.
    const draggingRef = React.useRef(false);
    const [dragging, setDragging] = React.useState(false);
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
        draggingRef.current = true;
        setDragging(true);
        Native.popoutDragStart(e.screenX, e.screenY);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (draggingRef.current) Native.popoutDragMove(e.screenX, e.screenY);
    };
    const endDrag = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);
        Native.popoutDragEnd().then(pos => {
            if (pos) DataStore.set(POSITION_KEY, pos);
        });
    };

    const onBlur = React.useCallback(() => {
        clearTimeout(blurTimer);
        blurTimer = setTimeout(closeChatPopout, BLUR_CLOSE_DELAY);
    }, []);

    return (
        <PopoutWindow windowKey={windowKey} withTitleBar={false} title={title || "Floating Chats"} onBlur={onBlur}>
            <div
                ref={rootRef}
                className={chatClassName}
                style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
            >
                <div
                    className={dragging ? "fc-header fc-dragging" : "fc-header"}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={endDrag}
                >
                    <span className="fc-title">{title}</span>
                    <button className="fc-button" title="Open in Discord" onClick={() => openInDiscord(channelId)}>
                        <OpenIcon />
                    </button>
                    <button className="fc-button" title="Close" onClick={closeChatPopout}>✕</button>
                </div>
                {channel && (
                    <ErrorBoundary key={channelId} fallback={() => <ChatCrashed channelId={channelId} />}>
                        <ChannelChat channel={channel} guild={guild} chatInputType={sidebarInputType} />
                    </ErrorBoundary>
                )}
            </div>
        </PopoutWindow>
    );
}

/** Куда поставить попаут: туда, куда его перетащили в прошлый раз, иначе рядом с виджетом плиток. */
async function popoutPosition() {
    const saved = await DataStore.get<{ x: number; y: number; }>(POSITION_KEY);
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        // Мониторы могли смениться — сохранённое место подвинуть в пределы экрана.
        return await Native.clampRect(saved.x, saved.y, WIDTH, HEIGHT) ?? saved;
    }

    const widget = await Native.getWidgetBounds();
    if (!widget) {
        const scr = window.screen as Screen & { availLeft: number; availTop: number; };
        return { x: scr.availLeft + scr.availWidth - 16 - WIDTH, y: scr.availTop + 84 };
    }

    // bounds — прямоугольник самих плиток. Сторона — как у карточки при наведении: вертикально слева
    // (не помещается — справа), горизонтально снизу (не помещается — сверху).
    const { bounds, workArea } = widget;
    return placeBeside(bounds, { width: WIDTH, height: HEIGHT }, workArea, settings.store.orientation === "vertical", GAP);
}

/**
 * Открыть (или переключить) попаут с чатом канала. onClose — когда окно закрылось.
 * Возвращает false, если попаут показать нельзя (части Discord не найдены) — тогда чат открыт в Discord.
 */
export async function openChatPopout(channelId: string, onClose: () => void): Promise<boolean> {
    const missing = resolveDiscordParts();
    if (missing.length) {
        reportMissing(missing);
        openInDiscord(channelId);
        return false;
    }

    clearTimeout(blurTimer);
    onClosed = onClose;
    ensureHistory(channelId);

    if (isOpen && switchChannel) {
        switchChannel(channelId);
        // Фокус ушёл на виджет при клике — вернуть его попауту, чтобы клик мимо снова его закрывал.
        popoutWindow()?.focus();
        return true;
    }

    isOpen = true;
    const { x, y } = await popoutPosition();

    PopoutActions.open(
        POPOUT_KEY,
        key => <PopoutChat windowKey={key} initialChannelId={channelId} />,
        {
            width: WIDTH, height: HEIGHT, left: x, top: y,
            defaultAlwaysOnTop: true,
            transparent: true,
            backgroundColor: "#00000000",
            hasShadow: false,
            resizable: false,
            skipTaskbar: true,
        }
    );
    return true;
}
