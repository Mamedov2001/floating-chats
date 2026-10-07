/*
 * FloatingChats — floating Discord chat tiles for Vencord
 * Copyright (c) 2026 Mamedov2001
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Логика окон оверлея. Без фреймворков; любой текст из Discord — только через textContent.
//
// Один скрипт на два окна (режим — <body data-mode>):
//  - "widget" — плитки, ручка, заглушка;
//  - "popup"  — всплывающее окно рядом с плиткой: карточка «кто был активен» или меню по правому клику.
//    Его ставит main и сам выбирает сторону (слева/справа, снизу/сверху), чтобы окно плиток
//    не меняло размер при наведении и могло стоять у любого края экрана.
(() => {
    const api = window.floatingChats;
    const root = document.getElementById("root");

    const TILE_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];
    const AVATAR_ORIGIN = "https://cdn.discordapp.com/";

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function colorFor(id) {
        let h = 0;
        for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return TILE_COLORS[Math.abs(h) % TILE_COLORS.length];
    }

    // ---------- Аватары ----------

    // Не загрузившиеся (404 и т.п.) больше не запрашиваем; загруженные показываем сразу, без мигания.
    const failedAvatars = new Set();
    const loadedAvatars = new Set();

    function validAvatar(url) {
        return typeof url === "string" && url.startsWith(AVATAR_ORIGIN) && !failedAvatars.has(url);
    }

    /** Картинка поверх инициалов. Пока не загрузилась — скрыта (.loaded нет), видны инициалы. */
    function avatarImg(url) {
        const img = el("img");
        img.alt = "";
        img.draggable = false;
        if (loadedAvatars.has(url)) img.classList.add("loaded");
        img.addEventListener("load", () => {
            loadedAvatars.add(url);
            img.classList.add("loaded");
        }, { once: true });
        img.addEventListener("error", () => {
            failedAvatars.add(url);
            img.remove();
        }, { once: true });
        img.src = url;
        return img;
    }

    /** Круглый аватар человека (значок в углу плитки или строка карточки): цветной фон, картинка поверх. */
    function setPersonAvatar(box, person) {
        box.style.background = colorFor(person.userId);
        const url = validAvatar(person.avatarUrl) ? person.avatarUrl : "";
        if (box.dataset.avatar === url) return;
        box.dataset.avatar = url;
        box.replaceChildren();
        if (url) box.append(avatarImg(url));
    }

    /** Сообщить main размер содержимого (окно подгоняется под него). */
    function reportSize(type, extra) {
        let last = "";
        new ResizeObserver(() => {
            const r = root.getBoundingClientRect();
            const msg = { type, width: Math.ceil(r.width), height: Math.ceil(r.height), ...extra?.() };
            const key = JSON.stringify(msg);
            if (key === last) return;
            last = key;
            api.send(msg);
        }).observe(root);
    }

    if (document.body.dataset.mode === "popup") initPopup();
    else initWidget();

    // ======================================================================
    // Всплывающее окно: карточка или меню
    // ======================================================================

    function initPopup() {
        /** Сколько человек показывать в карточке; остальные — строкой «+N more». */
        const CARD_PEOPLE = 6;

        function eventTime(at) {
            return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }

        /** Кто что-то сделал в чате — каждый один раз, со временем последнего действия, свежие первыми. */
        function peopleOf(events) {
            const byUser = new Map();
            for (const e of events) {
                const prev = byUser.get(e.userId);
                if (!prev || e.at >= prev.at) byUser.set(e.userId, e);
            }
            return [...byUser.values()].sort((a, b) => b.at - a.at);
        }

        /** Строка: аватар, имя, время. Само действие не показываем — только факт, что оно было. */
        function personRow(e) {
            const avatar = el("div", "hc-avatar");
            setPersonAvatar(avatar, e);

            const name = el("div", "hc-name", e.name);
            if (e.username && e.username !== e.name) name.title = `@${e.username}`;

            const row = el("div", "hc-row");
            row.append(avatar, name, el("span", "hc-time", eventTime(e.at)));
            return row;
        }

        function buildCard(tile) {
            const card = el("div", "hover-card");
            const people = peopleOf(tile.events ?? []);
            card.append(...people.slice(0, CARD_PEOPLE).map(personRow));
            if (people.length > CARD_PEOPLE) card.append(el("div", "hc-more", `+${people.length - CARD_PEOPLE} more`));
            return card;
        }

        function menuItem(channelId, text, action, { danger = false, disabled = false } = {}) {
            const item = el("div", "menu-item", text);
            if (danger) item.classList.add("danger");
            if (disabled) item.classList.add("disabled");
            else item.addEventListener("click", () => api.send({ type: "tileMenu", channelId, action }));
            return item;
        }

        function buildMenu(tile) {
            const menu = el("div", "menu");
            menu.append(
                menuItem(tile.channelId, "Mark as read", "markRead", { disabled: !(tile.unread > 0) }),
                menuItem(tile.channelId, "Open in Discord", "openInDiscord"),
                el("div", "menu-separator"),
                menuItem(tile.channelId, "Remove from list", "remove", { danger: true }),
            );
            return menu;
        }

        api.onUpdate(popup => {
            if (!popup?.tile) {
                root.replaceChildren();
                return;
            }
            const node = popup.mode === "menu" ? buildMenu(popup.tile) : buildCard(popup.tile);
            root.replaceChildren(node);
            // Размер — сразу и после каждой отрисовки (даже прежний): main по нему ставит окно к новой плитке.
            // Не в requestAnimationFrame: окно ещё скрыто, а в скрытом окне rAF не вызывается —
            // окно ждало бы размер, чтобы показаться, а размер — показа окна.
            const r = root.getBoundingClientRect();
            api.send({ type: "popupLayout", width: Math.ceil(r.width), height: Math.ceil(r.height) });
            // Класс .shown — со следующего кадра (когда окно уже видно), чтобы сработал transition появления.
            requestAnimationFrame(() => node.classList.add("shown"));
        });

        document.addEventListener("keydown", e => {
            if (e.key === "Escape") api.send({ type: "popupClose" });
        });
    }

    // ======================================================================
    // Окно плиток
    // ======================================================================

    function initWidget() {
        const tilesEl = document.getElementById("tiles");
        let state = { orientation: "horizontal", showLabels: true, showWhenEmpty: true, tiles: [], activeChannelId: null };

        /** Иконка облачка сообщения для заглушки «нет новых сообщений». */
        function chatIcon() {
            const NS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(NS, "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("width", "24");
            svg.setAttribute("height", "24");
            const path = document.createElementNS(NS, "path");
            path.setAttribute("d", "M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z");
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", "currentColor");
            path.setAttribute("stroke-width", "1.8");
            path.setAttribute("stroke-linejoin", "round");
            svg.append(path);
            return svg;
        }

        // Заглушка на месте плиток, когда чатов нет: видно, где появятся сообщения, и виджет можно передвинуть.
        const placeholder = el("div", "tile-item placeholder");
        placeholder.title = "New messages will appear here";
        {
            const tile = el("div", "tile");
            tile.append(chatIcon());
            const label = el("div", "tile-label");
            label.append(el("span", "label-name", "No new messages"));
            placeholder.append(tile, label);
        }

        /** Иконка ручки: 2×3 точки (inline SVG — это DOM, а не загрузка картинки, CSP не мешает). */
        function gripIcon() {
            const NS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(NS, "svg");
            svg.setAttribute("viewBox", "0 0 10 16");
            svg.setAttribute("width", "10");
            svg.setAttribute("height", "16");
            for (const cx of [2.5, 7.5]) {
                for (const cy of [3, 8, 13]) {
                    const dot = document.createElementNS(NS, "circle");
                    dot.setAttribute("cx", String(cx));
                    dot.setAttribute("cy", String(cy));
                    dot.setAttribute("r", "1.5");
                    dot.setAttribute("fill", "currentColor");
                    svg.append(dot);
                }
            }
            return svg;
        }

        // Плитки живут между обновлениями: пересоздание заставляло бы картинки грузиться заново и мигать.
        const tileEls = new Map();
        // Ручка для перетаскивания виджета. Двигаем окно сами (через main): системный drag-region
        // не работает у неперемещаемого окна и не показывает курсор-руку.
        const grip = el("div", "grip");
        grip.title = "Drag to move";
        grip.append(gripIcon());
        let dragging = false;

        grip.addEventListener("pointerdown", e => {
            if (e.button !== 0) return;
            e.preventDefault();
            // Захват указателя — события идут, даже когда курсор выходит за пределы маленького окна.
            try { grip.setPointerCapture(e.pointerId); } catch { }
            dragging = true;
            grip.classList.add("dragging");
            api.send({ type: "dragStart", x: e.screenX, y: e.screenY });
        });
        grip.addEventListener("pointermove", e => {
            if (dragging) api.send({ type: "dragMove", x: e.screenX, y: e.screenY });
        });
        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            grip.classList.remove("dragging");
            api.send({ type: "dragEnd" });
        };
        grip.addEventListener("pointerup", endDrag);
        grip.addEventListener("pointercancel", endDrag);
        grip.addEventListener("lostpointercapture", endDrag);

        function setTileAvatar(tileEl, tile) {
            const url = validAvatar(tile.avatarUrl) ? tile.avatarUrl : null;
            if (tileEl.dataset.avatar === (url ?? "")) return;
            tileEl.dataset.avatar = url ?? "";

            tileEl.querySelector("img")?.remove();
            if (url) tileEl.querySelector(".initials").after(avatarImg(url));
        }

        /** Прямоугольник элемента плитки в координатах окна — по нему main ставит всплывающее окно. */
        function rectOf(item) {
            const r = item.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        }

        /** Элемент плитки: сама плитка + подпись под ней (имя / #канал и сервер). */
        function createTile(channelId) {
            // entering — анимация появления; снимаем по окончании, иначе она повторялась бы
            // при каждой перестановке узлов (replaceChildren вставляет их заново).
            const item = el("div", "tile-item entering");
            const entered = () => item.classList.remove("entering");
            item.addEventListener("animationend", entered, { once: true });
            // Запасной вариант: в скрытом окне анимации не проигрываются и animationend не приходит.
            setTimeout(entered, 400);
            const tileEl = el("div", "tile");
            const initials = el("div", "initials");
            initials.style.background = colorFor(channelId);
            // Значок отправителя в углу плитки — подсказка, что при наведении можно узнать, кто это.
            tileEl.append(initials, el("div", "badge"), el("div", "from-badge"));

            const label = el("div", "tile-label");
            label.append(el("span", "label-name"), el("span", "label-context"));

            item.append(tileEl, label);
            item.addEventListener("click", () => api.send({ type: "tileClick", channelId }));
            item.addEventListener("contextmenu", e => {
                e.preventDefault();
                api.send({ type: "menu", channelId, rect: rectOf(item) });
            });
            item.addEventListener("mouseenter", () => api.send({ type: "hover", channelId, rect: rectOf(item) }));
            item.addEventListener("mouseleave", () => api.send({ type: "hover", channelId: null }));
            return item;
        }

        function updateTile(item, tile) {
            const tileEl = item.querySelector(".tile");
            item.title = tile.title;
            tileEl.classList.toggle("active", tile.channelId === state.activeChannelId);
            tileEl.querySelector(".initials").textContent = tile.initials;
            setTileAvatar(tileEl, tile);

            const badge = tileEl.querySelector(".badge");
            badge.hidden = !(tile.unread > 0);
            badge.textContent = tile.unread > 99 ? "99+" : String(tile.unread);

            const label = item.querySelector(".tile-label");
            label.hidden = !state.showLabels;
            label.querySelector(".label-name").textContent = tile.name || tile.title;
            const context = label.querySelector(".label-context");
            context.textContent = tile.context ?? "";
            context.hidden = !tile.context;

            const from = tile.events?.at(-1);
            const fromBadge = tileEl.querySelector(".from-badge");
            fromBadge.hidden = !from;
            if (from) setPersonAvatar(fromBadge, from);
        }

        function renderTiles() {
            const seen = new Set();
            const els = state.tiles.map(tile => {
                seen.add(tile.channelId);
                let tileEl = tileEls.get(tile.channelId);
                if (!tileEl) tileEls.set(tile.channelId, tileEl = createTile(tile.channelId));
                updateTile(tileEl, tile);
                return tileEl;
            });
            for (const id of tileEls.keys()) if (!seen.has(id)) tileEls.delete(id);
            if (!els.length && state.showWhenEmpty !== false) {
                placeholder.querySelector(".tile-label").hidden = !state.showLabels;
                els.push(placeholder);
            }
            // Перестановка существующих узлов не перезагружает картинки. Ручка — в дальнем от угла конце.
            tilesEl.replaceChildren(...els, grip);
        }

        // Окно подгоняется под содержимое: сообщаем main размер #root и где внутри него плитки.
        reportSize("layout", () => {
            const t = tilesEl.getBoundingClientRect();
            return { tiles: { x: t.left, y: t.top, width: t.width, height: t.height } };
        });

        // ---------- Клики сквозь прозрачные места ----------

        // Промежутки между плитками и запас вокруг них прозрачны — не должны мешать кликать по окнам
        // под виджетом. Над ними просим main пропускать клики; движение мыши при этом всё равно
        // приходит (forward), и над плиткой окно снова становится кликабельным.
        const TRANSPARENT = new Set([document.documentElement, document.body, root, tilesEl]);
        let passThrough = true;
        function setPassThrough(value) {
            if (value === passThrough) return;
            passThrough = value;
            api.send({ type: "passThrough", value });
        }
        document.addEventListener("mousemove", e => {
            // Пока тащим виджет за ручку, окно должно ловить мышь.
            if (dragging) return;
            setPassThrough(TRANSPARENT.has(e.target));
        });
        document.documentElement.addEventListener("mouseleave", () => {
            if (!dragging) setPassThrough(true);
        });

        api.onUpdate(next => {
            state = next;
            document.body.classList.toggle("vertical", state.orientation === "vertical");
            document.body.classList.toggle("labels", state.showLabels !== false);
            renderTiles();
        });
    }
})();
