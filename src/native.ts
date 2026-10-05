// Main-процесс Discord. Vencord импортирует этот модуль при старте Discord (даже если плагин выключен)
// и регистрирует КАЖДЫЙ экспорт как IPC-обработчик — поэтому экспортируем только функции,
// а окно создаём лишь по вызову initOverlay() из renderer.

import { createHash } from "crypto";
import { app, BrowserWindow, ipcMain, IpcMainEvent, IpcMainInvokeEvent, screen } from "electron";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

import rawOverlayCss from "file://overlay/overlay.css";
import rawOverlayJs from "file://overlay/overlay.js?minify";
import preloadJs from "file://overlay/preload.js";

import type { OverlayAction, OverlayEvent, OverlayState } from "./types";

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
const EMPTY_STATE: OverlayState = { tiles: [], activeChannelId: null, chat: null };
let state: OverlayState = EMPTY_STATE;
let contentSize: { width: number; height: number; } | null = null;

let queue: OverlayEvent[] = [];
let waiter: ((ev: OverlayEvent | null) => void) | null = null;

// HTML-парсер приводит переводы строк в <style>/<script> к \n ДО подсчёта CSP-хеша.
// Если исходник сохранён с CRLF, хеш не совпадёт и стиль/скрипт будут заблокированы — нормализуем.
const lf = (s: string) => s.replace(/\r\n?/g, "\n");
const overlayCss = lf(rawOverlayCss);
const overlayJs = lf(rawOverlayJs);

function dataDir() {
    const dir = join(app.getPath("userData"), "floatingChats");
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Журнал main-процесса: %APPDATA%\discord\floatingChats\main.log (консоль main без отладчика не видна). */
function log(...args: unknown[]) {
    console.log("[FloatingChats]", ...args);
    try {
        const file = join(dataDir(), "main.log");
        try {
            if (statSync(file).size > 1_000_000) writeFileSync(file, "");
        } catch { }
        const text = args.map(a => typeof a === "string" ? a : a instanceof Error ? a.stack : JSON.stringify(a)).join(" ");
        appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`);
    } catch { }
}

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
        + "<body><div id=\"root\"><div id=\"tiles\"></div><div id=\"panel\" hidden></div></div>"
        + `<script>${overlayJs}</script></body></html>`;
}

function writePreload() {
    // Preload должен быть файлом на диске; кладём его в userData Discord при каждом старте.
    const path = join(dataDir(), "preload.js");
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
            log("layout", contentSize, "tiles:", state.tiles.length);
            applyBounds();
            updateVisibility();
            break;
        }
        case "tileClick":
            if (typeof action.channelId === "string") pushEvent({ type: "tileClick", channelId: action.channelId });
            break;
        case "close":
            pushEvent({ type: "close" });
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
    w.webContents.on("did-finish-load", () => {
        log("overlay loaded");
        pushState();
    });
    // Диагностика: всё, что может помешать оверлею запуститься, пишем в main.log.
    w.webContents.on("preload-error", (_e, path, error) => log("preload error", path, error));
    w.webContents.on("did-fail-load", (_e, code, desc) => log("overlay failed to load", code, desc));
    w.webContents.on("render-process-gone", (_e, details) => log("overlay renderer gone", details));
    w.webContents.on("console-message", (e: any, level?: number, message?: string, line?: number) => {
        log("overlay console:", e?.message ?? message, `(level ${e?.level ?? level}, line ${e?.lineNumber ?? line})`);
    });
    // Клик мимо оверлея (в любое другое окно) — свернуть панель чата.
    w.on("blur", () => {
        if (state.chat) pushEvent({ type: "close" });
    });
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

export function setOverlayState(_e: IpcMainInvokeEvent, next: OverlayState) {
    const wasOpen = !!state.chat;
    const prevTiles = state.tiles.length;
    state = {
        tiles: Array.isArray(next?.tiles) ? next.tiles : [],
        activeChannelId: next?.activeChannelId ?? null,
        chat: next?.chat ?? null,
    };
    if (state.tiles.length !== prevTiles || state.chat && !wasOpen)
        log("state: tiles", state.tiles.length, "chat", state.chat?.channelId ?? null, "window", alive(win) ? (win.isVisible() ? "visible" : "hidden") : "none");
    pushState();

    if (!alive(win)) return;
    if (state.chat && !wasOpen) {
        // Панель открыта кликом по плитке — окно должно получить фокус для ввода.
        win.focus();
    } else if (!state.chat && wasOpen && win.isFocused()) {
        // Свернули по Esc — вернуть фокус окну, которое было активно до оверлея.
        win.blur();
    }
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
    state = EMPTY_STATE;

    queue = [];
    waiter?.(null);
    waiter = null;
    log("overlay disposed");
}
