FloatingChats {VERSION} for Windows
===================================

Floating chat tiles for Discord: see who messaged you on top of all windows and reply in a small
floating chat without switching to Discord. Windows 10/11 only.

WARNING: client mods are against Discord's Terms of Service. Bans are rare, but the risk is not zero.
Use at your own risk.

Install
-------
1. Quit Discord completely: right-click the Discord icon in the tray -> Quit Discord.
2. Double-click install.cmd.
   If Windows says "Windows protected your PC", click "More info" -> "Run anyway".
3. Start Discord. FloatingChats is already enabled.
   Settings: Discord Settings -> Vencord -> Plugins -> FloatingChats.

The files are copied to %LOCALAPPDATA%\FloatingChats - Discord loads Vencord from there, keep that folder.
You can delete this extracted folder after installing.

Update
------
Download the new release and run its install.cmd (Discord closed).
If a Discord update removes Vencord, just run install.cmd again.

Uninstall
---------
Quit Discord and double-click uninstall.cmd. Discord goes back to normal.

About this build
----------------
This is Vencord (https://github.com/Vendicated/Vencord, commit {VENCORD_COMMIT}) built together with
FloatingChats {VERSION} (https://github.com/Mamedov2001/floating-chats, tag v{VERSION}).
Vencord's own updater is turned off, so it can't replace this build with one without FloatingChats.
The Vencord installer is downloaded from its official releases: https://github.com/Vencord/Installer

License: GPL-3.0-or-later (see LICENSE). Source code is available at the links above.
