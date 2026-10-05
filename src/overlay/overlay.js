// Логика окна оверлея. Без фреймворков; любой текст из Discord — только через textContent.
(() => {
    const api = window.floatingChats;
    const root = document.getElementById("root");
    const tilesEl = document.getElementById("tiles");

    const TILE_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];
    const AVATAR_ORIGIN = "https://cdn.discordapp.com/";

    let state = { tiles: [], activeChannelId: null };

    function colorFor(id) {
        let h = 0;
        for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return TILE_COLORS[Math.abs(h) % TILE_COLORS.length];
    }

    // Аватары, которые не загрузились (404 и т.п.): больше не запрашиваем, сразу показываем инициалы.
    const failedAvatars = new Set();
    // Плитки живут между обновлениями: пересоздание заставляло бы картинки грузиться заново и мигать.
    const tileEls = new Map();

    function validAvatar(url) {
        return typeof url === "string" && url.startsWith(AVATAR_ORIGIN) && !failedAvatars.has(url);
    }

    function setAvatar(el, tile) {
        const url = validAvatar(tile.avatarUrl) ? tile.avatarUrl : null;
        if (el.dataset.avatar === (url ?? "")) return;
        el.dataset.avatar = url ?? "";

        el.querySelector("img")?.remove();
        if (!url) return;

        // Пока картинка не загрузилась, она скрыта (.loaded нет) и под ней видны инициалы.
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
        img.addEventListener("error", () => {
            failedAvatars.add(url);
            img.remove();
        }, { once: true });
        img.src = url;
        el.querySelector(".initials").after(img);
    }

    function createTile(channelId) {
        const el = document.createElement("div");
        el.className = "tile";

        const initials = document.createElement("div");
        initials.className = "initials";
        initials.style.background = colorFor(channelId);
        el.append(initials);

        const badge = document.createElement("div");
        badge.className = "badge";
        el.append(badge);

        el.addEventListener("click", () => api.send({ type: "tileClick", channelId }));
        return el;
    }

    function updateTile(el, tile) {
        el.title = tile.title;
        el.classList.toggle("active", tile.channelId === state.activeChannelId);
        el.querySelector(".initials").textContent = tile.initials;
        setAvatar(el, tile);

        const badge = el.querySelector(".badge");
        badge.hidden = !(tile.unread > 0);
        badge.textContent = tile.unread > 99 ? "99+" : String(tile.unread);
    }

    function render() {
        const seen = new Set();
        const els = state.tiles.map(tile => {
            seen.add(tile.channelId);
            let el = tileEls.get(tile.channelId);
            if (!el) tileEls.set(tile.channelId, el = createTile(tile.channelId));
            updateTile(el, tile);
            return el;
        });
        for (const id of tileEls.keys()) if (!seen.has(id)) tileEls.delete(id);
        // Перестановка существующих узлов не перезагружает картинки.
        tilesEl.replaceChildren(...els);
    }

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
        render();
    });
})();
