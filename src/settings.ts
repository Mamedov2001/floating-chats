import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

/** Вызывается при изменении любой настройки, влияющей на набор плиток (назначается в index.tsx). */
export const onTilesSettingChanged = { fn: () => { } };
const refresh = () => onTilesSettingChanged.fn();

export const settings = definePluginSettings({
    includeDMs: {
        type: OptionType.BOOLEAN,
        description: "Личные сообщения",
        default: true,
        onChange: refresh,
    },
    includeGroupDMs: {
        type: OptionType.BOOLEAN,
        description: "Групповые чаты",
        default: true,
        onChange: refresh,
    },
    includeMentions: {
        type: OptionType.BOOLEAN,
        description: "Упоминания на серверах (меня, моих ролей, @everyone/@here — с учётом настроек сервера)",
        default: true,
        onChange: refresh,
    },
    respectMuted: {
        type: OptionType.BOOLEAN,
        description: "Не показывать заглушённые каналы, серверы и ЛС",
        default: true,
        onChange: refresh,
    },
    maxTiles: {
        type: OptionType.SLIDER,
        description: "Максимум плиток",
        markers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        default: 8,
        stickToMarkers: true,
        onChange: refresh,
    },
});
