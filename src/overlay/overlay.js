// Логика окна оверлея. Без фреймворков; любой текст из Discord — только через textContent.
(() => {
    const api = window.floatingChats;
    const root = document.getElementById("root");
    const tilesEl = document.getElementById("tiles");

    const TILE_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];
    const AVATAR_ORIGIN = "https://cdn.discordapp.com/";

    let state = { orientation: "horizontal", showLabels: true, showWhenEmpty: true, tiles: [], activeChannelId: null };

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

    // ---------- Плитки ----------

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
            hideHoverCard();
            openMenu(channelId, item);
        });
        item.addEventListener("mouseenter", () => showHoverCard(channelId, item));
        item.addEventListener("mouseleave", hideHoverCard);
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

        updateSender(item, tile.events?.at(-1));
    }

    /** Круглый аватар отправителя (значок в углу плитки или в карточке): цветной фон, картинка поверх. */
    function setSenderAvatar(box, from) {
        box.style.background = colorFor(from.userId);
        const url = validAvatar(from.avatarUrl) ? from.avatarUrl : "";
        if (box.dataset.avatar === url) return;
        box.dataset.avatar = url;
        box.replaceChildren();
        if (url) box.append(avatarImg(url));
    }

    function updateSender(item, from) {
        const badge = item.querySelector(".from-badge");
        badge.hidden = !from;
        if (from) setSenderAvatar(badge, from);
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
        if (menuChannel && !seen.has(menuChannel)) closeMenu();
        // Перестановка существующих узлов не перезагружает картинки. Ручка — в дальнем от угла конце.
        tilesEl.replaceChildren(...els, grip);
        if (hoverChannel) refreshHoverCard();
    }

    // Карточка человека и меню — часть #root (а не всплывающий слой): окно виджета на время их показа
    // вырастает под них (вниз или влево от угла привязки), а сами плитки не сдвигаются.
    // Выровнять по плитке: горизонтально — под ней правым краем, вертикально — слева, верхним краем.
    function alignToTile(elem, tileItem) {
        elem.style.marginRight = elem.style.marginTop = "0px";
        const pad = parseFloat(getComputedStyle(root).paddingTop) || 0;
        const r = root.getBoundingClientRect(), t = tileItem.getBoundingClientRect();
        if (state.orientation === "vertical") {
            elem.style.marginTop = `${Math.max(0, t.top - r.top - pad)}px`;
        } else {
            // Не дальше левого края окна: иначе окно расширится влево (сдвиг + перерисовка = скачок).
            const room = r.width - 2 * pad - elem.offsetWidth;
            elem.style.marginRight = `${Math.max(0, Math.min(r.right - pad - t.right, room))}px`;
        }
    }

    // ---------- Карточка человека при наведении ----------

    const hoverCard = el("div", "hover-card");
    hoverCard.hidden = true;
    root.append(hoverCard);
    let hoverChannel = null;
    let hoverItem = null;

    /** Сколько последних событий показывать в карточке; остальное — строкой «+N earlier». */
    const CARD_EVENTS = 6;

    /** Что сделал человек — только факт, без текста сообщений. */
    function eventText(e) {
        const times = e.count > 1 ? ` ×${e.count}` : "";
        switch (e.kind) {
            case "reply": return `replied to you${times}`;
            case "mention": return `mentioned you${times}`;
            case "role": return `mentioned your role${times}`;
            case "everyone": return `mentioned everyone${times}`;
            case "reaction": return `reacted ${e.emoji ?? ""}${times}`.trim();
            case "message": return e.count > 1 ? `sent ${e.count} messages` : "sent a message";
            default: return "";
        }
    }

    function eventTime(at) {
        return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function eventRow(e) {
        const avatar = el("div", "hc-avatar");
        setSenderAvatar(avatar, e);

        const text = el("div", "hc-text");
        const name = el("span", "hc-name", e.name);
        if (e.username && e.username !== e.name) name.title = `@${e.username}`;
        text.append(name, el("span", "hc-action", ` ${eventText(e)}`));

        const row = el("div", "hc-row");
        row.append(avatar, text, el("span", "hc-time", eventTime(e.at)));
        return row;
    }

    function fillHoverCard(tile) {
        // Свежие сверху; подряд идущие одинаковые уже склеены на стороне плагина.
        const events = tile.events;
        const rows = events.slice(-CARD_EVENTS).reverse().map(eventRow);
        if (events.length > CARD_EVENTS) rows.push(el("div", "hc-more", `+${events.length - CARD_EVENTS} earlier`));
        hoverCard.replaceChildren(...rows);
    }

    function showHoverCard(channelId, tileItem) {
        if (!menu.hidden) return;
        const tile = state.tiles.find(t => t.channelId === channelId);
        if (!tile?.events?.length) return;

        hoverChannel = channelId;
        hoverItem = tileItem;
        fillHoverCard(tile);
        hoverCard.hidden = false;
        alignToTile(hoverCard, tileItem);
        // Класс .shown — со следующего кадра, чтобы сработал transition появления.
        requestAnimationFrame(() => {
            if (hoverChannel === channelId) hoverCard.classList.add("shown");
        });
    }

    function hideHoverCard() {
        if (hoverCard.hidden) return;
        hoverCard.hidden = true;
        hoverCard.classList.remove("shown");
        hoverChannel = hoverItem = null;
    }

    /** Состояние обновилось, пока карточка открыта: новые данные, или плитка/отправитель пропали. */
    function refreshHoverCard() {
        const tile = state.tiles.find(t => t.channelId === hoverChannel);
        if (!tile?.events?.length || !hoverItem?.isConnected) {
            hideHoverCard();
            return;
        }
        fillHoverCard(tile);
        alignToTile(hoverCard, hoverItem);
    }

    // ---------- Меню по правому клику ----------

    const menu = el("div", "menu");
    menu.hidden = true;
    root.append(menu);
    let menuChannel = null;

    function menuItem(text, action, { danger = false, disabled = false } = {}) {
        const item = el("div", "menu-item", text);
        if (danger) item.classList.add("danger");
        if (disabled) item.classList.add("disabled");
        else item.addEventListener("click", () => {
            api.send({ type: "tileMenu", channelId: menuChannel, action });
            closeMenu();
        });
        return item;
    }

    function openMenu(channelId, tileItem) {
        const tile = state.tiles.find(t => t.channelId === channelId);
        if (!tile) return;
        menuChannel = channelId;
        menu.replaceChildren(
            menuItem("Mark as read", "markRead", { disabled: !(tile.unread > 0) }),
            menuItem("Open in Discord", "openInDiscord"),
            el("div", "menu-separator"),
            menuItem("Remove from list", "remove", { danger: true }),
        );
        menu.hidden = false;
        alignToTile(menu, tileItem);
    }

    function closeMenu() {
        if (menu.hidden) return;
        menu.hidden = true;
        menuChannel = null;
    }

    // Закрыть: клик мимо меню, Esc, уход фокуса из окна виджета.
    document.addEventListener("pointerdown", e => {
        if (!menu.contains(e.target)) closeMenu();
    }, true);
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") closeMenu();
    });
    window.addEventListener("blur", closeMenu);
    // Курсор ушёл из окна виджета, минуя mouseleave плитки (например, окно сжалось под ним).
    document.documentElement.addEventListener("mouseleave", hideHoverCard);

    // ---------- Размер окна ----------

    // Окно подгоняется под содержимое: сообщаем main размер #root и где внутри него плитки.
    let lastLayout = "";
    const layoutObserver = new ResizeObserver(() => {
        const r = root.getBoundingClientRect(), t = tilesEl.getBoundingClientRect();
        const layout = {
            type: "layout",
            width: Math.ceil(r.width),
            height: Math.ceil(r.height),
            tiles: { x: t.left, y: t.top, width: t.width, height: t.height },
        };
        const key = JSON.stringify(layout);
        if (key === lastLayout) return;
        lastLayout = key;
        api.send(layout);
    });
    layoutObserver.observe(root);
    layoutObserver.observe(tilesEl);

    // ---------- Клики сквозь прозрачные места ----------

    // Окно шире плиток (место под карточку зарезервировано), и прозрачные места не должны мешать
    // кликать по окнам под виджетом. Над ними просим main пропускать клики; движение мыши при этом
    // всё равно приходит (forward), и над плиткой окно снова становится кликабельным.
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
})();
