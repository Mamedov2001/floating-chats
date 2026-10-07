/*
 * FloatingChats — floating Discord chat tiles for Vencord
 * Copyright (c) 2026 Mamedov2001
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Где поставить всплывающее окно (карточку, меню, чат) рядом с плитками. Чистая функция — без Electron,
// чтобы её можно было проверить в Node.

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Позиция окна size рядом с прямоугольником target на рабочей области workArea:
 *  - vertical: слева от target, верхним краем вровень; слева не помещается — справа;
 *  - иначе: под target, правым краем вровень; снизу не помещается — над ним.
 * Затем окно сдвигается в пределы рабочей области.
 *
 * pad — прозрачный запас по краям окна (под тень): видимое содержимое отстоит от краёв окна на pad,
 * сам запас может выходить за край экрана. gap — зазор между target и видимым содержимым.
 */
export function placeBeside(target: Rect, size: { width: number; height: number; }, workArea: Rect, vertical: boolean, gap: number, pad = 0) {
    const { width: w, height: h } = size;
    const wa = workArea;

    let x: number, y: number;
    if (vertical) {
        x = target.x - gap - w + pad;
        if (x + pad < wa.x) x = target.x + target.width + gap - pad;
        y = target.y - pad;
    } else {
        x = target.x + target.width - w + pad;
        y = target.y + target.height + gap - pad;
        if (y + h - pad > wa.y + wa.height) y = target.y - gap - h + pad;
    }

    x = Math.min(Math.max(x, wa.x - pad), wa.x + wa.width - w + pad);
    y = Math.min(Math.max(y, wa.y - pad), wa.y + wa.height - h + pad);
    return { x: Math.round(x), y: Math.round(y) };
}
