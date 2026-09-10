#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画面合成器：把「网页 + 侧边栏面板」两张截图，拼成一台虚拟 Edge 窗口。

设计要点
--------
* **窗口空间**固定为 1600×1000（标签栏 40 + 工具栏 40 + 内容区 920），
  镜头（Camera）在这个空间里取景并映射到 1920×1080 画布 —— 于是推拉摇移
  全部变成一次矩形变换，不需要真的缩放浏览器。
* 页面与面板分别按 DSF 采集（页面 1.5x、面板 2x），贴进表面时做降采样，
  等于超采样抗锯齿，字比原生 1x 更干净。
* 静态部分（背景 + 窗口外壳 + 网页）缓存成「底图」，每帧只需 copy 一次底图、
  贴一次面板、画光标与字幕 —— 这是能跑到 25~30fps 的关键。

坐标约定
--------
* 窗口空间：窗口左上角为原点，1 单位 = 1 CSS 像素。
* 画布空间：最终 1920×1080 视频帧。
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field

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

# 配色（贴着 Edge 浅色主题）
C_TABBAR = (222, 225, 230)
C_TAB_ACTIVE = (252, 252, 253)
C_TOOLBAR = (247, 248, 250)
C_BORDER = (206, 210, 216)
C_TEXT = (40, 44, 52)
C_TEXT_DIM = (108, 114, 124)
C_URL_BG = (255, 255, 255)
C_ACCENT = (0, 120, 212)

FONT_DIR = r"C:\Windows\Fonts"
F_UI = os.path.join(FONT_DIR, "segoeui.ttf")
F_UI_B = os.path.join(FONT_DIR, "segoeuib.ttf")
F_ZH = os.path.join(FONT_DIR, "msyh.ttc")
F_ZH_B = os.path.join(FONT_DIR, "msyhbd.ttc")

_font_cache: dict = {}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size)
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


# ---------------------------------------------------------------- 镜头
@dataclass
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

    PAD = 26           # 画布四周留白
    BOTTOM = 132       # 底部字幕带

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
        e = p * p * (3 - 2 * p)          # smoothstep
        fx, fy, fw, fh = self._from
        self.x = fx + (self.tx - fx) * e
        self.y = fy + (self.ty - fy) * e
        self.w = fw + (self.tw - fw) * e
        self.h = fh + (self.th - fh) * e

    @property
    def scale(self) -> float:
        avail_w = CANVAS_W - self.PAD * 2
        avail_h = CANVAS_H - self.PAD - self.BOTTOM
        return min(avail_w / self.w, avail_h / self.h)

    def canvas_rect(self):
        """窗口空间矩形 → 画布像素矩形（浮点）。"""
        s = self.scale
        cw, ch = self.w * s, self.h * s
        cx = (CANVAS_W - cw) / 2
        cy = self.PAD + (CANVAS_H - self.PAD - self.BOTTOM - ch) / 2
        return cx, cy, cw, ch

    def map_rect(self, r):
        """把窗口空间的任意矩形映射到画布像素。"""
        s = self.scale
        cx, cy, _, _ = self.canvas_rect()
        return (cx + (r[0] - self.x) * s, cy + (r[1] - self.y) * s, r[2] * s, r[3] * s)


# 预设取景
def preset(name: str):
    return {
        "wide":        (0.0, 0.0, float(WIN_W), float(WIN_H)),
        "page":        (-10.0, 40.0, 1260.0, 960.0),
        "panel":       (1130.0, 30.0, 470.0, 970.0),
        "panel_zoom":  (1195.0, 180.0, 405.0, 700.0),
        "panel_top":   (1140.0, 20.0, 460.0, 560.0),
        "page_top":    (-10.0, 20.0, 1260.0, 620.0),
        "page_mid":    (-10.0, 300.0, 1260.0, 700.0),
        "product":     (60.0, 120.0, 1120.0, 700.0),
        "ad_top":      (30.0, 60.0, 1150.0, 260.0),
        "float":       (860.0, 560.0, 700.0, 420.0),
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

        # 工具栏底色
        d.rectangle([0, S(TAB_H), w, h], fill=C_TOOLBAR)
        d.line([(0, S(TAB_H)), (w, S(TAB_H))], fill=C_BORDER, width=max(1, S(1)))

        # 活动标签页
        tab_w = S(258)
        tab_h = S(TAB_H + 6)
        rounded(d, [S(10), S(7), S(10) + tab_w, S(7) + tab_h], S(9), fill=C_TAB_ACTIVE)
        # favicon
        fx, fy, fr = S(26), S(18), S(8)
        d.ellipse([fx - fr, fy - fr, fx + fr, fy + fr], fill=favicon_rgb)
        # 标题
        ft = font(F_ZH, int(S(13.5)))
        t = ellipsize(d, title, ft, tab_w - S(64))
        d.text((S(42), S(11)), t, font=ft, fill=C_TEXT)
        # 关闭按钮
        cx, cy, cr = S(10) + tab_w - S(18), S(18), S(6)
        d.line([(cx - cr * 0.6, cy - cr * 0.6), (cx + cr * 0.6, cy + cr * 0.6)], fill=C_TEXT_DIM, width=max(1, S(1.4)))
        d.line([(cx - cr * 0.6, cy + cr * 0.6), (cx + cr * 0.6, cy - cr * 0.6)], fill=C_TEXT_DIM, width=max(1, S(1.4)))
        # 新建标签页 +
        px, py = S(10) + tab_w + S(20), S(20)
        d.line([(px - S(6), py), (px + S(6), py)], fill=C_TEXT_DIM, width=max(1, S(1.6)))
        d.line([(px, py - S(6)), (px, py + S(6))], fill=C_TEXT_DIM, width=max(1, S(1.6)))

        # 窗口按钮（— □ ×）
        bx = w - S(28)
        for i, glyph in enumerate(("—", "□", "×")):
            xx = w - S(120) + i * S(40)
            f = font(F_UI, int(S(12)))
            d.text((xx, S(13)), glyph, font=f, fill=C_TEXT_DIM)

        # 工具栏：前进/后退/刷新
        ty = S(TAB_H + 20)
        for i, (kind) in enumerate(("back", "fwd", "reload")):
            ax = S(30) + i * S(38)
            col = C_TEXT if i < 2 else C_TEXT_DIM
            if kind == "back":
                d.line([(ax + S(4), ty - S(5)), (ax - S(4), ty), (ax + S(4), ty + S(5))], fill=col, width=max(1, S(1.8)), joint="curve")
            elif kind == "fwd":
                d.line([(ax - S(4), ty - S(5)), (ax + S(4), ty), (ax - S(4), ty + S(5))], fill=col, width=max(1, S(1.8)), joint="curve")
            else:
                d.arc([ax - S(6), ty - S(6), ax + S(6), ty + S(6)], start=40, end=330, fill=col, width=max(1, S(1.6)))
                d.polygon([(ax + S(5), ty - S(8)), (ax + S(9), ty - S(2)), (ax + S(2), ty - S(1))], fill=col)

        # 地址栏
        ab_x0, ab_x1 = S(150), w - S(300)
        rounded(d, [ab_x0, S(TAB_H + 7), ab_x1, S(TAB_H + 33)], S(13), fill=C_URL_BG, outline=(226, 229, 234), width=max(1, S(1)))
        # 锁
        lx, ly = ab_x0 + S(16), S(TAB_H + 20)
        d.arc([lx - S(5), ly - S(7), lx + S(5), ly + S(3)], start=180, end=360, fill=(90, 96, 106), width=max(1, S(1.5)))
        rounded(d, [lx - S(6), ly - S(1), lx + S(6), ly + S(7)], S(2), fill=(90, 96, 106))
        fu = font(F_UI, int(S(13)))
        d.text((ab_x0 + S(32), S(TAB_H + 12)), ellipsize(d, url, fu, ab_x1 - ab_x0 - S(70)), font=fu, fill=(52, 58, 66))
        # 收藏星
        sx = ab_x1 + S(24)
        d.polygon(_star(sx, S(TAB_H + 20), S(7), S(3.2)), fill=None, outline=C_TEXT_DIM)

        # 右侧：扩展图标 + 头像 + 菜单
        ex = w - S(250)
        for i in range(2):
            d.rounded_rectangle([ex + i * S(30) - S(7), S(TAB_H + 13), ex + i * S(30) + S(7), S(TAB_H + 27)],
                                radius=S(3), outline=C_TEXT_DIM, width=max(1, S(1.3)))
        ax = w - S(186)
        d.ellipse([ax - S(9), S(TAB_H + 11), ax + S(9), S(TAB_H + 29)], fill=(120, 150, 200))
        f = font(F_UI_B, int(S(10)))
        d.text((ax - S(4), S(TAB_H + 14)), "Z", font=f, fill=(255, 255, 255))
        mx = w - S(150)
        for i in range(3):
            d.ellipse([mx - S(2), S(TAB_H + 14) + i * S(5), mx + S(2), S(TAB_H + 18) + i * S(5)], fill=C_TEXT_DIM)

        # 底部分隔线
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
def cursor_image(scale: float = 1.0, pressed: bool = False) -> Image.Image:
    """画一只带白描边的箭头光标（避免直接用系统光标截图，风格更统一）。"""
    w, h = int(26 * scale), int(34 * scale)
    img = Image.new("RGBA", (w + 4, h + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [(2, 2), (2, 26), (8, 20.5), (12, 30), (16, 28), (12, 19), (19, 18.5)]
    pts = [(x * scale + 2, y * scale + 2) for x, y in pts]
    tip = (pts[0][0] + 1.5 * scale, pts[0][1] + 1.5 * scale)
    d.polygon([tip] + [(pts[0][0] + (p[0] - pts[0][0]) * 1.0, pts[0][1] + (p[1] - pts[0][1]) * 1.0) for p in pts[1:]],
              fill=(20, 22, 26, 255), outline=(255, 255, 255, 255))
    if pressed:
        d.ellipse([tip[0] - 5 * scale, tip[1] - 5 * scale, tip[0] + 5 * scale, tip[1] + 5 * scale],
                  outline=(255, 255, 255, 210), width=max(1, int(2 * scale)))
    return img


class Cursor:
    def __init__(self):
        self.x, self.y = 0.0, 0.0            # 画布坐标
        self.fx, self.fy = 0.0, 0.0
        self.tx, self.ty = 0.0, 0.0
        self.t0 = 0.0
        self.dur = 0.0
        self.visible = False
        self.press_until = -1.0
        self.ripples: list = []

    def move_to(self, x, y, dur, now):
        self.fx, self.fy = self.x, self.y
        self.tx, self.ty = x, y
        self.t0, self.dur = now, max(0.001, dur)
        self.visible = True

    def jump(self, x, y):
        self.x = self.fx = self.tx = x
        self.y = self.fy = self.ty = y
        self.visible = True

    def click(self, now):
        self.press_until = now + 0.18
        self.ripples.append([self.x, self.y, now])

    def step(self, now):
        if self.dur > 0:
            p = min(1.0, (now - self.t0) / self.dur)
            e = p * p * (3 - 2 * p)
            self.x = self.fx + (self.tx - self.fx) * e
            self.y = self.fy + (self.ty - self.fy) * e
            if p >= 1.0:
                self.dur = 0.0
        self.ripples = [r for r in self.ripples if now - r[2] < 0.5]

    def draw(self, canvas: Image.Image, now: float, scale: float = 1.0) -> None:
        if not self.visible:
            return
        d = ImageDraw.Draw(canvas, "RGBA")
        for rx, ry, rt in self.ripples:
            p = (now - rt) / 0.5
            if 0 <= p <= 1:
                rr = 6 + 30 * p
                alpha = int(150 * (1 - p))
                d.ellipse([rx - rr, ry - rr, rx + rr, ry + rr], outline=(255, 255, 255, alpha), width=max(1, int(2.5 * (1 - p)) + 1))
                d.ellipse([rx - rr + 2, ry - rr + 2, rx + rr - 2, ry + rr - 2], outline=(20, 22, 26, alpha // 2), width=1)
        cur = cursor_image(scale, pressed=now < self.press_until)
        canvas.paste(cur, (int(self.x) - 2, int(self.y) - 2), cur)


# ---------------------------------------------------------------- 字幕 / 高亮
class Caption:
    def __init__(self):
        self.text = ""
        self.alpha = 0.0
        self.target = 0.0
        self.prev = ""

    def set(self, text: str, now: float) -> None:
        if text == self.text:
            return
        if self.text and text:
            self.prev, self.prev_alpha = self.text, 1.0
            self.swap_at = now
        self.text = text
        self.target = 1.0 if text else 0.0

    def step(self, now: float, dt: float) -> None:
        speed = dt / 0.28
        if self.alpha < self.target:
            self.alpha = min(self.target, self.alpha + speed)
        elif self.alpha > self.target:
            self.alpha = max(self.target, self.alpha - speed)

    def draw(self, canvas: Image.Image) -> None:
        if self.alpha <= 0.01 or not self.text:
            return
        d = ImageDraw.Draw(canvas, "RGBA")
        f = font(F_ZH, 30)
        pad_x, pad_y = 30, 16
        tw = text_w(d, self.text, f)
        bw, bh = tw + pad_x * 2, 30 + pad_y * 2
        x0 = (CANVAS_W - bw) / 2
        y0 = CANVAS_H - 104
        layer = Image.new("RGBA", (int(bw), int(bh)), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        rounded(ld, [0, 0, bw - 1, bh - 1], 14, fill=(16, 20, 28, int(215 * self.alpha)))
        ld.text((pad_x, pad_y - 2), self.text, font=f, fill=(255, 255, 255, int(255 * self.alpha)))
        canvas.paste(layer, (int(x0), int(y0)), layer)


class Highlights:
    """在窗口空间里画高亮框（如「就是这个广告位」）。"""

    def __init__(self):
        self.items: list = []      # [rect(win空间), until, color]

    def add(self, rect, now, dur=2.5, color=(255, 92, 92)):
        self.items.append([tuple(rect), now + dur, color])

    def prune(self, now):
        self.items = [i for i in self.items if i[1] > now]

    def draw(self, canvas: Image.Image, cam: Camera, now: float):
        if not self.items:
            return
        d = ImageDraw.Draw(canvas, "RGBA")
        for rect, until, color in self.items:
            left = until - now
            a = int(230 * min(1.0, left / 0.4))
            x, y, w, h = cam.map_rect(rect)
            pad = 4
            box = [x - pad, y - pad, x + w + pad, y + h + pad]
            rounded(d, box, 8, outline=(*color, a), width=3)
            d.rectangle(box, outline=(255, 255, 255, a // 3), width=1)


# ---------------------------------------------------------------- 组装器
class Compositor:
    """每帧：底图 copy → 贴面板 → 画高亮 → 画光标 → 画字幕。"""

    def __init__(self, page_shot: Image.Image, panel_shot: Image.Image,
                 url: str = "", title: str = "", favicon=(233, 30, 99)):
        self.shell = Shell()
        self.page = page_shot
        self.panel = panel_shot
        self.url = url
        self.title = title
        self.favicon = favicon
        self.cam = Camera()
        self.cam.jump(preset("wide"))
        self.cursor = Cursor()
        self.caption = Caption()
        self.highlights = Highlights()
        self.page_v = 0
        self._shadow_key = self._chrome_key = self._page_key = None
        self._shadow_img = self._shadow_mask = self._shadow_pos = None
        self._chrome_img = self._chrome_mask = self._chrome_pos = None
        self._page_img = self._page_pos = None
        self.panel_v = 0
        self.panel_slide = 1.0          # 面板滑入进度 0..1
        self.card: tuple | None = None  # (图, 不透明度)
        self.toast: tuple | None = None # (图, x, y, 不透明度)
        self._bg = self._make_bg()

    # ---- 背景（画布级，预渲染一次）
    def _make_bg(self) -> Image.Image:
        img = Image.new("RGB", (CANVAS_W, CANVAS_H), (10, 10, 12))
        d = ImageDraw.Draw(img)
        for i in range(CANVAS_H):
            t = i / CANVAS_H
            v = int(10 + 16 * t)
            d.line([(0, i), (CANVAS_W, i)], fill=(v, v, v + 2))
        glow = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([-200, -520, CANVAS_W + 200, 520], fill=(255, 255, 255, 16))
        glow = glow.filter(ImageFilter.GaussianBlur(160))
        return Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")

    # ---- 窗口表面（底图缓存）
    def set_layers(self, page: Image.Image | None = None, panel: Image.Image | None = None):
        if page is not None:
            self.page = page
            self.page_v += 1
        if panel is not None:
            self.panel = panel
            self.panel_v += 1

    def set_page_meta(self, url: str, title: str, favicon=(233, 30, 99)):
        self.url, self.title, self.favicon = url, title, favicon

    def _cam_key(self):
        return (round(self.cam.x, 2), round(self.cam.y, 2), round(self.cam.w, 2), round(self.cam.h, 2))

    # ---- 分层缓存：外壳 / 网页 / 阴影各自独立，
    #      页面滚动时只重算网页层，面板流式输出时三层都不动，镜头运动时才三层齐重算。
    def _shadow_layer(self):
        key = self._cam_key()
        if self._shadow_key == key:
            return self._shadow_img, self._shadow_mask, self._shadow_pos
        cx, cy, cw, ch = self.cam.canvas_rect()
        w, h = max(1, int(round(cw))), max(1, int(round(ch)))
        q = 4
        small = Image.new("L", (max(1, (w + 80) // q), max(1, (h + 80) // q)), 0)
        rounded(ImageDraw.Draw(small), [10, 11, 10 + w // q, 11 + h // q], 4, fill=132)
        small = small.filter(ImageFilter.GaussianBlur(6)).resize((w + 80, h + 80), Image.BILINEAR)
        self._shadow_img = Image.new("RGB", (w + 80, h + 80), (0, 0, 0))
        self._shadow_mask = small
        self._shadow_pos = (int(cx) - 40, int(cy) - 40)
        self._shadow_key = key
        return self._shadow_img, self._shadow_mask, self._shadow_pos

    def _chrome_layer(self):
        key = (self._cam_key(), self.url, self.title, self.favicon)
        if self._chrome_key == key:
            return self._chrome_img, self._chrome_mask, self._chrome_pos
        cx, cy, cw, ch = self.cam.canvas_rect()
        s = self.cam.scale
        w = max(2, int(round(WIN_W * s)))
        h = max(2, int(round(CHROME_H * s)))
        img = self.shell.render(self.url, self.title, self.favicon).resize((w, h), Image.BILINEAR)
        rad = max(0, int(round(12 * s)))
        mask = None
        if rad > 0:
            mask = Image.new("L", (w, h), 255)
            md = ImageDraw.Draw(mask)
            md.rectangle([0, 0, rad, rad], fill=0)
            md.pieslice([0, 0, rad * 2, rad * 2], 180, 270, fill=255)
            md.rectangle([w - rad, 0, w, rad], fill=0)
            md.pieslice([w - rad * 2, 0, w, rad * 2], 270, 360, fill=255)
        self._chrome_img, self._chrome_mask = img, mask
        self._chrome_pos = (int(cx), int(cy))
        self._chrome_key = key
        return img, mask, self._chrome_pos

    def _page_layer(self):
        key = (self._cam_key(), self.page_v)
        if self._page_key == key:
            return self._page_img, self._page_pos
        cx, cy, cw, ch = self.cam.canvas_rect()
        s = self.cam.scale
        w = max(2, int(round(PAGE_W * s)))
        h = max(2, int(round(PAGE_H * s)))
        img = self.page.convert("RGB").resize((w, h), Image.BILINEAR)
        rad = max(0, int(round(12 * s)))
        if rad > 0:                     # 窗口左下角圆角
            mask = Image.new("L", (w, h), 255)
            md = ImageDraw.Draw(mask)
            md.rectangle([0, h - rad, rad, h], fill=0)
            md.pieslice([0, h - rad * 2, rad * 2, h], 90, 180, fill=255)
            img = Image.composite(img, img, mask)
            base = Image.new("RGB", (w, h), (255, 255, 255))
            base.paste(img, (0, 0), mask)
            img = base
        self._page_img = img
        self._page_pos = (int(cx), int(cy + CHROME_H * s))
        self._page_key = key
        return img, self._page_pos

    def panel_canvas_rect(self):
        p = max(0.0, min(1.0, self.panel_slide))
        x = PANEL_ORIGIN[0] + PANEL_W * (1.0 - p)
        return self.cam.map_rect((x, PANEL_ORIGIN[1], PANEL_W, PANEL_H))

    def frame(self, now: float, dt: float) -> Image.Image:
        self.cam.step(now)
        self.cursor.step(now)
        self.caption.step(now, dt)
        self.highlights.prune(now)
        img = self._bg.copy()
        s_img, s_mask, s_pos = self._shadow_layer()
        img.paste(s_img, s_pos, s_mask)
        c_img, c_mask, c_pos = self._chrome_layer()
        if c_mask is not None:
            img.paste(c_img, c_pos, c_mask)
        else:
            img.paste(c_img, c_pos)
        p_img, p_pos = self._page_layer()
        img.paste(p_img, p_pos)

        # 面板：每帧单独贴（流式输出时只有它在变）；滑入时按窗口右缘裁剪
        px, py, pw, ph = self.panel_canvas_rect()
        pw_i, ph_i = max(1, int(round(pw))), max(1, int(round(ph)))
        right_edge = self.cam.map_rect((WIN_W, 0, 0, 0))[0]
        keep = (right_edge - px) / max(1.0, pw)
        if keep > 0.002 and px < CANVAS_W:
            keep = min(1.0, keep)
            pan = self.panel.convert("RGB").resize((pw_i, ph_i), Image.BILINEAR)
            if keep < 1.0:
                pan = pan.crop((0, 0, max(1, int(pw_i * keep)), ph_i))
            rad = max(0, int(round(12 * self.cam.scale)))
            if rad > 0:
                mask = Image.new("L", pan.size, 255)
                md = ImageDraw.Draw(mask)
                md.rectangle([0, 0, rad, rad], fill=0)
                md.pieslice([0, 0, rad * 2, rad * 2], 180, 270, fill=255)
                img.paste(pan, (int(round(px)), int(round(py))), mask)
            else:
                img.paste(pan, (int(round(px)), int(round(py))))
            # 面板左缘一道细阴影，让侧边栏「立」起来
            if self.panel_slide > 0.02:
                sw_ = max(2, int(round(8 * self.cam.scale)))
                sh_ = Image.new("L", (sw_, pan.size[1]), 0)
                for i in range(sw_):
                    ImageDraw.Draw(sh_).line([(i, 0), (i, pan.size[1])], fill=int(56 * (1 - i / sw_)))
                img.paste(Image.new("RGB", (sw_, pan.size[1]), (0, 0, 0)),
                          (int(round(px)) - sw_, int(round(py))), sh_)

        self.highlights.draw(img, self.cam, now)

        # 系统通知气泡
        if self.toast is not None:
            t_img, tx, ty, ta = self.toast
            if ta > 0.01:
                mask = t_img.split()[3].point(lambda v: int(v * ta))
                img.paste(t_img.convert("RGB"), (int(tx), int(ty)), mask)

        self.cursor.draw(img, now, scale=max(0.85, min(1.35, self.cam.scale * 1.15)))
        self.caption.draw(img)

        # 片头/片尾整屏卡
        if self.card is not None:
            c_img, ca = self.card
            if ca > 0.004:
                img = Image.blend(img, c_img.convert("RGB"), min(1.0, ca))
        return img
