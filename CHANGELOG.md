# Changelog

## 1.0.0 — 2026-10-07

First public release. **Windows 10/11 only** — macOS and Linux are not supported.

### Tiles
- Always-on-top widget with a tile for each chat that needs your attention: direct messages, group DMs,
  server mentions (you, your roles, `@everyone`/`@here`, respecting server notification settings),
  replies to your messages and reactions to them.
- Avatar or server icon, unread counter, label (name, or `#channel` and server).
- A small avatar in the corner of the tile shows who was active; hover the tile to see everyone who was
  active in that chat since you last read it, with times.
- Read chats disappear and come back with the next message. The list survives Discord restarts.
- Right-click menu: Mark as read, Open in Discord, Remove from list.
- Placeholder tile when there are no new messages, so you always know where tiles will appear.
- Horizontal or vertical layout. Drag the widget by its handle anywhere on screen, right up to the edges.
- Tiles never steal focus; empty space around them lets clicks through to the windows below.

### Chat window
- Clicking a tile opens the real Discord chat (Discord's own chat component in a Discord popout window):
  markdown, emoji, images, embeds, replies, reactions, attachments, typing indicator.
- Semi-transparent background in your Discord theme color, rounded corners, opacity setting.
- Drag it by its header; it remembers its position and stays on screen.
- Opens next to the tiles on the side that has room; closes when you click elsewhere.
- Open in Discord button jumps to the channel in the main window.

### Reliability
- If a Discord update breaks the internals the chat window relies on, chats open in the main Discord window
  instead and you get a one-time notification.
- `setup.ps1` links the plugin into a Vencord clone; logs in `%APPDATA%\discord\floatingChats\main.log`.
