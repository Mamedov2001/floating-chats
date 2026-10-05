// Логика окна оверлея. Без фреймворков; любой текст из Discord — только через textContent.
(() => {
    const api = window.floatingChats;
    const root = document.getElementById("root");
    const tilesEl = document.getElementById("tiles");
    const panel = document.getElementById("panel");

    const TILE_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];
    const AVATAR_ORIGIN = "https://cdn.discordapp.com/";
    const GROUP_GAP_MS = 7 * 60 * 1000;
    const PANEL_ANIM_MS = 160;

    let state = { tiles: [], activeChannelId: null, chat: null };

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

    function makeAvatar(className, url, initials, colorKey) {
        const box = el("div", "avatar " + className);
        const ini = el("div", "initials", initials);
        ini.style.background = colorFor(colorKey);
        box.append(ini);
        if (validAvatar(url)) box.append(avatarImg(url));
        return box;
    }

    // ---------- Плитки ----------

    // Плитки живут между обновлениями: пересоздание заставляло бы картинки грузиться заново и мигать.
    const tileEls = new Map();

    function setTileAvatar(tileEl, tile) {
        const url = validAvatar(tile.avatarUrl) ? tile.avatarUrl : null;
        if (tileEl.dataset.avatar === (url ?? "")) return;
        tileEl.dataset.avatar = url ?? "";

        tileEl.querySelector("img")?.remove();
        if (url) tileEl.querySelector(".initials").after(avatarImg(url));
    }

    function createTile(channelId) {
        const tileEl = el("div", "tile");
        const initials = el("div", "initials");
        initials.style.background = colorFor(channelId);
        tileEl.append(initials, el("div", "badge"));
        tileEl.addEventListener("click", () => api.send({ type: "tileClick", channelId }));
        return tileEl;
    }

    function updateTile(tileEl, tile) {
        tileEl.title = tile.title;
        tileEl.classList.toggle("active", tile.channelId === state.activeChannelId);
        tileEl.querySelector(".initials").textContent = tile.initials;
        setTileAvatar(tileEl, tile);

        const badge = tileEl.querySelector(".badge");
        badge.hidden = !(tile.unread > 0);
        badge.textContent = tile.unread > 99 ? "99+" : String(tile.unread);
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
        // Перестановка существующих узлов не перезагружает картинки.
        tilesEl.replaceChildren(...els);
    }

    // ---------- Панель чата ----------

    const header = el("div", "header");
    const headerTitle = el("div", "head-title");
    const messagesEl = el("div", "messages");
    const composer = el("div", "composer");
    const input = el("textarea", "input");
    input.rows = 1;
    input.spellcheck = true;
    composer.append(input);
    panel.append(header, messagesEl, composer);

    /** Черновики по каналам, чтобы не терять набранное при переключении/сворачивании. */
    const drafts = new Map();
    let panelOpen = false;
    let currentChannel = null;
    let closeTimer = 0;

    function autosizeInput() {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 140) + "px";
    }

    input.addEventListener("input", () => {
        if (currentChannel) drafts.set(currentChannel, input.value);
        autosizeInput();
    });

    function formatTime(ts) {
        const d = new Date(ts);
        const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return time;
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return `вчера ${time}`;
        return `${d.toLocaleDateString("ru-RU")} ${time}`;
    }

    function makeGroup(m) {
        const group = el("div", "msg-group");
        if (m.replyTo) group.append(el("div", "reply", "↪ " + m.replyTo));

        const body = el("div", "msg-body");
        const meta = el("div", "meta");
        meta.append(el("span", m.mine ? "name mine" : "name", m.authorName), el("span", "time", formatTime(m.timestamp)));
        body.append(meta);

        group.append(makeAvatar("msg-avatar", m.avatarUrl, m.initials, m.authorId), body);
        return { group, body };
    }

    function makeLine(m) {
        const line = el("div", "line");
        if (m.content) {
            line.append(el("span", "text", m.content));
            if (m.edited) line.append(el("span", "edited", "(изменено)"));
        }
        for (const extra of m.extras) line.append(el("div", "extra", extra));
        return line;
    }

    function renderMessages(chat, channelChanged) {
        const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
        const nodes = [];

        if (chat.loading) nodes.push(el("div", "hint", "Загрузка…"));
        else if (!chat.messages.length) nodes.push(el("div", "hint", "Сообщений пока нет"));

        let prev = null, current = null;
        for (const m of chat.messages) {
            const newGroup = !prev
                || prev.authorId !== m.authorId
                || m.timestamp - prev.timestamp > GROUP_GAP_MS
                || new Date(prev.timestamp).toDateString() !== new Date(m.timestamp).toDateString()
                || !!m.replyTo;
            if (newGroup) {
                current = makeGroup(m);
                nodes.push(current.group);
            }
            current.body.append(makeLine(m));
            prev = m;
        }

        messagesEl.replaceChildren(...nodes);
        // Автопрокрутка вниз: при открытии чата и если пользователь и так был внизу.
        if (channelChanged || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderHeader(chat) {
        header.replaceChildren(makeAvatar("head-avatar", chat.avatarUrl, chat.initials, chat.channelId), headerTitle);
        headerTitle.textContent = chat.title;
        headerTitle.title = chat.title;
    }

    function openPanel() {
        clearTimeout(closeTimer);
        if (panelOpen) return;
        panelOpen = true;
        panel.hidden = false;
        // Класс .open — со следующего кадра, чтобы сработал CSS transition.
        requestAnimationFrame(() => {
            if (panelOpen) panel.classList.add("open");
        });
    }

    function closePanel() {
        if (!panelOpen) return;
        panelOpen = false;
        panel.classList.remove("open");
        // Скрыть (и тем самым ужать окно) после анимации.
        closeTimer = setTimeout(() => {
            if (!panelOpen) panel.hidden = true;
        }, PANEL_ANIM_MS);
    }

    function renderPanel() {
        const chat = state.chat;
        if (!chat) {
            currentChannel = null;
            closePanel();
            return;
        }

        const channelChanged = chat.channelId !== currentChannel;
        currentChannel = chat.channelId;
        openPanel();

        if (channelChanged) {
            renderHeader(chat);
            input.placeholder = chat.placeholder;
            input.value = drafts.get(chat.channelId) ?? "";
            autosizeInput();
        } else {
            headerTitle.textContent = chat.title;
        }

        renderMessages(chat, channelChanged);
        if (channelChanged) input.focus();
    }

    document.addEventListener("keydown", e => {
        if (e.key === "Escape") {
            e.preventDefault();
            api.send({ type: "close" });
        }
    });

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
        renderTiles();
        renderPanel();
    });
})();
