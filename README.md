# FloatingChats

A [Vencord](https://github.com/Vendicated/Vencord) plugin for the Discord desktop app on Windows.
It shows who messaged you as a row of tiles on top of all windows: over your browser, IDE or game,
even while Discord is minimized. Click a tile to open the real Discord chat in a small floating window
and reply without switching to Discord.

> **Warning.** Client mods are against Discord's Terms of Service. Bans are rare, but the risk is not zero.
> Use at your own risk.

## Features

- **Tiles** for direct messages, group DMs, server mentions (you, your roles, `@everyone`/`@here`,
  following each server's notification settings) and reactions to your messages.
  Each tile shows the avatar or server icon, an unread counter and a label (name, or `#channel` and server).
- **The real Discord chat** in a floating window: markdown, emoji, images, embeds, replies, reactions,
  attachments and the typing indicator all work because it is Discord's own chat component.
- The chat window closes when you click elsewhere. Read chats disappear from the tiles and come back
  with the next message.
- **Right-click a tile**: Mark as read, Open in Discord, Remove from list.
- **Drag** the widget by its handle and the chat by its header. Both remember their position and
  can't be dragged off the screen.
- Horizontal or vertical tiles, chat background opacity, hide the widget while Discord is focused.
- With no new messages a faint placeholder tile stays on screen, so you know where tiles will appear.
- Tiles never steal focus from the app you're using. The tile list survives Discord restarts.

## Requirements

- Windows 10 or 11 with the Discord desktop app (Stable)
- [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 22 or newer, and pnpm (`npm i -g pnpm`)

## Installation

Vencord and this plugin must be cloned **next to each other** in the same folder:

```powershell
cd C:\projects
git clone https://github.com/Vendicated/Vencord
git clone https://github.com/Mamedov2001/floating-chats

cd Vencord
pnpm install --frozen-lockfile

# Links the plugin into Vencord (no admin rights needed)
powershell -ExecutionPolicy Bypass -File ..\floating-chats\setup.ps1

pnpm build
```

Then **quit Discord completely** and inject Vencord into it:

```powershell
pnpm inject
```

Start Discord, open **Settings → Vencord → Plugins**, find **FloatingChats** and turn it on.

## Updating

```powershell
cd C:\projects\floating-chats; git pull
cd ..\Vencord; git pull; pnpm install --frozen-lockfile; pnpm build
```

Then restart Discord. To restart it cleanly, open DevTools in Discord (`Ctrl+Shift+I`) and run
`DiscordNative.app.relaunch()`. Don't kill Discord from Task Manager: that can sign you out.

**After a Discord update** Vencord may disappear from Discord. Quit Discord and run `pnpm inject` again.

## Settings

| Setting | Default | |
|---|---|---|
| Direct messages | on | Tiles for DMs |
| Group DMs | on | Tiles for group chats |
| Server mentions | on | You, your roles, `@everyone`/`@here` (respects server settings) |
| Reactions to my messages | on | Someone reacted to your message |
| Hide muted channels, servers and DMs | on | |
| Hide a tile once the chat is read | on | It comes back with the next message |
| Show labels under tiles | on | Name, or `#channel` and server |
| Show the widget when there are no new messages | on | A placeholder tile marks where tiles will appear |
| Hide the widget while the Discord window is focused | off | |
| Tile layout | Horizontal | Horizontal or vertical |
| Chat background opacity | 85% | |
| Maximum number of tiles | 8 | |

The **Move widget and chat back to the screen corner** button resets their saved positions.

## Troubleshooting

- **Clicking a tile opens the chat in the main Discord window instead of the floating window,
  and you got a "Discord was updated" notification.** Discord changed its internals and the plugin
  can't find the chat component any more. Tiles keep working; the plugin needs an update.
- **Logs.** Plugin messages from the Discord window: `%APPDATA%\discord\logs\renderer_js.log`
  (search for `FloatingChats`). Widget window and main process: `%APPDATA%\discord\floatingChats\main.log`.
- **Exclusive fullscreen games** can cover any window. Borderless or windowed mode works.

## How it works

- `src/index.tsx` listens to Discord events (`MESSAGE_CREATE`, `MESSAGE_REACTION_ADD`, …), decides which
  chats get a tile (`src/chats.ts`) and opens the chat window (`src/popoutChat.tsx`).
- `src/native.ts` runs in Discord's main process. It creates the transparent always-on-top tile window
  (`src/overlay/`), positions and drags it, and passes clicks back to the plugin.
- The chat window is one of Discord's own popout windows (the kind it uses for calls and the soundboard)
  showing Discord's own channel chat component. That's why all chat features work out of the box.

Development notes (in Russian) are in [CLAUDE.md](CLAUDE.md).
