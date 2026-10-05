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
    hideRead: {
        type: OptionType.BOOLEAN,
        description: "Убирать плитку, когда в чате всё прочитано (вернётся с новым сообщением)",
        default: true,
        onChange: refresh,
    },
    orientation: {
        type: OptionType.SELECT,
        description: "Расположение плиток",
        options: [
            { label: "Горизонтально", value: "horizontal", default: true },
            { label: "Вертикально", value: "vertical" },
        ],
        onChange: refresh,
    },
    popoutOpacity: {
        type: OptionType.SLIDER,
        description: "Непрозрачность фона чата, %",
        markers: [40, 50, 60, 70, 80, 90, 100],
        default: 85,
        stickToMarkers: false,
    },
    resetPositions: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button size="small" variant="secondary" onClick={() => onResetPositions.fn()}>
                Вернуть виджет и чат в угол экрана
            </Button>
        ),
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
