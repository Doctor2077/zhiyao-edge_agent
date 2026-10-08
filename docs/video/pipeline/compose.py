#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""深色悬浮舞台合成器：把「网页 + 侧边栏面板」两张截图，摆成一台浮在暗场里的 Edge 窗口。

画面语言
--------
* **舞台**：近黑渐变 + 两团缓慢漂移的品牌色光晕 + 极细网格 + 暗角。
* **环境背板**：窗口盖不到画布的地方，用窗口自身的超低分辨率模糊放大图垫底
  （Apple 式的 ambient 处理）。镜头推近侧边栏时，两侧不再是死黑，而是主体的
  柔和辉光 —— 这是消除「大片死黑」的关键一层，也是上一版最明显的短板。
* **窗口**：一块悬浮玻璃。圆角 18、重投影、顶缘一道细高光、外圈 1px 描边。
* **字体**：小标签 + 大字标题 + 副标 三段式。大字走遮罩揭幕 + 上浮，
  关键词下方一条品牌渐变横线展开，取代上一版的「圆角药丸字幕」。
* **标注**：聚焦某个元素时整块画布压暗，目标周围走品牌色准星框（四角断口），
  取代上一版的土味红框。

坐标约定
--------
* 窗口空间：窗口左上角为原点，1 单位 = 1 CSS 像素，窗口固定 1600×1000。
* 画布空间：最终 1920×1080 视频帧。

性能约定（必须守住，渲染线程只有 40ms/帧的预算）
------------------------------------------------
* 每个整屏操作都按桶缓存：舞台 4Hz、环境背板只在内容变化时重建、
  窗口三层按机位 key 缓存。逐帧真正做的只有「拷一次底图 + 贴若干缓存层」。
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------- 常量
CANVAS_W, CANVAS_H = 1920, 1080
WIN_W, WIN_H = 1600, 1000
TAB_H, TOOLBAR_H = 40, 40
CHROME_H = TAB_H + TOOLBAR_H          # 80
PAGE_W, PAGE_H = 1220, 920
PANEL_W, PANEL_H = 380, 920
PAGE_ORIGIN = (0, CHROME_H)
PANEL_ORIGIN = (PAGE_W, CHROME_H)

SURFACE_SCALE = 1.5                    # 表面分辨率 / 窗口空间分辨率
SURF_W, SURF_H = int(WIN_W * SURFACE_SCALE), int(WIN_H * SURFACE_SCALE)

# 舞台留白：左右对称，顶部窄，底部留出大字带
PAD_X = 64
PAD_TOP = 52
PAD_BOTTOM = 224                       # 底部大字带，窗口下缘停在它上面

# ---------------------------------------------------------------- 配色
C_BG_TOP = (13, 15, 21)
C_BG_BOT = (5, 6, 9)
ACCENT = (72, 140, 255)                # 品牌蓝
ACCENT2 = (150, 96, 255)               # 紫
ACCENT3 = (0, 196, 255)                # 青
C_TEXT = (243, 246, 252)
C_TEXT_DIM = (138, 148, 168)
C_TEXT_FAINT = (96, 105, 124)

# 贴着 Edge 浅色主题的窗口配色
C_TABBAR = (222, 225, 230)
C_TAB_ACTIVE = (252, 252, 253)
C_TOOLBAR = (247, 248, 250)
C_BORDER = (206, 210, 216)
C_WIN_TEXT = (40, 44, 52)
C_WIN_DIM = (108, 114, 124)
C_URL_BG = (255, 255, 255)

RADIUS = 18                            # 窗口圆角（窗口空间单位）

FONT_DIR = r"C:\Windows\Fonts"
F_UI = os.path.join(FONT_DIR, "segoeui.ttf")
F_UI_B = os.path.join(FONT_DIR, "segoeuib.ttf")
F_ZH = os.path.join(FONT_DIR, "msyh.ttc")
F_ZH_B = os.path.join(FONT_DIR, "msyhbd.ttc")

_font_cache: dict = {}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _font_cache:
        try:
            _font_cache[key] = ImageFont.truetype(path, size)
        except Exception:
            _font_cache[key] = ImageFont.truetype(F_ZH, size)
    return _font_cache[key]


def rounded(draw: ImageDraw.ImageDraw, box, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def text_w(draw: ImageDraw.ImageDraw, s: str, f) -> int:
    return int(draw.textlength(s, font=f))


def ellipsize(draw: ImageDraw.ImageDraw, s: str, f, max_w: int) -> str:
    if text_w(draw, s, f) <= max_w:
        return s
    while s and text_w(draw, s + "…", f) > max_w:
        s = s[:-1]
    return s + "…"


def round_mask(w: int, h: int, tl=0, tr=0, br=0, bl=0) -> Image.Image:
    """生成四角可分别指定半径的圆角遮罩（L 模式）。

    每个角：先盖一块黑方，再用白色 1/4 圆饼把圆角里该保留的那块补回来。
    """
    m = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(m)
    for r, box, rect, a0, a1 in (
        (tl, (0, 0, 2 * tl, 2 * tl), (0, 0, tl, tl), 180, 270),
        (tr, (w - 2 * tr, 0, w, 2 * tr), (w - tr, 0, w, tr), 270, 360),
        (br, (w - 2 * br, h - 2 * br, w, h), (w - br, h - br, w, h), 0, 90),
        (bl, (0, h - 2 * bl, 2 * bl, h), (0, h - bl, bl, h), 90, 180),
    ):
        if r <= 0:
            continue
        d.rectangle(rect, fill=0)
        d.pieslice(box, a0, a1, fill=255)
    return m


# ---------------------------------------------------------------- 文字位图
_text_cache: dict = {}


def text_img(text: str, f, fill, tracking: float = 0.0) -> Image.Image:
    """把一行文字渲染成 RGBA 位图并缓存。tracking 为字距（像素）。"""
    key = (text, id(f), fill, tracking)
    hit = _text_cache.get(key)
    if hit is not None:
        return hit
    if not text:
        img = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
        _text_cache[key] = img
        return img
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    if tracking:
        w = int(sum(probe.textlength(ch, font=f) for ch in text) + tracking * (len(text) - 1))
    else:
        w = int(probe.textlength(text, font=f))
    asc, desc = f.getmetrics()
    img = Image.new("RGBA", (max(1, w + 4), asc + desc + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if tracking:
        x = 2.0
        for ch in text:
            d.text((x, 2), ch, font=f, fill=fill)
            x += probe.textlength(ch, font=f) + tracking
    else:
        d.text((2, 2), text, font=f, fill=fill)
    _text_cache[key] = img
    return img


def ease_out(p: float) -> float:
    return 1.0 - (1.0 - p) ** 3


def ease_io(p: float) -> float:
    return p * p * (3 - 2 * p)


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


# ---------------------------------------------------------------- 镜头
class Camera:
    """在窗口空间里取景，映射到画布。rect = (x, y, w, h)。"""

    x: float = 0.0
    y: float = 0.0
    w: float = WIN_W
    h: float = WIN_H
    tx: float = 0.0
    ty: float = 0.0
    tw: float = WIN_W
    th: float = WIN_H
    dur: float = 0.0
    t0: float = 0.0
    _from: tuple = field(default=(0.0, 0.0, WIN_W, WIN_H))

    def jump(self, rect) -> None:
        self.x, self.y, self.w, self.h = rect
        self.tx, self.ty, self.tw, self.th = rect
        self.dur = 0.0

    def to(self, rect, dur: float, now: float, ease: str = "inout") -> None:
        self._from = (self.x, self.y, self.w, self.h)
        self.tx, self.ty, self.tw, self.th = rect
        self.dur = max(0.001, dur)
        self.t0 = now

    def step(self, now: float) -> None:
        if self.dur <= 0:
            return
        p = min(1.0, (now - self.t0) / self.dur)
        if p >= 1.0:
            self.x, self.y, self.w, self.h = self.tx, self.ty, self.tw, self.th
            self.dur = 0.0
            return
        e = ease_io(p)
        fx, fy, fw, fh = self._from
        self.x = fx + (self.tx - fx) * e
        self.y = fy + (self.ty - fy) * e
        self.w = fw + (self.tw - fw) * e
        self.h = fh + (self.th - fh) * e

    @property
    def scale(self) -> float:
        avail_w = CANVAS_W - PAD_X * 2
        avail_h = CANVAS_H - PAD_TOP - PAD_BOTTOM
        return min(avail_w / max(1.0, self.w), avail_h / max(1.0, self.h))

    def canvas_rect(self):
        """窗口空间取景框 → 画布像素矩形（浮点）。"""
        s = self.scale
        cw, ch = self.w * s, self.h * s
        cx = (CANVAS_W - cw) / 2
        cy = PAD_TOP + (CANVAS_H - PAD_TOP - PAD_BOTTOM - ch) / 2
        return cx, cy, cw, ch

    def map_rect(self, r):
        """把窗口空间的任意矩形映射到画布像素。"""
        s = self.scale
        cx, cy, _, _ = self.canvas_rect()
        return (cx + (r[0] - self.x) * s, cy + (r[1] - self.y) * s, r[2] * s, r[3] * s)


def preset(name: str):
    return {
        "wide":         (0.0, 0.0, float(WIN_W), float(WIN_H)),
        # 页面特写：让窗口**左右同时出血**。窗口 1600 宽，放大到 1.4 倍以上就会
        # 超出画布两侧 —— 宁可整块切出去，也不要露出「半个侧边栏」那种事故切边。
        # 取景中心压在 x≈504 以内，侧边栏（窗口 x 1220 起）就整个落在画布外 ——
        # 页面特写里露出「半个侧边栏」最像事故，宁可不露。
        "page":         (94.0, 90.0, 820.0, 620.0),
        "page_top":     (94.0, 0.0, 820.0, 540.0),
        "page_mid":     (94.0, 300.0, 820.0, 540.0),
        "product":      (134.0, 120.0, 780.0, 600.0),
        "ad_top":       (94.0, 20.0, 820.0, 480.0),
        "ad_inline":    (94.0, 260.0, 820.0, 480.0),
        "float":        (94.0, 420.0, 820.0, 560.0),
        # 面板特写：只从**左侧**出血，让面板整个可见并贴住右缘 ——
        # 「右侧停靠一个面板」这个语义全靠看得见面板的右边和圆角。
        "panel":        (1000.0, 60.0, 560.0, 480.0),
        "panel_zoom":   (1040.0, 150.0, 520.0, 420.0),
        "panel_top":    (1000.0, 0.0, 560.0, 430.0),
        "panel_bottom": (1040.0, 420.0, 520.0, 460.0),
    }[name]


# ---------------------------------------------------------------- 窗口外壳
class Shell:
    """浏览器窗口外壳（标签栏 + 工具栏）。URL / 标题变化时重绘并缓存。"""

    def __init__(self):
        self.cache: dict = {}

    def render(self, url: str, title: str, favicon_rgb=(233, 30, 99)) -> Image.Image:
        key = (url, title, favicon_rgb)
        if key in self.cache:
            return self.cache[key]
        w, h = int(WIN_W * SURFACE_SCALE), int(CHROME_H * SURFACE_SCALE)
        img = Image.new("RGB", (w, h), C_TABBAR)
        d = ImageDraw.Draw(img)
        s = SURFACE_SCALE

        def S(v):
            return int(round(v * s))

        d.rectangle([0, S(TAB_H), w, h], fill=C_TOOLBAR)
        d.line([(0, S(TAB_H)), (w, S(TAB_H))], fill=C_BORDER, width=max(1, S(1)))

        # 活动标签页
        tab_w = S(258)
        tab_h = S(TAB_H + 6)
        rounded(d, [S(10), S(7), S(10) + tab_w, S(7) + tab_h], S(9), fill=C_TAB_ACTIVE)
        fx, fy, fr = S(26), S(18), S(8)
        d.ellipse([fx - fr, fy - fr, fx + fr, fy + fr], fill=favicon_rgb)
        ft = font(F_ZH, int(S(13.5)))
        d.text((S(42), S(11)), ellipsize(d, title, ft, tab_w - S(64)), font=ft, fill=C_WIN_TEXT)
        cx, cy, cr = S(10) + tab_w - S(18), S(18), S(6)
        d.line([(cx - cr * 0.6, cy - cr * 0.6), (cx + cr * 0.6, cy + cr * 0.6)],
               fill=C_WIN_DIM, width=max(1, S(1.4)))
        d.line([(cx - cr * 0.6, cy + cr * 0.6), (cx + cr * 0.6, cy - cr * 0.6)],
               fill=C_WIN_DIM, width=max(1, S(1.4)))
        px, py = S(10) + tab_w + S(20), S(20)
        d.line([(px - S(6), py), (px + S(6), py)], fill=C_WIN_DIM, width=max(1, S(1.6)))
        d.line([(px, py - S(6)), (px, py + S(6))], fill=C_WIN_DIM, width=max(1, S(1.6)))

        for i, glyph in enumerate(("—", "□", "×")):
            xx = w - S(120) + i * S(40)
            d.text((xx, S(13)), glyph, font=font(F_UI, int(S(12))), fill=C_WIN_DIM)

        # 工具栏：前进/后退/刷新
        ty = S(TAB_H + 20)
        for i, kind in enumerate(("back", "fwd", "reload")):
            ax = S(30) + i * S(38)
            col = C_WIN_TEXT if i < 2 else C_WIN_DIM
            if kind == "back":
                d.line([(ax + S(4), ty - S(5)), (ax - S(4), ty), (ax + S(4), ty + S(5))],
                       fill=col, width=max(1, S(1.8)), joint="curve")
            elif kind == "fwd":
                d.line([(ax - S(4), ty - S(5)), (ax + S(4), ty), (ax - S(4), ty + S(5))],
                       fill=col, width=max(1, S(1.8)), joint="curve")
            else:
                d.arc([ax - S(6), ty - S(6), ax + S(6), ty + S(6)], start=40, end=330,
                      fill=col, width=max(1, S(1.6)))
                d.polygon([(ax + S(5), ty - S(8)), (ax + S(9), ty - S(2)), (ax + S(2), ty - S(1))],
                          fill=col)

        # 地址栏
        ab_x0, ab_x1 = S(150), w - S(300)
        rounded(d, [ab_x0, S(TAB_H + 7), ab_x1, S(TAB_H + 33)], S(13), fill=C_URL_BG,
                outline=(226, 229, 234), width=max(1, S(1)))
        lx, ly = ab_x0 + S(16), S(TAB_H + 20)
        d.arc([lx - S(5), ly - S(7), lx + S(5), ly + S(3)], start=180, end=360,
              fill=(90, 96, 106), width=max(1, S(1.5)))
        rounded(d, [lx - S(6), ly - S(1), lx + S(6), ly + S(7)], S(2), fill=(90, 96, 106))
        fu = font(F_UI, int(S(13)))
        d.text((ab_x0 + S(32), S(TAB_H + 12)),
               ellipsize(d, url, fu, ab_x1 - ab_x0 - S(70)), font=fu, fill=(52, 58, 66))
        sx = ab_x1 + S(24)
        d.polygon(_star(sx, S(TAB_H + 20), S(7), S(3.2)), fill=None, outline=C_WIN_DIM)

        ex = w - S(250)
        for i in range(2):
            d.rounded_rectangle([ex + i * S(30) - S(7), S(TAB_H + 13),
                                 ex + i * S(30) + S(7), S(TAB_H + 27)],
                                radius=S(3), outline=C_WIN_DIM, width=max(1, S(1.3)))
        ax = w - S(186)
        d.ellipse([ax - S(9), S(TAB_H + 11), ax + S(9), S(TAB_H + 29)], fill=(120, 150, 200))
        d.text((ax - S(4), S(TAB_H + 14)), "Z", font=font(F_UI_B, int(S(10))), fill=(255, 255, 255))
        mx = w - S(150)
        for i in range(3):
            d.ellipse([mx - S(2), S(TAB_H + 14) + i * S(5), mx + S(2), S(TAB_H + 18) + i * S(5)],
                      fill=C_WIN_DIM)

        d.line([(0, h - 1), (w, h - 1)], fill=C_BORDER, width=max(1, S(1)))
        self.cache[key] = img
        return img


def _star(cx, cy, r_out, r_in):
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


# ---------------------------------------------------------------- 光标
def cursor_image(scale: float = 1.0) -> Image.Image:
    """带白色描边的箭头光标（深色舞台上必须描边才看得清）。"""
    w, h = int(30 * scale), int(42 * scale)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [(2, 1), (2, 34), (11, 26), (17, 39), (23, 36), (17, 24), (28, 23)]
    poly = [(x * scale, y * scale) for x, y in pts]
    d.polygon(poly, fill=(28, 32, 40), outline=(255, 255, 255),
              width=max(1, int(2.2 * scale)))
    return img


class Cursor:
    def __init__(self):
        self.x = 0.0
        self.y = 0.0
        self.fx = 0.0
        self.fy = 0.0
        self.tx = 0.0
        self.ty = 0.0
        self.dur = 0.0
        self.t0 = 0.0
        self.press_at = -9.0
        self._imgs: dict = {}

    def image(self, scale: float) -> Image.Image:
        k = round(scale, 2)
        if k not in self._imgs:
            self._imgs[k] = cursor_image(k)
        return self._imgs[k]

    def move_to(self, x, y, dur, now):
        self.fx, self.fy = self.x, self.y
        self.tx, self.ty = x, y
        self.dur = max(0.001, dur)
        self.t0 = now

    def jump(self, x, y):
        self.x = self.fx = self.tx = x
        self.y = self.fy = self.ty = y
        self.dur = 0.0

    def click(self, now):
        self.press_at = now

    def step(self, now):
        if self.dur <= 0:
            return
        p = min(1.0, (now - self.t0) / self.dur)
        e = ease_io(p)
        self.x = self.fx + (self.tx - self.fx) * e
        self.y = self.fy + (self.ty - self.fy) * e
        if p >= 1.0:
            self.dur = 0.0

    def draw(self, canvas: Image.Image, now: float, scale: float = 1.0) -> None:
        img = self.image(scale)
        # 点击：一圈快速扩散的品牌色涟漪
        age = now - self.press_at
        if 0.0 <= age <= 0.5:
            r = int((8 + 46 * ease_out(age / 0.5)) * scale)
            ring = Image.new("RGBA", (r * 2 + 4, r * 2 + 4), (0, 0, 0, 0))
            ImageDraw.Draw(ring).ellipse([2, 2, r * 2, r * 2],
                                         outline=(*ACCENT3, int(190 * (1 - age / 0.5))),
                                         width=max(1, int(2.4 * scale)))
            canvas.paste(ring.convert("RGB"), (int(self.x - r), int(self.y - r)), ring.split()[3])
        canvas.paste(img.convert("RGB"), (int(self.x), int(self.y)), img.split()[3])


# ---------------------------------------------------------------- 大字排版
class TypeBlock:
    """小标签 + 大字标题 + 副标，走遮罩揭幕 + 上浮的入场。"""

    ENTRY = 0.66

    def __init__(self):
        self.kicker = ""
        self.headline = ""
        self.sub = ""
        self.t0 = -9.0
        self.pos = "bottom"
        self._last_sig = None
        self._scrim_cache: dict = {}
        self._rule_cache: dict = {}

    def set_headline(self, text: str, kicker: str = "", now: float = 0.0, pos: str = None) -> None:
        sig = (text, kicker, pos or self.pos)
        if pos:
            self.pos = pos
        if sig == self._last_sig:
            return
        self._last_sig = sig
        self.headline, self.kicker = text, kicker
        self.t0 = now

    def set_sub(self, text: str, now: float = 0.0) -> None:
        if text == self.sub:
            return
        self.sub = text
        self.t0 = now

    # ---- 布局
    def _anchor(self, total_h: int):
        if self.pos == "left":
            return 104, int(CANVAS_H * 0.40 - total_h / 2)
        if self.pos == "center":
            return None, int(CANVAS_H * 0.62 - total_h / 2)
        return 104, CANVAS_H - 46 - total_h          # bottom：整个块贴着下缘往上排

    def _scrim(self, top: int, left: bool = False) -> Image.Image:
        """大字底下的渐变蒙版。只在窗口真的压到大字带时才铺 ——
        「全景」那种窗口已经让开的情况铺了反而脏。"""
        key = (top, left)
        hit = self._scrim_cache.get(key)
        if hit is not None:
            return hit
        if left:
            w = 1080
            t = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :]
            a = np.clip((1.0 - t) / 0.52, 0, 1) ** 0.62 * 234
            arr = np.zeros((CANVAS_H, w, 4), dtype=np.uint8)
            arr[:, :, 3] = np.repeat(a.astype(np.uint8), CANVAS_H, axis=0)
        else:
            h = max(2, CANVAS_H - top)
            t = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None]
            a = np.clip(t / 0.52, 0, 1) ** 0.62 * 234
            arr = np.zeros((h, CANVAS_W, 4), dtype=np.uint8)
            arr[:, :, 3] = np.repeat(a.astype(np.uint8), CANVAS_W, axis=1)
        arr[:, :, 0], arr[:, :, 1], arr[:, :, 2] = 4, 5, 9
        img = Image.fromarray(arr, "RGBA")
        # 直接缓存 (RGB, alpha) 两半：每帧再 convert+split 一遍是全画布级的浪费
        out = (img.convert("RGB"), img.split()[3])
        self._scrim_cache[key] = out
        return out

    def draw(self, canvas: Image.Image, now: float, win_rect=None) -> None:
        if not self.headline and not self.kicker and not self.sub:
            return
        p = clamp01((now - self.t0) / self.ENTRY)

        f_kick = font(F_ZH_B, 21)
        f_head = font(F_ZH_B, 62)
        f_sub = font(F_ZH, 25)

        kick_img = text_img(self.kicker, f_kick, (*ACCENT3, 255), tracking=3.0) if self.kicker else None
        head_img = text_img(self.headline, f_head, (*C_TEXT, 255), tracking=1.5) if self.headline else None
        sub_img = text_img(self.sub, f_sub, (*C_TEXT_DIM, 255), tracking=0.6) if self.sub else None

        gap_k, gap_h = 14, 20
        h_kick = kick_img.height if kick_img else 0
        h_head = head_img.height if head_img else 0
        h_sub = sub_img.height if sub_img else 0
        total = h_kick + (gap_k if h_kick and h_head else 0) + h_head \
            + (gap_h if h_head and h_sub else 0) + h_sub

        ax, ay = self._anchor(total)
        if ax is None:                      # 居中：按最宽的一行定 x
            wide = max([im.width for im in (kick_img, head_img, sub_img) if im], default=0)
            ax = (CANVAS_W - wide) // 2

        # 全部直接贴到画布上：之前先攒一张全画布 RGBA 再整体合成，
        # 每帧白搭两次 1920×1080 的转换，是渲染轮最贵的一笔开销。
        if win_rect is not None:
            wx, wy, ww, wh = win_rect
            if self.pos == "left":
                if wx < ax + 1040:
                    rgb, a = self._scrim(0, True)
                    canvas.paste(rgb, (0, 0), a)
            elif self.pos == "bottom" and wy + wh > ay:
                # 蒙版高度跟着「窗口压进来多深」走：只压进来一点点就别糊一大片
                lead = int(min(280.0, 90.0 + (wy + wh - ay) * 1.4))
                top = max(0, ay - lead)
                rgb, a = self._scrim(top)
                canvas.paste(rgb, (0, top), a)
        y = ay

        def place(im: Image.Image, delay: float, rise: float):
            nonlocal y
            if im is None:
                return
            q = clamp01((p - delay) / max(0.001, 1.0 - delay))
            q = ease_out(q)
            if q <= 0.002:
                y += im.height
                return
            yy = int(y + (1 - q) * rise)
            # 遮罩揭幕：只露出上面 q 这一段，像被「揭」出来
            cut = max(1, int(im.height * q))
            piece = im.crop((0, 0, im.width, cut))
            a = piece.split()[3].point(lambda v: int(v * min(1.0, q * 1.8)))
            canvas.paste(piece.convert("RGB"), (ax, yy), a)
            y += im.height

        place(kick_img, 0.00, 12)
        if h_kick and h_head:
            y += gap_k
        place(head_img, 0.10, 26)
        if h_head and h_sub:
            y += gap_h
        place(sub_img, 0.40, 16)

        # 品牌渐变横线：在大字下方展开（渐变本身按宽度缓存）
        if h_head:
            line_y = ay + h_kick + (gap_k if h_kick else 0) + h_head + 10
            q = ease_out(clamp01((p - 0.30) / 0.55))
            if q > 0.01:
                grad = self._rule(max(1, int(132 * q)))
                canvas.paste(grad.convert("RGB"), (ax, line_y), grad.split()[3])

    def _rule(self, w: int) -> Image.Image:
        """品牌渐变横线，按宽度缓存 —— 每帧递减一变，重画不划算。"""
        hit = self._rule_cache.get(w)
        if hit is not None:
            return hit
        grad = Image.new("RGBA", (w, 3), (0, 0, 0, 0))
        gd = ImageDraw.Draw(grad)
        for i in range(w):
            t = i / max(1, w - 1)
            col = tuple(int(ACCENT[j] + (ACCENT2[j] - ACCENT[j]) * t) for j in range(3))
            gd.line([(i, 0), (i, 2)], fill=(*col, 255))
        self._rule_cache[w] = grad
        return grad


# ---------------------------------------------------------------- 聚光标注
class Highlights:
    """聚焦标注：整块画布压暗，目标周围走品牌色准星框（四角断口）。"""

    def __init__(self):
        self.items: list = []
        self._dim_key = None
        self._dim_img = None
        self._dim_pos = None

    def add(self, rect, now, dur: float = 2.2, color=(72, 140, 255)):
        self.items.append({"rect": rect, "t0": now, "dur": dur, "color": color})

    def prune(self, now):
        self.items = [it for it in self.items if now - it["t0"] < it["dur"] + 0.22]

    def _active(self, now):
        best = None
        for it in self.items:
            age = now - it["t0"]
            if age < 0:
                continue
            a = clamp01(age / 0.26) * clamp01((it["dur"] + 0.22 - age) / 0.34)
            if a <= 0.02:
                continue
            if best is None or a > best[0]:
                best = (a, it, age)
        return best

    DIM_Q = 4          # 压暗层按 1/4 分辨率建再放大

    def _dim(self, cam: Camera, rect_key, alpha: int):
        """整屏压暗层：目标处开一个圆角洞，边缘羽化。

        关键是别在全分辨率上做高斯模糊 —— 1920×1080 的 GaussianBlur(16) 单帧要
        170ms，是整条渲染链的头号开销。糊一张四分之一大小的再放大，肉眼无差。
        alpha 再分个桶：淡入淡出时它每帧都在变，不分桶缓存等于全失效。
        """
        q = self.DIM_Q
        ab = max(0, min(255, int(alpha) // 6)) * 6
        key = (round(cam.x, 1), round(cam.y, 1), round(cam.w, 1), round(cam.h, 1),
               rect_key, ab)
        if key == self._dim_key:
            return self._dim_img
        m = Image.new("L", (CANVAS_W // q, CANVAS_H // q), ab)
        d = ImageDraw.Draw(m)
        x, y, w, h = rect_key
        d.rounded_rectangle([x / q, y / q, (x + w) / q, (y + h) / q],
                            radius=max(1, 14 // q), fill=0)
        m = m.filter(ImageFilter.GaussianBlur(4)).resize((CANVAS_W, CANVAS_H), Image.BILINEAR)
        self._dim_key, self._dim_img = key, m
        return m

    def draw(self, canvas: Image.Image, cam: Camera, now: float) -> None:
        act = self._active(now)
        if act is None:
            return
        a, it, age = act
        x, y, w, h = cam.map_rect(it["rect"])
        pad = 16
        rx, ry = x - pad, y - pad
        rw, rh = w + pad * 2, h + pad * 2
        rk = (int(rx), int(ry), int(rw), int(rh))
        col = tuple(it["color"])

        mask = self._dim(cam, rk, int(118 * a))
        canvas.paste(Image.new("RGB", (CANVAS_W, CANVAS_H), (3, 4, 7)), (0, 0), mask)

        # 目标外圈一层品牌色辉光
        glow = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
        ImageDraw.Draw(glow).rounded_rectangle([rx, ry, rx + rw, ry + rh], radius=14,
                                               outline=(*col, int(96 * a)), width=7)
        glow = glow.filter(ImageFilter.GaussianBlur(9))
        canvas.paste(glow.convert("RGB"), (0, 0), glow.split()[3])

        # 准星框：四角断口，画入时按角依次展开
        d = ImageDraw.Draw(canvas)
        seg = min(34.0, rw * 0.24, rh * 0.24)
        grow = ease_out(clamp01(age / 0.30))
        seg = seg * grow
        lw = max(2, int(2.6 * a) if a > 0.4 else 2)
        stroke = tuple(int(c * (0.35 + 0.65 * a)) for c in col)
        for cx0, cy0, dx, dy in ((rx, ry, 1, 1), (rx + rw, ry, -1, 1),
                                 (rx, ry + rh, 1, -1), (rx + rw, ry + rh, -1, -1)):
            d.line([(cx0, cy0), (cx0 + dx * seg, cy0)], fill=stroke, width=lw)
            d.line([(cx0, cy0), (cx0, cy0 + dy * seg)], fill=stroke, width=lw)


# ---------------------------------------------------------------- 合成器
class Compositor:
    def __init__(self, page_shot: Image.Image, panel_shot: Image.Image,
                 url: str = "", title: str = "", favicon=(0, 120, 212)):
        self.page = page_shot.convert("RGB")
        self.panel = panel_shot.convert("RGB")
        self.page_v = 0
        self.panel_v = 0
        self.url, self.title, self.favicon = url, title, favicon
        self.panel_slide = 0.0
        self.toast = None
        self.card = None

        self.cam = Camera()
        self.cursor = Cursor()
        self.type = TypeBlock()
        self.highlights = Highlights()
        self.shell = Shell()

        # 对外保留 record.py 已经在用的两个入口
        self.caption = _SubProxy(self.type)
        self.headline = _HeadlineProxy(self.type)

        self._page_key = self._page_piece = None
        self._chrome_key = self._chrome_piece = None
        self._shadow_key = None
        self._shadow_img = self._shadow_mask = self._shadow_pos = None
        self._pnl_key = self._pnl_piece = None
        self._rim_cache: dict = {}

        self._stage_key = None
        self._stage_cache = None
        self._amb_key = None
        self._amb_img = None
        self._amb_pos = (0, 0)

        self._build_stage()
        self._build_ambient_mask()

    # ---- 底子：渐变 + 细网格 + 暗角
    def _build_stage(self) -> None:
        t = np.linspace(0.0, 1.0, CANVAS_H, dtype=np.float32)[:, None]
        top = np.array(C_BG_TOP, dtype=np.float32)
        bot = np.array(C_BG_BOT, dtype=np.float32)
        col = top[None, :] + (bot - top)[None, :] * t          # (H,3)
        img = np.repeat(col[:, None, :], CANVAS_W, axis=1)     # (H,W,3)

        # 暗角：径向压暗，中心留亮
        yy, xx = np.mgrid[0:CANVAS_H, 0:CANVAS_W].astype(np.float32)
        nx = (xx - CANVAS_W / 2) / (CANVAS_W / 2)
        ny = (yy - CANVAS_H / 2) / (CANVAS_H / 2)
        r = np.sqrt(nx * nx + ny * ny)
        vig = np.clip(1.0 - 0.42 * np.clip(r - 0.35, 0, None) ** 1.5, 0.0, 1.0)[:, :, None]
        img = img * vig

        self._bg_base = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")

        # 细网格：每 72px 一道，极淡
        grid = Image.new("L", (CANVAS_W, CANVAS_H), 0)
        gd = ImageDraw.Draw(grid)
        for x in range(0, CANVAS_W, 72):
            gd.line([(x, 0), (x, CANVAS_H)], fill=9)
        for y in range(0, CANVAS_H, 72):
            gd.line([(0, y), (CANVAS_W, y)], fill=9)
        self._bg_base.paste(Image.new("RGB", (CANVAS_W, CANVAS_H), (150, 170, 210)),
                            (0, 0), grid)

        # 光晕：两张超采样的软斑，逐帧按不同速度漂移
        self._auroras = []
        for seed, col_a in ((0.0, ACCENT), (2.1, ACCENT2)):
            A = CANVAS_W + 96          # 只留漂移需要的余量，别多糊一大圈（每帧都要合成）
            B = CANVAS_H + 96
            yy2, xx2 = np.mgrid[0:B, 0:A].astype(np.float32)
            acc = np.zeros((B, A), dtype=np.float32)
            for k in range(3):
                ang = seed + k * 2.3
                cx = A * (0.5 + 0.34 * math.cos(ang))
                cy = B * (0.5 + 0.30 * math.sin(ang * 0.8 + seed))
                rad = A * (0.20 + 0.07 * k)
                acc += np.exp(-(((xx2 - cx) ** 2 + (yy2 - cy) ** 2) / (2 * rad * rad)))
            acc = np.clip(acc, 0, 1.6) / 1.6
            a8 = (acc * 118).astype(np.uint8)
            lay = np.zeros((B, A, 3), dtype=np.uint8)
            lay[:, :, 0] = int(col_a[0] * 0.42)
            lay[:, :, 1] = int(col_a[1] * 0.42)
            lay[:, :, 2] = int(col_a[2] * 0.42)
            im = Image.fromarray(lay, "RGB").convert("RGBA")
            im.putalpha(Image.fromarray(a8, "L"))
            self._auroras.append(im)

    def _build_ambient_mask(self) -> None:
        """环境背板的贴图遮罩：中间实、四周透明，让光晕从边缘透出来。"""
        yy, xx = np.mgrid[0:CANVAS_H, 0:CANVAS_W].astype(np.float32)
        nx = (xx - CANVAS_W / 2) / (CANVAS_W / 2)
        ny = (yy - CANVAS_H / 2) / (CANVAS_H / 2)
        r = np.sqrt(nx * nx + ny * ny)
        a = np.clip(1.0 - (r / 1.05) ** 2.2, 0.0, 1.0) * 232
        self._amb_mask = Image.fromarray(a.astype(np.uint8), "L")

    def _stage(self, now: float) -> Image.Image:
        """舞台底 + 漂移光晕 + 环境背板，按 4Hz 出桶缓存。"""
        bucket = int(now * 4.0)
        if bucket == self._stage_key and self._stage_cache is not None:
            return self._stage_cache
        img = self._bg_base.copy()
        for i, aur in enumerate(self._auroras):
            sp = 7.0 + i * 5.0
            dx = int(math.sin(now * 0.055 + i * 1.7) * sp) - (aur.width - CANVAS_W) // 2
            dy = int(math.cos(now * 0.043 + i * 0.9) * sp) - (aur.height - CANVAS_H) // 2
            img.paste(aur.convert("RGB"), (dx, dy), aur.split()[3])
        if self._amb_img is not None:
            img.paste(self._amb_img, self._amb_pos, self._amb_mask)
        self._stage_key, self._stage_cache = bucket, img
        return img

    def _build_ambient(self) -> None:
        """把窗口内容压成超低分辨率模糊图，铺满画布 —— 消除死黑的关键。"""
        k = 12
        sw, sh = WIN_W // k, WIN_H // k
        small = Image.new("RGB", (sw, sh), (10, 11, 15))
        try:
            small.paste(self.page.resize((PAGE_W // k, PAGE_H // k), Image.BILINEAR),
                        (0, CHROME_H // k))
            if self.panel_slide > 0.02:
                small.paste(self.panel.resize((PANEL_W // k, PANEL_H // k), Image.BILINEAR),
                            (PAGE_W // k, CHROME_H // k))
        except Exception:
            pass
        small = small.filter(ImageFilter.GaussianBlur(2.4))
        sc = max(CANVAS_W / sw, CANVAS_H / sh) * 1.06
        tw, th = int(sw * sc), int(sh * sc)
        amb = small.resize((tw, th), Image.BILINEAR)
        amb = Image.blend(amb, Image.new("RGB", amb.size, (7, 8, 12)), 0.72)
        # 裁到画布尺寸，与 _amb_mask 对齐
        ox, oy = (tw - CANVAS_W) // 2, (th - CANVAS_H) // 2
        self._amb_img = amb.crop((ox, oy, ox + CANVAS_W, oy + CANVAS_H))
        self._amb_pos = (0, 0)

    # ---- 窗口表面
    def set_layers(self, page: Image.Image | None = None, panel: Image.Image | None = None):
        if page is not None:
            self.page = page.convert("RGB")
            self.page_v += 1
        if panel is not None:
            self.panel = panel.convert("RGB")
            self.panel_v += 1

    def set_page_meta(self, url: str, title: str, favicon=(0, 120, 212)):
        self.url, self.title, self.favicon = url, title, favicon
        self._amb_key = None                     # 换页立刻重建环境背板

    def _cam_key(self):
        return (round(self.cam.x, 2), round(self.cam.y, 2),
                round(self.cam.w, 2), round(self.cam.h, 2))

    def _win_rect(self):
        """整个窗口（含外壳与面板）在画布上的矩形（浮点，可能远大于画布）。"""
        return self.cam.map_rect((0.0, 0.0, float(WIN_W), float(WIN_H)))

    def _shadow_layer(self):
        """窗口投影。跟着**窗口**而不是取景框走，并裁到画布 —— 推近时窗口很大，
        不裁的话每帧要糊一张几千像素的位图。"""
        key = self._cam_key()
        if self._shadow_key == key:
            return self._shadow_img, self._shadow_mask, self._shadow_pos
        wx, wy, ww, wh = self._win_rect()
        # 窗口已经盖满画布时投影一点都露不出来，省掉一次全画布合成（推近时总是如此）
        if wx <= 0 and wy <= 0 and wx + ww >= CANVAS_W and wy + wh >= CANVAS_H:
            self._shadow_img = self._shadow_mask = self._shadow_pos = None
            self._shadow_key = key
            return None, None, None
        pad, q = 92, 6
        x0, y0 = int(round(wx)) - pad, int(round(wy)) - pad
        x1, y1 = int(round(wx + ww)) + pad, int(round(wy + wh)) + pad
        cx0, cy0 = max(0, x0), max(0, y0)
        cx1, cy1 = min(CANVAS_W, x1), min(CANVAS_H, y1)
        if cx1 <= cx0 or cy1 <= cy0:
            self._shadow_img = self._shadow_mask = self._shadow_pos = None
            self._shadow_key = key
            return None, None, None
        W, H = cx1 - cx0, cy1 - cy0
        small = Image.new("L", (max(1, (W + q - 1) // q), max(1, (H + q - 1) // q)), 0)
        rounded(ImageDraw.Draw(small),
                [(wx - cx0) / q, (wy - cy0) / q, (wx + ww - cx0) / q, (wy + wh - cy0) / q],
                max(1, RADIUS * self.cam.scale / q), fill=215)
        small = small.filter(ImageFilter.GaussianBlur(7)).resize((W, H), Image.BILINEAR)
        self._shadow_img = Image.new("RGB", (W, H), (0, 0, 0))
        self._shadow_mask = small
        self._shadow_pos = (cx0, cy0)
        self._shadow_key = key
        return self._shadow_img, self._shadow_mask, self._shadow_pos

    def _render_piece(self, src: Image.Image, win_rect, corners=()):
        """把一块「窗口空间的面」按当前机位映射成「要贴的那一块」。

        只裁出画布可见的那一块再做缩放 —— 推近时机位外的部分完全不参与运算，
        这是推拉镜头还能跑得动的关键。corners 里列出的窗口外角会在这一块上补圆角。
        返回 (piece, (x, y))，完全在画布外时返回 None。
        """
        SW, SH = src.size
        cx, cy, cw, ch = self.cam.map_rect(win_rect)
        if cw <= 0.5 or ch <= 0.5:
            return None
        px0, py0 = max(0, int(math.floor(cx))), max(0, int(math.floor(cy)))
        px1, py1 = min(CANVAS_W, int(math.ceil(cx + cw))), min(CANVAS_H, int(math.ceil(cy + ch)))
        if px1 <= px0 or py1 <= py0:
            return None
        sx0 = max(0, int((px0 - cx) / cw * SW))
        sy0 = max(0, int((py0 - cy) / ch * SH))
        sx1 = min(SW, int(math.ceil((px1 - cx) / cw * SW)))
        sy1 = min(SH, int(math.ceil((py1 - cy) / ch * SH)))
        if sx1 <= sx0 or sy1 <= sy0:
            return None
        piece = src.crop((sx0, sy0, sx1, sy1)).resize((px1 - px0, py1 - py0), Image.BILINEAR)

        if corners:
            wx, wy = cx, cy                       # 这块面的左上角在画布上的位置
            r = max(1, int(round(RADIUS * self.cam.scale)))
            # 窗口角不在这一块里（推近时几乎总是）就别建遮罩 —— 省一次整块 RGBA 合成
            corners = tuple(c for c in corners if (
                (px0 - r <= wx <= px1 + r if c in ("tl", "bl") else px0 - r <= wx + cw <= px1 + r)
                and (py0 - r <= wy <= py1 + r if c in ("tl", "tr") else py0 - r <= wy + ch <= py1 + r)))
        if corners:
            r = max(1, int(round(RADIUS * self.cam.scale)))
            m = Image.new("L", piece.size, 255)
            d = ImageDraw.Draw(m)
            for c in corners:
                if c == "tl":
                    ccx, ccy = wx - px0, wy - py0
                    d.rectangle([ccx - piece.width, ccy - piece.height, ccx, ccy], fill=0)
                    d.pieslice([ccx, ccy, ccx + 2 * r, ccy + 2 * r], 180, 270, fill=255)
                elif c == "tr":
                    ccx, ccy = wx + cw - px0, wy - py0
                    d.rectangle([ccx, ccy - piece.height, ccx + piece.width, ccy], fill=0)
                    d.pieslice([ccx - 2 * r, ccy, ccx, ccy + 2 * r], 270, 360, fill=255)
                elif c == "bl":
                    ccx, ccy = wx - px0, wy + ch - py0
                    d.rectangle([ccx - piece.width, ccy, ccx, ccy + piece.height], fill=0)
                    d.pieslice([ccx, ccy - 2 * r, ccx + 2 * r, ccy], 90, 180, fill=255)
                elif c == "br":
                    ccx, ccy = wx + cw - px0, wy + ch - py0
                    d.rectangle([ccx, ccy, ccx + piece.width, ccy + piece.height], fill=0)
                    d.pieslice([ccx - 2 * r, ccy - 2 * r, ccx, ccy], 0, 90, fill=255)
            base = Image.new("RGB", piece.size, (255, 255, 255))
            base.paste(piece, (0, 0), m)
            piece = base
        return piece, (px0, py0)

    def _place(self, canvas, src: Image.Image, win_rect, corners=()):
        r = self._render_piece(src, win_rect, corners)
        if r is not None:
            canvas.paste(r[0], r[1])
        return r

    def _chrome_layer(self):
        key = (self._cam_key(), self.url, self.title, self.favicon)
        if self._chrome_key == key:
            return self._chrome_piece
        self._chrome_piece = self._render_piece(
            self.shell.render(self.url, self.title, self.favicon),
            (0.0, 0.0, float(WIN_W), float(CHROME_H)), ("tl", "tr"))
        self._chrome_key = key
        return self._chrome_piece

    def _page_layer(self):
        key = (self._cam_key(), self.page_v)
        if self._page_key == key:
            return self._page_piece
        self._page_piece = self._render_piece(
            self.page, (0.0, float(CHROME_H), float(PAGE_W), float(PAGE_H)), ("bl",))
        self._page_key = key
        return self._page_piece

    def _panel_layer(self):
        p = max(0.0, min(1.0, self.panel_slide))
        if p <= 0.002:
            return None
        # 源画面 30fps 而成片 120fps —— 同一块面板会被连续贴上 4 次，必须缓存
        key = (self._cam_key(), self.panel_v, round(p, 4))
        if self._pnl_key == key:
            return self._pnl_piece
        x = PANEL_ORIGIN[0] + PANEL_W * (1.0 - p)
        self._pnl_piece = self._render_piece(
            self.panel, (x, float(PANEL_ORIGIN[1]), float(PANEL_W), float(PANEL_H)),
            ("br",) if p > 0.985 else ())
        self._pnl_key = key
        return self._pnl_piece

    def panel_canvas_rect(self):
        p = max(0.0, min(1.0, self.panel_slide))
        x = PANEL_ORIGIN[0] + PANEL_W * (1.0 - p)
        return self.cam.map_rect((x, PANEL_ORIGIN[1], PANEL_W, PANEL_H))

    def _rim_light(self, img: Image.Image) -> None:
        """窗口顶缘一道中间亮、两端收的细高光 —— 玻璃感全靠它。"""
        wx, wy, ww, wh = self._win_rect()
        ry = int(round(wy))
        if not (0 <= ry < CANVAS_H - 2) or ww <= 40:
            return
        rx0, rx1 = max(0, int(round(wx))), min(CANVAS_W, int(round(wx + ww)))
        if rx1 - rx0 < 8:
            return
        phase = int((rx0 - wx) / max(1.0, ww) * 100)
        key = (rx1 - rx0, phase)
        rim = self._rim_cache.get(key)
        if rim is None:
            rim = Image.new("RGBA", (rx1 - rx0, 3), (0, 0, 0, 0))
            rd = ImageDraw.Draw(rim)
            for i in range(rim.width):
                t = min(1.0, max(0.0, (rx0 + i - wx) / max(1.0, ww)))
                a = int(58 * math.sin(math.pi * t) ** 0.7)
                rd.line([(i, 0), (i, 1)], fill=(255, 255, 255, a))
            if len(self._rim_cache) > 64:
                self._rim_cache.clear()
            self._rim_cache[key] = rim
        img.paste(rim.convert("RGB"), (rx0, ry), rim.split()[3])

    def advance(self, now: float) -> None:
        """只推进缓动、不渲染。采集轮用它以 120Hz 采样镜头/光标状态。"""
        self.cam.step(now)
        self.cursor.step(now)

    # ---- 逐帧
    def frame(self, now: float, dt: float) -> Image.Image:
        self.cam.step(now)
        self.cursor.step(now)
        self.highlights.prune(now)

        # 内容变化时重建环境背板（开销大，所以只在换页/面板开合时做）
        amb_key = (self.url, self.title, self.panel_slide > 0.5)
        if amb_key != self._amb_key:
            self._amb_key = amb_key
            self._build_ambient()
            self._stage_key = None

        img = self._stage(now).copy()

        sh = self._shadow_layer()
        if sh[0] is not None:
            img.paste(sh[0], sh[2], sh[1])

        panel_piece = self._panel_layer()
        for piece in (self._chrome_layer(), self._page_layer()):
            if piece is not None:
                img.paste(piece[0], piece[1])

        # 面板左缘一道细阴影，让侧边栏「立」起来（要压在面板下面，所以先贴阴影）
        if panel_piece is not None and self.panel_slide > 0.02:
            piece, (ppx, ppy) = panel_piece
            sw_ = max(2, int(round(10 * self.cam.scale)))
            sh_ = Image.new("L", (sw_, piece.height), 0)
            sd = ImageDraw.Draw(sh_)
            for i in range(sw_):
                sd.line([(i, 0), (i, piece.height)], fill=int(76 * (1 - i / sw_)))
            img.paste(Image.new("RGB", (sw_, piece.height), (0, 0, 0)),
                      (ppx - sw_, ppy), sh_)
            img.paste(piece, (ppx, ppy))

        self._rim_light(img)

        self.highlights.draw(img, self.cam, now)

        if self.toast is not None:
            t_img, tx, ty, ta = self.toast
            if ta > 0.01:
                mask = t_img.split()[3].point(lambda v: int(v * ta))
                img.paste(t_img.convert("RGB"), (int(tx), int(ty)), mask)

        self.cursor.draw(img, now, scale=max(0.9, min(1.5, self.cam.scale * 1.25)))
        self.type.draw(img, now, self._win_rect())

        if self.card is not None:
            c_img, ca = self.card
            k = min(1.0, ca)
            if k > 0.004:
                if k < 0.995:            # 入场时轻微「收一收」，比干巴巴淡入高级得多
                    s = 1.0 + 0.05 * (1.0 - k)
                    w, h = int(CANVAS_W * s), int(CANVAS_H * s)
                    big = c_img.convert("RGB").resize((w, h), Image.BILINEAR)
                    ox, oy = (w - CANVAS_W) // 2, (h - CANVAS_H) // 2
                    c_img = big.crop((ox, oy, ox + CANVAS_W, oy + CANVAS_H))
                img = Image.blend(img, c_img.convert("RGB"), k)
        return img


# ---------------------------------------------------------------- 对内适配
class _SubProxy:
    """record.py 里的 comp.caption.set(text, now) —— 对应副标那一行。"""

    def __init__(self, tb: TypeBlock):
        self.tb = tb

    def set(self, text: str, now: float = 0.0) -> None:
        self.tb.set_sub(text or "", now)

    def step(self, now: float, dt: float) -> None:
        pass

    def draw(self, canvas: Image.Image) -> None:
        pass


class _HeadlineProxy:
    """comp.headline.set(text, kicker, now, pos) —— 对应大字那一行。"""

    def __init__(self, tb: TypeBlock):
        self.tb = tb

    def set(self, text: str, kicker: str = "", now: float = 0.0, pos: str = "bottom") -> None:
        self.tb.set_headline(text or "", kicker or "", now, pos)
