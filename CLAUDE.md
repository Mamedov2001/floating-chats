# Floating Chats — плагин Vencord с плавающей панелью чатов

> Этот файл — техническое задание и план работ. Положите его в корень проекта
> (можно переименовать в `CLAUDE.md`, тогда он будет подхватываться автоматически)
> и начните новую сессию фразой: «Прочитай floating-chats-plan.md и начнём с этапа 0».

---

## 1. Цель

Плагин для Discord (клиент Vencord), который показывает **плавающую панель поверх всех окон Windows**
(в том числе поверх свёрнутого Discord, браузера, IDE):

- в правом верхнем углу экрана — горизонтальный ряд плиток-аватарок тех, кто мне написал;
- клик по плитке — под рядом раскрывается окно чата с историей и полем ввода;
- клик в любом другом месте (или Esc) — окно чата сворачивается обратно, остаются только плитки;
- ответ отправляется прямо из панели, без переключения в Discord.

### Макет

```
 Свёрнуто:                                  Раскрыто (клик по плитке «АЛ»):

          ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐                ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐
          │GD│ │АЛ│ │ТИ│ │ОЛ│ │ДА│                │GD│ │АЛ│ │ТИ│ │ОЛ│ │ДА│
          └──┘ └──┘ └──┘ └──┘ └──┘                └──┘ └▔▔┘ └──┘ └──┘ └──┘
                                              ┌──────────────────────────────┐
                                              │ (ав) Алексей    Открыть в DC │
                                              │──────────────────────────────│
                                              │                              │
                                              │ (ав) Алексей 11:55           │
                                              │      Привет! Ты в игре?      │
                                              │ (ав) Вы 11:56                │
                                              │      Да, через 10 минут      │
                                              │ ┌──────────────────────────┐ │
                                              │ │ Написать @Алексей        │ │
                                              │ └──────────────────────────┘ │
                                              └──────────────────────────────┘
```

- Плитка: ~56×56 px, скруглённый квадрат, аватар пользователя (или иконка сервера/группы),
  красный счётчик непрочитанных в правом верхнем углу, подсветка активной плитки.
- Самый свежий чат — справа (ближе к углу). Максимум плиток — настройка (по умолчанию 8).
- Правый клик по плитке — «Убрать из списка» / «Отметить прочитанным».
- Панель чата: ~400×640 px, тёмная тема в стиле Discord, автопрокрутка вниз.
- Отступ от края экрана: справа 16 px, сверху 12 px от рабочей области
  (у пользователя панель задач Windows 10 расположена **сверху** — учитывать `workArea`, а не `bounds`).

---

## 2. Окружение пользователя

- Windows 10, панель задач сверху, монитор 1920×1080.
- Обычный Discord (Stable) для Windows.
- Есть VS Code, Git, опыт разработки (Android Studio, IntelliJ).
- Нужно установить: **Node.js LTS**, **pnpm** (`npm i -g pnpm`), **Git**.

---

## 3. Архитектура

Vencord-плагин из двух частей + отдельное окно Electron.

```
┌──────────────── Discord (Electron) ─────────────────────────────────────┐
│                                                                          │
│  Renderer (окно Discord)            Main process                         │
│  ┌──────────────────────────┐       ┌──────────────────────────────────┐ │
│  │ index.tsx                │ IPC   │ native.ts                        │ │
│  │ - слушает MESSAGE_CREATE │──────▶│ - создаёт BrowserWindow оверлея  │ │
│  │ - берёт данные из Store  │       │   (transparent, frameless,       │ │
│  │ - отправляет сообщения   │◀──────│    alwaysOnTop, skipTaskbar)     │ │
│  │ - long-poll событий      │       │ - пересылает данные в оверлей    │ │
│  └──────────────────────────┘       │ - получает действия из оверлея   │ │
│                                     └───────────────┬──────────────────┘ │
│                                                     │ IPC (preload)      │
│                                     ┌───────────────▼──────────────────┐ │
│                                     │ Overlay window (HTML/CSS/JS)     │ │
│                                     │ - плитки, панель чата, ввод      │ │
│                                     └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Renderer-часть (`index.tsx`)

- `definePlugin({ name: "FloatingChats", flux: { MESSAGE_CREATE(...) }, start(), stop(), settings })`.
- Источник сообщений — Flux-событие `MESSAGE_CREATE` (`{ message, optimistic, channelId }`).
  Пропускать `optimistic`, свои сообщения (`message.author.id === UserStore.getCurrentUser().id`).
- Фильтр «кто мне написал» (настраивается):
  - личные сообщения — тип канала `1` (DM);
  - групповые чаты — тип `3` (GROUP_DM);
  - упоминания на серверах — `message.mentions` содержит меня, или `mention_everyone`, или упомянута моя роль (опционально);
  - учитывать заглушённые (muted) каналы/серверы — по возможности через `UserGuildSettingsStore`.
- Данные для плитки: `channelId`, заголовок (имя собеседника / название группы / `#канал · Сервер`),
  URL аватара (`user.getAvatarURL(...)` или CDN `https://cdn.discordapp.com/avatars/{id}/{hash}.png?size=64`),
  счётчик непрочитанных, время последнего сообщения.
- История при раскрытии: `MessageStore.getMessages(channelId)`; если пусто — подгрузить
  (через `MessageActions.fetchMessages` или аналог, сверить по исходникам Vencord).
- Отправка: `sendMessage(channelId, { content })` из `@utils/discord` (сверить сигнатуру).
- Отметить прочитанным (опционально, настройка): найти актуальный способ ack в Vencord-плагинах
  (например, как это сделано в плагине ReadAllNotificationsButton).
- Связь с main: `const Native = VencordNative.pluginHelpers.FloatingChats as PluginNative<typeof import("./native")>`.
- События из оверлея (клик «отправить», «открыть в Discord», «прочитано») приходят через
  **long-poll**: renderer в цикле вызывает `await Native.nextEvent()`, main резолвит промис, когда
  оверлей что-то прислал. В `stop()` цикл прерывается.

### 3.2 Main-часть (`native.ts`)

- Экспортируемые функции получают первым аргументом `IpcMainInvokeEvent`.
- `createOverlay()`:
  ```ts
  new BrowserWindow({
    transparent: true, frame: false, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false, hasShadow: false, focusable: true,
    webPreferences: { preload: <путь>, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  ```
- Позиция: `screen.getPrimaryDisplay().workArea` → правый верхний угол с отступами;
  пересчитывать при `display-metrics-changed`.
- Свернуто/раскрыто — менять размер окна через `setBounds` (свёрнутое окно занимает только
  полосу плиток и не перекрывает клики по остальному экрану).
- Сворачивание по клику мимо — событие `blur` окна оверлея.
- Показ без кражи фокуса при новом сообщении — `showInactive()`.
- Preload для оверлея: записать маленький файл в `app.getPath("userData")` при старте
  (или найти способ отдавать его из сборки Vencord) и пробросить через `contextBridge`
  ровно два метода: `onUpdate(cb)` и `send(action)`.
- HTML оверлея — строка в коде, загружать через `loadURL("data:text/html;charset=utf-8,...")`
  или временный файл.
- Закрывать окно и чистить IPC-обработчики при `stop()` плагина.

### 3.3 Оверлей (HTML/CSS/JS)

- Чистый JS без фреймворков (или Preact, если удобнее — решить на этапе 2).
- **Безопасность:** текст сообщений вставлять только через `textContent`, никогда `innerHTML`
  (иначе любое сообщение сможет выполнить код). Строгий CSP в `<meta>`: картинки только с
  `https://cdn.discordapp.com`, никаких внешних скриптов.
- Тема: фон `#2b2d31`, плитки `#1e1f22`, акцент `#5865f2`, красный `#f23f43`, текст `#dbdee1`, шрифт `gg sans` / `Segoe UI`.
- Enter — отправить, Shift+Enter — новая строка, Esc — свернуть.
- Плавная анимация раскрытия (CSS transition по высоте/opacity).

### 3.4 Настройки плагина (`definePluginSettings`)

| Ключ | Тип | По умолчанию | Описание |
|---|---|---|---|
| `includeDMs` | boolean | true | Личные сообщения |
| `includeGroupDMs` | boolean | true | Групповые чаты |
| `includeMentions` | boolean | true | Упоминания на серверах |
| `respectMuted` | boolean | true | Не показывать заглушённые |
| `maxTiles` | number | 8 | Максимум плиток |
| `markReadOnOpen` | boolean | false | Отмечать прочитанным при открытии |
| `hideWhenDiscordFocused` | boolean | false | Прятать оверлей, когда активно окно Discord |
| `position` | select | top-right | Угол экрана |

---

## 4. Структура проекта

```
Vencord/                          ← клон https://github.com/Vendicated/Vencord
└── src/userplugins/floatingChats/
    ├── index.tsx                 ← renderer: события, данные, отправка, настройки
    ├── native.ts                 ← main: окно оверлея, IPC, long-poll
    ├── overlay/
    │   ├── overlay.html          ← разметка + CSS
    │   ├── overlay.js            ← логика плиток и панели
    │   └── preload.js            ← contextBridge: onUpdate / send
    └── types.ts                  ← общие типы (ChatTile, ChatMessage, OverlayEvent)
```

Свой код держать в отдельном git-репозитории и подключать в `src/userplugins/` симлинком
(`mklink /D`), чтобы обновлять Vencord независимо.

### Фактическая раскладка (сделано на этапе 0)

- Репозиторий плагина и клон Vencord лежат **рядом в одной папке**: `<папка>\floating-chats`
  (исходники в `src/`) и `<папка>\Vencord` — на это рассчитаны `tsconfig.json` и `setup.ps1`.
- `Vencord\src\userplugins\floatingChats` — **junction** (`mklink /J`, админ не нужен) → `floating-chats\src`.
- esbuild резолвит junction в реальный путь, поэтому алиасы `@utils`, `@webpack` и т.п. берутся из
  `floating-chats\tsconfig.json`, который делает `extends: "../Vencord/tsconfig.json"`. Не удалять.
- `floating-chats\node_modules` — junction → `Vencord\node_modules`: иначе из реального пути плагина
  не резолвятся пакеты (`@vencord/discord-types/enums` и т.п.). В git не попадает (`.gitignore`).
- Проверка типов: из папки Vencord `npx tsc --noEmit -p ../floating-chats/tsconfig.json`
  (смотреть только строки с `floating-chats`).
- В `MESSAGE_CREATE` приходит сырой объект API (snake_case, `author` — простой объект), а не
  запись `Message` из `MessageStore` — см. `RawMessage` в `src/types.ts`.
- Vencord патчит `BrowserWindow` и внедряет себя в любое окно, у которого заданы **и `preload`, и `title`**.
  Окну оверлея `title` не задавать.
- `native.ts` импортируется в main при старте Discord даже при выключенном плагине, и каждый его экспорт
  становится IPC-обработчиком — экспортировать только функции, окно создавать в `initOverlay()`.
- Файлы оверлея подключаются через `import x from "file://overlay/…"` (плагин сборки Vencord);
  HTML собирается в `native.ts`, CSP разрешает скрипт и стиль только по sha256-хешу.
- Файлы — только LF (`.gitattributes`). CSP-хеш считается по тексту после нормализации переводов строк
  браузером; `native.ts` дополнительно приводит CSS/JS к `\n`, иначе CRLF молча блокирует стили.
- Журнал main-процесса плагина: `%APPDATA%\discord\floatingChats\main.log` (загрузка оверлея, ошибки preload,
  консоль окна оверлея, layout).
- Скриншот прозрачного окна через `Graphics.CopyFromScreen` пустой — нужен `BitBlt` с флагом `CAPTUREBLT`.
- Неинтерактивный inject (Discord должен быть закрыт): `node scripts/runInstaller.mjs -- -install -branch stable`
  (из папки Vencord; после обновления Discord — то же с `-repair`).

---

## 5. Сборка и цикл разработки

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install --frozen-lockfile
# создать src/userplugins/floatingChats/...
pnpm build            # или: pnpm build --watch
pnpm inject           # один раз: встроить Vencord в Discord (закрыть Discord перед этим)
```

- Изменения в `index.tsx` → пересборка → в Discord **Ctrl+R**.
- Изменения в `native.ts` **и в `overlay/*`** (они встраиваются в main-бандл `dist/patcher.js`) →
  пересборка → полный перезапуск Discord: в консоли DevTools Discord выполнить `DiscordNative.app.relaunch()`.
  **Не убивать Discord принудительно** (`taskkill /F`, `Stop-Process -Force`): при этом может не сохраниться
  Local Storage, и Discord выкидывает из аккаунта.
- Консоль renderer Discord (в т.ч. логи плагина) дублируется в `%APPDATA%\discord\logs\renderer_js.log` —
  можно читать без DevTools: `grep -n FloatingChats renderer_js.log | tail`.
- Renderer-бандл для Discord — `dist/renderer.js` (а `vencordDesktopRenderer.js` — для Vesktop, не путать).
- Включить плагин: Настройки Discord → Vencord → Plugins → FloatingChats.
- DevTools Discord: **Ctrl+Shift+I** (renderer-логи). Логи main-процесса — запустить Discord из консоли.
- После обновлений Discord может понадобиться снова `pnpm inject`.

---

## 6. План работ (этапы)

- [x] **Этап 0. Окружение.** Node.js LTS, pnpm, Git; клон Vencord; `pnpm build` + `pnpm inject`; Vencord виден в настройках Discord.
- [x] **Этап 1. Скелет плагина.** `index.tsx` с `definePlugin`, плагин включается, в консоль пишется каждое входящее `MESSAGE_CREATE` (автор, канал, тип канала, текст).
- [x] **Этап 2. Окно поверх всех окон.** `native.ts` создаёт прозрачное окно в правом верхнем углу с тестовыми плитками; окно поверх всех программ, не в панели задач, не крадёт фокус.
- [x] **Этап 3. Данные → плитки.** Фильтр DM/групп/упоминаний, реальные аватарки, счётчики, сортировка, лимит.
- [x] **Этап 4. Раскрытие чата.** Клик по плитке — панель с историей канала; клик мимо / Esc — сворачивание; живое обновление при новых сообщениях.
- [x] **Этап 5. Отправка.** Поле ввода → long-poll → `sendMessage`; отправленное сразу видно в панели.
- [x] **Смена подхода (после этапа 5).** Своя панель чата заменена настоящим чатом Discord в его попауте
  (см. «Чат в попауте Discord» ниже). Своя панель удалена. Сделано попутно: перетаскивание виджета и чата
  с ограничением по монитору, ориентация плиток, подписи под плитками, реакции на мои сообщения,
  скрытие прочитанных (BULK_ACK при открытии/закрытии), настройки на английском.
- [x] **Этап 6. Полировка.** Меню по правому клику (Mark as read / Open in Discord / Remove from list),
  кнопка «Open in Discord» в шапке чата, настройка `hideWhenDiscordFocused`, анимация появления плиток,
  весь видимый текст на английском. Смена разрешения/монитора — `display-*` события + ограничение по монитору.
- [x] **Этап 7. Надёжность.** Части Discord ищутся явно (`resolveDiscordParts`); если не нашлись — ошибка в логе,
  одно уведомление за сессию и открытие чата в основном окне Discord. `ChannelChat` обёрнут в `ErrorBoundary`.
  Проверены подписки/таймеры/окна при stop/start и Ctrl+R. `setup.ps1` (junction'ы), README на английском.

### Чат в попауте Discord (`src/popoutChat.tsx`)

Сверено по исходникам клиента Discord (выгрузка webpack-модулей и `core.asar`):
- `PopoutActions.open(key, render, features)` → `window.open` → Discord рендерит `render(key)` в `#app-mount`
  попаута в **том же** JS-контексте (сторы общие, свои `<link>`-стили Discord копирует сам).
- Main-процесс Discord пропускает в `BrowserWindow` только `ALLOWED_FEATURES`: width/height/left/top, resizable,
  movable, alwaysOnTop, frame, transparent, hasShadow, closable, skipTaskbar, backgroundColor, focusable…
  Булевы кодируются `yes`/`no`. По умолчанию попаут `frame: false`, фон `#2f3136`, min 320×180.
  `childWindow.windowKey = frameName` — по нему `native.ts` находит окно чата (`POPOUT_KEY` в `constants.ts`).
- `PopoutWindow` (обёртка попаутов) ищется по строке `"Missing guestWindow reference"`; `withTitleBar: false`,
  `onBlur` — как у попаута саундборда.
- `ChannelChat` — по `location:"ChannelChat"`; для неоткрытого канала Discord сам передаёт
  `chatInputType = ChatInputTypes.SIDEBAR` (объект с `SIDEBAR.analyticsName === "sidebar"`).
  Обёртка — CSS-модуль с единственным классом `chat_<hash>`. Историю `ChannelChat` **не грузит** —
  вызываем `MessageActions.fetchMessages`.
- Фон чата берётся из `--background-gradient-chat`, `--background-base-lower`, `--background-base-lowest`;
  они обнуляются в попауте, а полупрозрачный фон (цвет темы × `popoutOpacity`) задаёт `#app-mount`.
- Перетаскивание виджета и чата — вручную (pointer events → main → `setPosition` с ограничением по монитору):
  системный `-webkit-app-region: drag` не работает у `movable: false` и не ограничивается краем экрана.
- Реакции: `MESSAGE_REACTION_ADD` содержит `messageAuthorId` (из `message_author_id` гейтвея).

### Окно виджета (`src/overlay/`, `native.ts`)

- Окно плиток привязано **правым верхним углом** (`position.json`) и растёт влево/вниз; содержимое прижато
  вправо. Окно — ровно по плиткам, чтобы виджет доходил до любого края экрана.
- **Не менять размер/положение окна плиток при наведении:** Windows перерисовывает прозрачное окно
  со скачком, курсор уходит с плитки → «телепортация» по кругу.
- Поэтому карточка при наведении и меню по правому клику — в **отдельном всплывающем окне** (`popupWin`,
  тот же HTML/JS с `<body data-mode="popup">`). Main ставит его рядом с плиткой через `placeBeside`
  (`src/placement.ts`, проверяется в Node): вертикально — слева, не помещается — справа; горизонтально —
  снизу, не помещается — сверху; затем сдвиг в пределы экрана. Окно чата выбирает сторону так же.
- Всплывающее окно шлёт размер (`popupLayout`) **синхронно**, не в `requestAnimationFrame`: окно скрыто
  до размещения, а в скрытом окне rAF не вызывается (иначе тупик — окно не появится).
- Карточка пропускает клики насквозь (`setIgnoreMouseEvents(true)`), меню кликабельное и получает фокус —
  закрывается по `blur` (клик мимо).
- Прозрачные места окна плиток пропускают клики: оверлей шлёт `passThrough` → `setIgnoreMouseEvents(v, { forward: true })`
  (движение мыши приходит и при пропуске, поэтому над плиткой окно снова кликабельное).
- События по каналам (`chats.ts`, `events`): вид (mention/reply/role/everyone/message/reaction), кто, когда;
  подряд одинаковые склеиваются. Сохраняются с чатами в DataStore (`[id, время, { events, reactions }]`),
  чистятся при прочтении. Карточка показывает только людей и время, без вида действия.
- Логику `chats.ts` можно гонять в Node: бандл через esbuild с заглушкой `@webpack/common` (сторы) и `./settings`.
- CSS Discord можно скачать для справки: ссылки на `/assets/*.css` есть в `https://discord.com/app`.

---

## 7. Критерии готовности

1. Мне пишут в ЛС, когда Discord свёрнут, а я в браузере → в правом верхнем углу появляется плитка с аватаркой и цифрой 1, фокус браузера не теряется.
2. Клик по плитке → раскрывается чат с последними сообщениями, курсор в поле ввода.
3. Пишу ответ + Enter → сообщение уходит собеседнику, Discord не всплывает.
4. Клик в любое место экрана → панель сворачивается до плиток.
5. Перезапуск Discord → всё работает без ручных действий.

---

## 8. Риски и ограничения

- **Правила Discord:** модифицированные клиенты нарушают Условия использования. Баны редки,
  но риск ненулевой — понимаю и принимаю.
- **Обновления Discord** могут ломать внутренние API (`Store`, `sendMessage`, webpack-модули) —
  при поломке сверять с актуальными исходниками Vencord и встроенными плагинами.
- **Полноэкранные игры** (exclusive fullscreen) могут перекрывать любое окно — поверх них
  оверлей не гарантирован; в оконном/borderless режиме работает.
- Названия внутренних API в этом файле — ориентир; перед реализацией **сверять с текущим
  кодом Vencord** (`src/webpack/common`, `src/utils/discord.tsx`, примеры в `src/plugins`
  с файлом `native.ts`).

---

## 9. Предыстория

Ранее сделан запасной вариант на Python (`discord-overlay`): читает уведомления Windows от Discord,
рисует такую же панель на PySide6, отвечает через Ctrl+K. Он безопасен для аккаунта, но без
истории, без аватарок и с ненадёжной отправкой. Дизайн плиток и панели можно взять оттуда.
