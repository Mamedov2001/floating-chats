// Main-процесс Discord. Vencord импортирует этот модуль при старте Discord (даже если плагин выключен)
// и регистрирует КАЖДЫЙ экспорт как IPC-обработчик — поэтому экспортируем только функции,
// а окно создаём лишь по вызову initOverlay() из renderer.

import { createHash } from "crypto";
import { app, BrowserWindow, ipcMain, IpcMainEvent, IpcMainInvokeEvent, screen } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import overlayCss from "file://overlay/overlay.css";
import overlayJs from "file://overlay/overlay.js?minify";
import preloadJs from "file://overlay/preload.js";

import type { ChatTile, OverlayAction, OverlayEvent, OverlayState } from "./types";

const UPDATE_CHANNEL = "floating-chats:update";
const ACTION_CHANNEL = "floating-chats:action";

/** Отступ плиток от правого и верхнего края рабочей области (без панели задач). */
const MARGIN_RIGHT = 16;
const MARGIN_TOP = 12;
/** Должен совпадать с --pad в overlay.css: прозрачный запас вокруг плиток внутри окна. */
const PAD = 6;
const MAX_SIZE = 2000;
const MAX_QUEUE = 100;

let win: BrowserWindow | null = null;
let state: OverlayState = { tiles: [], activeChannelId: null };
let contentSize: { width: number; height: number; } | null = null;

let queue: OverlayEvent[] = [];
let waiter: ((ev: OverlayEvent | null) => void) | null = null;

const log = (...args: unknown[]) => console.log("[FloatingChats]", ...args);

function cspHash(source: string) {
    return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

function buildHtml() {
    // Скрипт и стиль разрешены только по хешу — никакой другой код в окне выполниться не может.
    const csp = [
        "default-src 'none'",
        "img-src https://cdn.discordapp.com",
        `style-src ${cspHash(overlayCss)}`,
        `script-src ${cspHash(overlayJs)}`,
    ].join("; ");

    return "<!doctype html><html><head><meta charset=\"utf-8\">"
        + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
        + `<style>${overlayCss}</style></head>`
        + "<body><div id=\"root\"><div id=\"tiles\"></div></div>"
        + `<script>${overlayJs}</script></body></html>`;
}

function writePreload() {
    // Preload должен быть файлом на диске; кладём его в userData Discord при каждом старте.
    const dir = join(app.getPath("userData"), "floatingChats");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "preload.js");
    writeFileSync(path, preloadJs);
    return path;
}

function alive(w: BrowserWindow | null): w is BrowserWindow {
    return !!w && !w.isDestroyed();
}

function applyBounds() {
    if (!alive(win) || !contentSize) return;

    const wa = screen.getPrimaryDisplay().workArea;
    win.setBounds({
        x: Math.round(wa.x + wa.width - MARGIN_RIGHT + PAD - contentSize.width),
        y: Math.round(wa.y + MARGIN_TOP - PAD),
        width: contentSize.width,
        height: contentSize.height,
    });
}

function updateVisibility() {
    if (!alive(win)) return;

    if (!state.tiles.length) {
        win.hide();
    } else if (contentSize && !win.isVisible()) {
        // showInactive — показать, не забирая фокус у текущего окна (браузера, IDE).
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
    }
}

function pushState() {
    if (alive(win) && !win.webContents.isLoading())
        win.webContents.send(UPDATE_CHANNEL, state);
    updateVisibility();
}

function pushEvent(ev: OverlayEvent) {
    if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(ev);
    } else {
        queue.push(ev);
        if (queue.length > MAX_QUEUE) queue.shift();
    }
}

function onAction(e: IpcMainEvent, action: OverlayAction) {
    if (!alive(win) || e.sender !== win.webContents || !action || typeof action !== "object") return;

    switch (action.type) {
        case "layout": {
            const { width, height } = action;
            if (!Number.isFinite(width) || !Number.isFinite(height)) return;
            contentSize = {
                width: Math.min(Math.max(Math.ceil(width), 1), MAX_SIZE),
                height: Math.min(Math.max(Math.ceil(height), 1), MAX_SIZE),
            };
            applyBounds();
            updateVisibility();
            break;
        }
        case "tileClick":
            if (typeof action.channelId === "string") pushEvent({ type: "tileClick", channelId: action.channelId });
            break;
    }
}

function createWindow() {
    // ВАЖНО: не задавать title. Vencord патчит BrowserWindow и внедряет себя в любое окно,
    // у которого есть и preload, и title (так он находит окно Discord).
    const w = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // На Windows "toolbar" = WS_EX_TOOLWINDOW: окна нет ни в панели задач, ни в Alt+Tab.
        type: "toolbar",
        alwaysOnTop: true,
        focusable: true,
        webPreferences: {
            preload: writePreload(),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });

    w.setAlwaysOnTop(true, "screen-saver");
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", e => e.preventDefault());
    w.webContents.on("did-finish-load", pushState);
    w.on("closed", () => {
        if (win === w) {
            win = null;
            contentSize = null;
        }
    });

    w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(buildHtml()));
    return w;
}

const displayEvents = ["display-metrics-changed", "display-added", "display-removed"] as const;

export function initOverlay(_e: IpcMainInvokeEvent) {
    if (alive(win)) {
        // Renderer перезагрузился (Ctrl+R), а окно осталось — просто переотправим состояние.
        pushState();
        return;
    }

    ipcMain.removeListener(ACTION_CHANNEL, onAction);
    ipcMain.on(ACTION_CHANNEL, onAction);
    for (const ev of displayEvents) {
        screen.removeListener(ev as any, applyBounds);
        screen.on(ev as any, applyBounds);
    }

    win = createWindow();
    log("overlay created");
}

export function setOverlayState(_e: IpcMainInvokeEvent, tiles: ChatTile[], activeChannelId: string | null) {
    state = { tiles: Array.isArray(tiles) ? tiles : [], activeChannelId };
    pushState();
}

/** Long-poll: renderer ждёт здесь следующее событие из оверлея. null — «прекрати опрос». */
export function nextEvent(_e: IpcMainInvokeEvent): Promise<OverlayEvent | null> {
    if (queue.length) return Promise.resolve(queue.shift()!);

    // Предыдущий ожидающий (например, renderer до Ctrl+R) больше не нужен.
    waiter?.(null);
    return new Promise(resolve => { waiter = resolve; });
}

export function disposeOverlay(_e: IpcMainInvokeEvent) {
    ipcMain.removeListener(ACTION_CHANNEL, onAction);
    for (const ev of displayEvents) screen.removeListener(ev as any, applyBounds);

    if (alive(win)) win.destroy();
    win = null;
    contentSize = null;
    state = { tiles: [], activeChannelId: null };

    queue = [];
    waiter?.(null);
    waiter = null;
    log("overlay disposed");
}
