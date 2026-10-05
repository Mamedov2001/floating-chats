// ВРЕМЕННО (ветка spike/discord-popout): чат канала — настоящий интерфейс Discord в его же попауте.
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
import { PluginNative } from "@utils/types";
import { findComponentByCodeLazy, findLazy } from "@webpack";
import { ChannelStore, GuildStore, PopoutActions, PopoutWindowStore, React, useStateFromStores } from "@webpack/common";

import { ensureHistory } from "../chatPanel";
import { describe } from "../chats";
import { POPOUT_KEY } from "../constants";
import { settings } from "../settings";

const Native = VencordNative.pluginHelpers.FloatingChats as PluginNative<typeof import("../native")>;

const PopoutWindow = findComponentByCodeLazy("Missing guestWindow reference");
const ChannelChat = findComponentByCodeLazy('location:"ChannelChat"');
const ChatInputTypes = findLazy(m => m?.SIDEBAR?.analyticsName === "sidebar");
/** CSS-класс обёртки чата в боковой панели Discord: модуль, экспортирующий единственный класс chat_<hash>. */
const sidebarChatCss = findLazy(m => {
    if (!m || typeof m !== "object") return false;
    const values = Object.values(m);
    return values.length === 1 && typeof values[0] === "string" && /^chat_[0-9a-f]+$/.test(values[0]);
});

const WIDTH = 400;
const HEIGHT = 640;
const GAP = 8;
/** Клик по плитке тоже уводит фокус из попаута — даём событию плитки шанс отменить закрытие. */
const BLUR_CLOSE_DELAY = 250;
const POSITION_KEY = "FloatingChats_popoutPosition";
const STYLE_ID = "floating-chats-popout-style";

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
    gap: 8px;
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
.fc-close {
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--interactive-normal, #b5bac1);
    font-size: 15px;
    cursor: pointer;
}
.fc-close:hover { background: rgb(255 255 255 / 8%); color: var(--interactive-hover, #fff); }
`;
}

function PopoutChat({ windowKey, initialChannelId }: { windowKey: string; initialChannelId: string; }) {
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
                className={Object.values(sidebarChatCss)[0] as string}
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
                    <button className="fc-close" title="Закрыть" onClick={closeChatPopout}>✕</button>
                </div>
                {channel && <ChannelChat key={channelId} channel={channel} guild={guild} chatInputType={ChatInputTypes.SIDEBAR} />}
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

    const { bounds: b, workArea: wa, pad } = widget;
    let x: number, y: number;
    if (settings.store.orientation === "vertical") {
        // Слева от столбика плиток, верхним краем вровень с первой плиткой.
        x = b.x + pad - GAP - WIDTH;
        y = b.y + pad;
    } else {
        // Под рядом плиток, правым краем вровень с крайней плиткой.
        x = b.x + b.width - pad - WIDTH;
        y = b.y + b.height - pad + GAP;
    }
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - WIDTH);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - HEIGHT);
    return { x: Math.round(x), y: Math.round(y) };
}

/** Открыть (или переключить) попаут с чатом канала. onClose — когда окно закрылось. */
export async function openChatPopout(channelId: string, onClose: () => void) {
    clearTimeout(blurTimer);
    onClosed = onClose;
    ensureHistory(channelId);

    if (isOpen && switchChannel) {
        switchChannel(channelId);
        // Фокус ушёл на виджет при клике — вернуть его попауту, чтобы клик мимо снова его закрывал.
        popoutWindow()?.focus();
        return;
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
}
