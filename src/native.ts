// Main-процесс Discord. Vencord импортирует этот модуль при старте Discord (даже если плагин выключен)
// и регистрирует КАЖДЫЙ экспорт как IPC-обработчик — поэтому экспортируем только функции,
// а окно создаём лишь по вызову initOverlay() из renderer.

import { createHash } from "crypto";
import { app, BrowserWindow, ipcMain, IpcMainEvent, IpcMainInvokeEvent, screen } from "electron";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

import rawOverlayCss from "file://overlay/overlay.css";
import rawOverlayJs from "file://overlay/overlay.js?minify";
import preloadJs from "file://overlay/preload.js";

import { POPOUT_KEY } from "./constants";
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
const EMPTY_STATE: OverlayState = { orientation: "horizontal", showLabels: true, tiles: [], activeChannelId: null };
let state: OverlayState = EMPTY_STATE;
let contentSize: { width: number; height: number; } | null = null;

/**
 * Точка привязки виджета — правый верхний угол окна в экранных координатах. Окно растёт влево/вниз от неё,
 * поэтому смена числа плиток или раскрытие панели не сдвигают виджет. null — угол рабочей области по умолчанию.
 */
type Anchor = { right: number; top: number; };
let anchor: Anchor | null = null;
let anchorLoaded = false;
/** Текущее перетаскивание: где был курсор и окно в начале. */
let drag: { pointerX: number; pointerY: number; winX: number; winY: number; } | null = null;

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
        + "<body><div id=\"root\"><div id=\"tiles\"></div></div>"
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

const anchorFile = () => join(dataDir(), "position.json");

function loadAnchor() {
    if (anchorLoaded) return;
    anchorLoaded = true;
    try {
        const a = JSON.parse(readFileSync(anchorFile(), "utf8"));
        if (Number.isFinite(a?.right) && Number.isFinite(a?.top)) anchor = { right: a.right, top: a.top };
    } catch { }
}

function saveAnchor() {
    try {
        if (anchor) writeFileSync(anchorFile(), JSON.stringify(anchor));
        else rmSync(anchorFile(), { force: true });
    } catch (e) {
        log("save position failed", e);
    }
}

function defaultAnchor(): Anchor {
    const wa = screen.getPrimaryDisplay().workArea;
    return { right: wa.x + wa.width - MARGIN_RIGHT + PAD, top: wa.y + MARGIN_TOP - PAD };
}

/** Прямоугольник окна для заданного размера: от точки привязки, но целиком в рабочей области её монитора. */
function boundsFor(size: { width: number; height: number; }) {
    const a = anchor ?? defaultAnchor();
    const wa = screen.getDisplayNearestPoint({ x: Math.round(a.right) - 1, y: Math.round(a.top) }).workArea;
    const x = Math.min(Math.max(a.right - size.width, wa.x), wa.x + wa.width - size.width);
    const y = Math.min(Math.max(a.top, wa.y), wa.y + wa.height - size.height);
    return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}

function applyBounds() {
    if (!alive(win) || !contentSize) return;
    win.setBounds(boundsFor(contentSize));
}

/**
 * Позиция прямоугольника w×h, целиком лежащего в рабочей области монитора.
 * Монитор выбирается по точке (по умолчанию — центр прямоугольника; при перетаскивании — курсор),
 * так что окно можно перенести на другой монитор, но не за его край.
 */
function clampToDisplay(x: number, y: number, w: number, h: number, pointX = x + w / 2, pointY = y + h / 2) {
    const wa = screen.getDisplayNearestPoint({ x: Math.round(pointX), y: Math.round(pointY) }).workArea;
    return {
        x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - w)),
        y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - h)),
    };
}

/** Виджет перетащили за ручку — запомнить новую точку привязки. */
function onMoved() {
    if (!alive(win)) return;
    const b = win.getBounds();
    anchor = { right: b.x + b.width, top: b.y };
    saveAnchor();
    log("widget moved", anchor);
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
        case "dragStart": {
            if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) return;
            const b = win.getBounds();
            drag = { pointerX: action.x, pointerY: action.y, winX: b.x, winY: b.y };
            break;
        }
        case "dragMove": {
            if (!drag || !Number.isFinite(action.x) || !Number.isFinite(action.y)) return;
            const { width, height } = win.getBounds();
            const p = clampToDisplay(drag.winX + action.x - drag.pointerX, drag.winY + action.y - drag.pointerY, width, height, action.x, action.y);
            win.setPosition(p.x, p.y);
            break;
        }
        case "dragEnd":
            if (!drag) return;
            drag = null;
            onMoved();
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

    loadAnchor();
    win = createWindow();
    log("overlay created");
}

export function setOverlayState(_e: IpcMainInvokeEvent, next: OverlayState) {
    const prevTiles = state.tiles.length;
    state = {
        orientation: next?.orientation === "vertical" ? "vertical" : "horizontal",
        showLabels: next?.showLabels !== false,
        tiles: Array.isArray(next?.tiles) ? next.tiles : [],
        activeChannelId: next?.activeChannelId ?? null,
    };
    if (state.tiles.length !== prevTiles)
        log("state: tiles", state.tiles.length, "window", alive(win) ? (win.isVisible() ? "visible" : "hidden") : "none");
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
    state = EMPTY_STATE;

    queue = [];
    waiter?.(null);
    waiter = null;
    log("overlay disposed");
}

/** Где сейчас виджет и рабочая область его монитора — чтобы renderer поставил попаут чата рядом. */
export function getWidgetBounds(_e: IpcMainInvokeEvent) {
    if (!alive(win) || !win.isVisible()) return null;
    const bounds = win.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    return { bounds, workArea, pad: PAD };
}

export function resetWidgetPosition(_e: IpcMainInvokeEvent) {
    anchor = null;
    saveAnchor();
    applyBounds();
    log("widget position reset");
}

// ---------- Окно чата (попаут Discord) ----------

function popoutWindow() {
    return BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && (w as any).windowKey === POPOUT_KEY);
}

/** Подвинуть точку так, чтобы прямоугольник целиком был на мониторе (для сохранённой позиции чата). */
export function clampRect(_e: IpcMainInvokeEvent, x: number, y: number, width: number, height: number) {
    if (![x, y, width, height].every(Number.isFinite)) return null;
    return clampToDisplay(x, y, width, height);
}

let popoutDrag: { pointerX: number; pointerY: number; winX: number; winY: number; } | null = null;

export function popoutDragStart(_e: IpcMainInvokeEvent, x: number, y: number) {
    const w = popoutWindow();
    if (!w || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const b = w.getBounds();
    popoutDrag = { pointerX: x, pointerY: y, winX: b.x, winY: b.y };
}

export function popoutDragMove(_e: IpcMainInvokeEvent, x: number, y: number) {
    const w = popoutWindow();
    if (!w || !popoutDrag || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const { width, height } = w.getBounds();
    const p = clampToDisplay(popoutDrag.winX + x - popoutDrag.pointerX, popoutDrag.winY + y - popoutDrag.pointerY, width, height, x, y);
    w.setPosition(p.x, p.y);
}

/** Конец перетаскивания чата; возвращает итоговую позицию, чтобы renderer её запомнил. */
export function popoutDragEnd(_e: IpcMainInvokeEvent) {
    popoutDrag = null;
    const w = popoutWindow();
    if (!w) return null;
    const { x, y } = w.getBounds();
    return { x, y };
}
