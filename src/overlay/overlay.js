// Логика окна оверлея. Без фреймворков; любой текст из Discord — только через textContent.
(() => {
    const api = window.floatingChats;
    const root = document.getElementById("root");
    const tilesEl = document.getElementById("tiles");

    const TILE_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];
    const AVATAR_ORIGIN = "https://cdn.discordapp.com/";

    let state = { orientation: "horizontal", showLabels: true, tiles: [], activeChannelId: null };

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
    grip.title = "Перетащите, чтобы переместить";
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
        const item = el("div", "tile-item");
        const tileEl = el("div", "tile");
        const initials = el("div", "initials");
        initials.style.background = colorFor(channelId);
        tileEl.append(initials, el("div", "badge"));

        const label = el("div", "tile-label");
        label.append(el("span", "label-name"), el("span", "label-context"));

        item.append(tileEl, label);
        item.addEventListener("click", () => api.send({ type: "tileClick", channelId }));
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
        // Перестановка существующих узлов не перезагружает картинки. Ручка — в дальнем от угла конце.
        tilesEl.replaceChildren(...els, grip);
    }

    // ---------- Размер окна ----------

    // Окно подгоняется под содержимое: сообщаем main реальный размер #root.
    let lastW = 0, lastH = 0;
    new ResizeObserver(() => {
        const r = root.getBoundingClientRect();
        const width = Math.ceil(r.width), height = Math.ceil(r.height);
        if (width === lastW && height === lastH) return;
        lastW = width; lastH = height;
        api.send({ type: "layout", width, height });
    }).observe(root);

    api.onUpdate(next => {
        state = next;
        document.body.classList.toggle("vertical", state.orientation === "vertical");
        document.body.classList.toggle("labels", state.showLabels !== false);
        renderTiles();
    });
})();
