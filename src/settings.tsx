/*
 * FloatingChats — floating Discord chat tiles for Vencord
 * Copyright (c) 2026 Mamedov2001
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { OptionType } from "@utils/types";

/** Вызывается при изменении любой настройки, влияющей на набор плиток (назначается в index.tsx). */
export const onTilesSettingChanged = { fn: () => { } };
/** Сбросить сохранённые позиции виджета и чата (назначается в index.tsx). */
export const onResetPositions = { fn: () => { } };
const refresh = () => onTilesSettingChanged.fn();

export const settings = definePluginSettings({
    includeDMs: {
        type: OptionType.BOOLEAN,
        description: "Direct messages",
        default: true,
        onChange: refresh,
    },
    includeGroupDMs: {
        type: OptionType.BOOLEAN,
        description: "Group DMs",
        default: true,
        onChange: refresh,
    },
    includeMentions: {
        type: OptionType.BOOLEAN,
        description: "Server mentions (me, my roles, @everyone/@here — respects server notification settings)",
        default: true,
        onChange: refresh,
    },
    includeReactions: {
        type: OptionType.BOOLEAN,
        description: "Reactions to my messages",
        default: true,
        onChange: refresh,
    },
    respectMuted: {
        type: OptionType.BOOLEAN,
        description: "Hide muted channels, servers and DMs",
        default: true,
        onChange: refresh,
    },
    hideRead: {
        type: OptionType.BOOLEAN,
        description: "Hide a tile once the chat is read (it comes back with the next message)",
        default: true,
        onChange: refresh,
    },
    showLabels: {
        type: OptionType.BOOLEAN,
        description: "Show labels under tiles (name, channel and server)",
        default: true,
        onChange: refresh,
    },
    showWhenEmpty: {
        type: OptionType.BOOLEAN,
        description: "Show the widget when there are no new messages (a placeholder marks where tiles will appear)",
        default: true,
        onChange: refresh,
    },
    hideWhenDiscordFocused: {
        type: OptionType.BOOLEAN,
        description: "Hide the widget while the Discord window is focused",
        default: false,
        onChange: refresh,
    },
    orientation: {
        type: OptionType.SELECT,
        description: "Tile layout",
        options: [
            { label: "Horizontal", value: "horizontal", default: true },
            { label: "Vertical", value: "vertical" },
        ],
        onChange: refresh,
    },
    popoutOpacity: {
        type: OptionType.SLIDER,
        description: "Chat background opacity, %",
        markers: [40, 50, 60, 70, 80, 90, 100],
        default: 85,
        stickToMarkers: false,
    },
    resetPositions: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button size="small" variant="secondary" onClick={() => onResetPositions.fn()}>
                Move widget and chat back to the screen corner
            </Button>
        ),
    },
    maxTiles: {
        type: OptionType.SLIDER,
        description: "Maximum number of tiles",
        markers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        default: 8,
        stickToMarkers: true,
        onChange: refresh,
    },
});
