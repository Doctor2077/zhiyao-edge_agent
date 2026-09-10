#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""片头/片尾卡与品牌标记：纯黑白，按 docs/brand/README.md 的 D1「合符·点睛」几何。"""

from __future__ import annotations

import math
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CANVAS_W, CANVAS_H = 1920, 1080
FONT_DIR = r"C:\Windows\Fonts"
F_ZH = FONT_DIR + r"\msyh.ttc"
F_ZH_B = FONT_DIR + r"\msyhbd.ttc"
F_SERIF = FONT_DIR + r"\simsun.ttc"
F_UI = FONT_DIR + r"\segoeui.ttf"
F_UI_B = FONT_DIR + r"\segoeuib.ttf"

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

    # 锯齿合缝路径（用于裁剪右半）
    zig = [P(64, 6), P(54, 38), P(74, 54), P(54, 70), P(74, 86), P(64, 122)]

    right = Image.new("L", (n, n), 0)
    rd = ImageDraw.Draw(right)
    rd.rounded_rectangle([14 * k, 14 * k, 114 * k, 114 * k], radius=16 * k, fill=255)
    cut = Image.new("L", (n, n), 0)
    cd = ImageDraw.Draw(cut)
    cd.polygon([zig[0], zig[1], zig[2], zig[3], zig[4], zig[5], P(128, 122), P(128, 6)], fill=255)
    # composite(a, b, mask)：mask=255 处取 a。锯齿右侧（cut=255）保留圆角方 → 右半实心
    right = Image.composite(right, Image.new("L", (n, n), 0), cut)
    img.paste(Image.new("RGBA", (n, n), (*fg, 255)), (0, 0), right)

    # 外框与合缝线
    d.rounded_rectangle([14 * k, 14 * k, 114 * k, 114 * k], radius=16 * k, outline=(*fg, 255), width=sw)
    d.line(zig, fill=(*fg, 255), width=sw, joint="curve")

    # 点睛：白半黑点 (40,40)；黑半白点 (88,88)
    r = 6 * k
    cx, cy = P(40, 40)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*fg, 255))
    cx, cy = P(88, 88)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 0))
    d.ellipse([cx - r * 1.35, cy - r * 1.35, cx + r * 1.35, cy + r * 1.35], fill=(*fg, 255))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 0))

    return img.resize((size, size), Image.LANCZOS)


def _dark_bg(with_glow=True) -> Image.Image:
    img = Image.new("RGB", (CANVAS_W, CANVAS_H), (10, 10, 12))
    d = ImageDraw.Draw(img)
    for i in range(CANVAS_H):
        t = i / CANVAS_H
        v = int(10 + 16 * t)
        d.line([(0, i), (CANVAS_W, i)], fill=(v, v, v + 2))
    if with_glow:
        glow = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([-200, -520, CANVAS_W + 200, 520], fill=(255, 255, 255, 16))
        glow = glow.filter(ImageFilter.GaussianBlur(160))
        img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    return img


def intro_card() -> Image.Image:
    img = _dark_bg().convert("RGBA")
    d = ImageDraw.Draw(img)
    mark = brand_mark(168, fg=(255, 255, 255))
    img.paste(mark, (int(CANVAS_W / 2 - 84), 300), mark)

    f1 = _font(F_ZH_B, 92)
    t = "执要 Agent"
    d.text(((CANVAS_W - d.textlength(t, font=f1)) / 2, 522), t, font=f1, fill=(255, 255, 255))

    f2 = _font(F_ZH, 34)
    t2 = "圣人执要 · 四方来效"
    d.text(((CANVAS_W - d.textlength(t2, font=f2)) / 2, 648), t2, font=f2, fill=(168, 172, 180))

    f3 = _font(F_ZH, 27)
    t3 = "Edge 侧边栏 · 网页 AI 助手 · 自带 API Key"
    d.text(((CANVAS_W - d.textlength(t3, font=f3)) / 2, 712), t3, font=f3, fill=(120, 124, 132))

    d.line([(CANVAS_W / 2 - 120, 636), (CANVAS_W / 2 + 120, 636)], fill=(70, 72, 78), width=1)
    return img.convert("RGB")


def outro_card() -> Image.Image:
    img = _dark_bg().convert("RGBA")
    d = ImageDraw.Draw(img)
    mark = brand_mark(128, fg=(255, 255, 255))
    img.paste(mark, (int(CANVAS_W / 2 - 64), 292), mark)

    f1 = _font(F_ZH_B, 64)
    t = "执要 Agent"
    d.text(((CANVAS_W - d.textlength(t, font=f1)) / 2, 452), t, font=f1, fill=(255, 255, 255))

    f2 = _font(F_ZH, 38)
    t2 = "Edge 加载项商店搜索「执要 Agent」"
    d.text(((CANVAS_W - d.textlength(t2, font=f2)) / 2, 560), t2, font=f2, fill=(235, 236, 240))

    f3 = _font(F_ZH, 26)
    t3 = "自带 API Key   ·   无服务器   ·   无账号   ·   数据只存本机"
    d.text(((CANVAS_W - d.textlength(t3, font=f3)) / 2, 632), t3, font=f3, fill=(150, 154, 162))
    return img.convert("RGB")


def toast(text_title: str, text_body: str, app: str = "执要 Agent") -> Image.Image:
    """Windows 11 风格系统通知（用于演示定时任务到点提醒）。"""
    W, H = 460, 132
    S = 2
    img = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([6 * S, 8 * S, (W - 6) * S, (H - 6) * S], radius=12 * S,
                        fill=(250, 250, 252, 246), outline=(210, 212, 218, 255), width=S)
    mark = brand_mark(40 * S, fg=(0, 0, 0))
    img.paste(mark, (24 * S, 24 * S), mark)
    f1 = _font(F_ZH, 19 * S)
    d.text((76 * S, 22 * S), app, font=f1, fill=(60, 64, 72))
    f2 = _font(F_ZH_B, 22 * S)
    d.text((76 * S, 50 * S), text_title, font=f2, fill=(20, 20, 22))
    f3 = _font(F_ZH, 19 * S)
    d.text((76 * S, 82 * S), text_body, font=f3, fill=(90, 94, 102))
    return img.resize((W, H), Image.LANCZOS)
