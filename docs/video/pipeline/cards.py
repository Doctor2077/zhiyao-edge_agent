#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""片头/片尾整屏卡与系统通知气泡。

和 compose.py 共用同一套「深色悬浮舞台」的底子：近黑渐变 + 品牌色光晕 + 暗角，
品牌标记后面压一团辉光。片头片尾不再是「黑底白字」，而是舞台的延续。
品牌标记严格按 docs/brand 的 D1「合符·点睛」几何绘制。
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CANVAS_W, CANVAS_H = 1920, 1080
FONT_DIR = r"C:\Windows\Fonts"
F_ZH = FONT_DIR + r"\msyh.ttc"
F_ZH_B = FONT_DIR + r"\msyhbd.ttc"
F_UI = FONT_DIR + r"\segoeui.ttf"
F_UI_B = FONT_DIR + r"\segoeuib.ttf"

ACCENT = (72, 140, 255)
ACCENT2 = (150, 96, 255)

_cache: dict = {}


def _font(path, size):
    k = (path, size)
    if k not in _cache:
        try:
            _cache[k] = ImageFont.truetype(path, size)
        except Exception:
            _cache[k] = ImageFont.truetype(F_ZH, size)
    return _cache[k]


def brand_mark(size: int, fg=(0, 0, 0), bg=None, stroke_ratio: float = 8 / 128):
    """D1 标记：圆角方外框 + 右半实心 + 两道锯齿合缝 + 白半黑点 / 黑半白点。

    严格按 128 网格几何（外框 14..114，rx=16，锯齿 M64,6→54,38→74,54→54,70→74,86→64,122）。
    """
    S = 4  # 超采样
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = n / 128.0

    def P(x, y):
        return (x * k, y * k)

    sw = max(1, int(round(8 * k)))
    if bg is not None:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(28 * k), fill=bg)

    zig = [P(64, 6), P(54, 38), P(74, 54), P(54, 70), P(74, 86), P(64, 122)]

    right = Image.new("L", (n, n), 0)
    rd = ImageDraw.Draw(right)
    rd.rounded_rectangle([14 * k, 14 * k, 114 * k, 114 * k], radius=16 * k, fill=255)
    cut = Image.new("L", (n, n), 0)
    cd = ImageDraw.Draw(cut)
    cd.polygon([zig[0], zig[1], zig[2], zig[3], zig[4], zig[5], P(128, 122), P(128, 6)], fill=255)
    right = Image.composite(right, Image.new("L", (n, n), 0), cut)
    img.paste(Image.new("RGBA", (n, n), (*fg, 255)), (0, 0), right)

    d.rounded_rectangle([14 * k, 14 * k, 114 * k, 114 * k], radius=16 * k,
                        outline=(*fg, 255), width=sw)
    d.line(zig, fill=(*fg, 255), width=sw, joint="curve")

    r = 6 * k
    cx, cy = P(40, 40)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*fg, 255))
    cx, cy = P(88, 88)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 0))
    d.ellipse([cx - r * 1.35, cy - r * 1.35, cx + r * 1.35, cy + r * 1.35], fill=(*fg, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 0))

    return img.resize((size, size), Image.LANCZOS)


def _stage_bg() -> Image.Image:
    """和 compose 的舞台同源的底：渐变 + 两团品牌色光晕 + 暗角。"""
    t = np.linspace(0.0, 1.0, CANVAS_H, dtype=np.float32)[:, None]
    col = np.array([17, 19, 27], np.float32)[None, :] \
        + (np.array([6, 7, 11], np.float32) - np.array([17, 19, 27], np.float32))[None, :] * t
    img = np.repeat(col[:, None, :], CANVAS_W, axis=1)

    yy, xx = np.mgrid[0:CANVAS_H, 0:CANVAS_W].astype(np.float32)
    nx = (xx - CANVAS_W / 2) / (CANVAS_W / 2)
    ny = (yy - CANVAS_H / 2) / (CANVAS_H / 2)
    r = np.sqrt(nx * nx + ny * ny)
    img *= np.clip(1.0 - 0.40 * np.clip(r - 0.32, 0, None) ** 1.5, 0, 1)[:, :, None]

    base = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")

    glow = Image.new("RGB", (CANVAS_W, CANVAS_H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for cx, cy, rad, c in ((CANVAS_W * 0.30, CANVAS_H * 0.34, 460, ACCENT),
                           (CANVAS_W * 0.74, CANVAS_H * 0.70, 520, ACCENT2)):
        gd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad],
                   fill=tuple(int(v * 0.34) for v in c))
    glow = glow.filter(ImageFilter.GaussianBlur(190))
    return Image.blend(base, Image.blend(base, glow, 0.72), 0.85)


def _halo(size: int, color=ACCENT, alpha: int = 120) -> Image.Image:
    """标记后面那团辉光。"""
    s = size * 2
    yy, xx = np.mgrid[0:s, 0:s].astype(np.float32)
    d = np.sqrt((xx - s / 2) ** 2 + (yy - s / 2) ** 2) / (s / 2)
    a = np.clip(1.0 - d, 0, 1) ** 2.4 * alpha
    arr = np.zeros((s, s, 4), np.uint8)
    arr[:, :, 0], arr[:, :, 1], arr[:, :, 2] = color
    arr[:, :, 3] = a.astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def _grad_text(text: str, f, c0, c1) -> Image.Image:
    """文字走品牌渐变填充，返回 RGBA 位图。"""
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    w = int(probe.textlength(text, font=f))
    asc, desc = f.getmetrics()
    mask = Image.new("L", (max(1, w + 8), asc + desc + 8), 0)
    ImageDraw.Draw(mask).text((4, 4), text, font=f, fill=255)

    grad = np.zeros((mask.height, mask.width, 3), np.uint8)
    tt = np.linspace(0.0, 1.0, mask.width, dtype=np.float32)[None, :]
    for i in range(3):
        grad[:, :, i] = (c0[i] + (c1[i] - c0[i]) * tt).astype(np.uint8)
    out = Image.fromarray(grad, "RGB").convert("RGBA")
    out.putalpha(mask)
    return out


def _cx(text: str, f) -> int:
    """居中排版的 x 坐标。"""
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    return int((CANVAS_W - probe.textlength(text, font=f)) / 2)


def intro_card() -> Image.Image:
    """片头：标记 + 产品名（品牌渐变）+ 标语 + 一行定位。"""
    img = _stage_bg().convert("RGBA")

    M, MY = 176, 296
    halo = _halo(M, ACCENT, 132)                 # 直径 2M，圆心对准标记中心
    img.alpha_composite(halo, (int(CANVAS_W / 2 - M), MY - M // 2))

    mark = brand_mark(M, fg=(255, 255, 255))
    img.paste(mark, (int(CANVAS_W / 2 - M / 2), MY), mark)

    d = ImageDraw.Draw(img)
    f1 = _font(F_ZH_B, 96)
    g = _grad_text("执要 Agent", f1, (255, 255, 255), (206, 216, 240))
    img.paste(g, (int(CANVAS_W / 2 - g.width / 2), 526), g)

    # 品牌渐变横线
    lw = 210
    line = Image.new("RGBA", (lw, 3), (0, 0, 0, 0))
    ld = ImageDraw.Draw(line)
    for i in range(lw):
        t = i / (lw - 1)
        c = tuple(int(ACCENT[j] + (ACCENT2[j] - ACCENT[j]) * t) for j in range(3))
        ld.line([(i, 0), (i, 2)], fill=(*c, 235))
    img.paste(line.convert("RGB"), (int(CANVAS_W / 2 - lw / 2), 664), line.split()[3])

    f2 = _font(F_ZH, 38)
    t2 = "圣人执要 · 四方来效"
    d.text((_cx(t2, f2), 700), t2, font=f2, fill=(196, 202, 218))

    f3 = _font(F_ZH, 27)
    t3 = "Edge 侧边栏 · 网页 AI 助手 · 自带 API Key"
    d.text((_cx(t3, f3), 786), t3, font=f3, fill=(122, 132, 152))
    return img.convert("RGB")


def outro_card() -> Image.Image:
    """片尾：标记 + 产品名 + 商店搜索指引 + 三条卖点。"""
    img = _stage_bg().convert("RGBA")

    M, MY = 140, 268
    halo = _halo(M, ACCENT2, 118)
    img.alpha_composite(halo, (int(CANVAS_W / 2 - M), MY - M // 2))

    mark = brand_mark(M, fg=(255, 255, 255))
    img.paste(mark, (int(CANVAS_W / 2 - M / 2), MY), mark)

    d = ImageDraw.Draw(img)
    f1 = _font(F_ZH_B, 76)
    g = _grad_text("执要 Agent", f1, (255, 255, 255), (206, 216, 240))
    img.paste(g, (int(CANVAS_W / 2 - g.width / 2), 448), g)

    f2 = _font(F_ZH_B, 40)
    t2 = "Edge 加载项商店搜索「执要 Agent」"
    d.text((_cx(t2, f2), 572), t2, font=f2, fill=(238, 240, 246))

    f3 = _font(F_ZH, 27)
    t3 = "自带 API Key   ·   无服务器   ·   无账号   ·   数据只存本机"
    d.text((_cx(t3, f3), 652), t3, font=f3, fill=(142, 152, 172))

    lw = 150
    line = Image.new("RGBA", (lw, 3), (0, 0, 0, 0))
    ld = ImageDraw.Draw(line)
    for i in range(lw):
        t = i / (lw - 1)
        c = tuple(int(ACCENT[j] + (ACCENT2[j] - ACCENT[j]) * t) for j in range(3))
        ld.line([(i, 0), (i, 2)], fill=(*c, 220))
    img.paste(line.convert("RGB"), (int(CANVAS_W / 2 - lw / 2), 706), line.split()[3])
    return img.convert("RGB")


def toast(text_title: str, text_body: str, app: str = "执要 Agent") -> Image.Image:
    """Windows 11 风格系统通知（用于演示定时任务到点提醒）。"""
    W, H = 460, 132
    S = 2
    img = Image.new("RGBA", (W * S + 48, H * S + 48), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    ox = oy = 24 * S

    # 投影：深色舞台上气泡必须自己带影子才立得起来
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [ox + 4 * S, oy + 10 * S, ox + (W - 6) * S, oy + (H + 4) * S],
        radius=12 * S, fill=(0, 0, 0, 150))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(9 * S)))

    d.rounded_rectangle([ox + 6 * S, oy + 8 * S, ox + (W - 6) * S, oy + (H - 6) * S],
                        radius=12 * S, fill=(250, 250, 252, 250),
                        outline=(206, 210, 218, 255), width=S)
    mark = brand_mark(40 * S, fg=(0, 0, 0))
    img.paste(mark, (ox + 24 * S, oy + 24 * S), mark)
    d.text((ox + 76 * S, oy + 22 * S), app, font=_font(F_ZH, 19 * S), fill=(60, 64, 72))
    d.text((ox + 76 * S, oy + 50 * S), text_title, font=_font(F_ZH_B, 22 * S), fill=(20, 20, 22))
    d.text((ox + 76 * S, oy + 82 * S), text_body, font=_font(F_ZH, 19 * S), fill=(90, 94, 102))
    return img.resize((W + 24, H + 24), Image.LANCZOS)
