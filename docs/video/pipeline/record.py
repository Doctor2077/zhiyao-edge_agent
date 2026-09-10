#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""录制引擎：把「真实扩展 + 假模型服务 + 演示网页」录成一段无声视频。

工作方式
--------
* 内容页与侧边栏面板跑在同一个 Edge 窗口里，**内容页始终是活动标签页**——
  这是扩展能读到页面、能把操作注入页面的前提。面板在后台标签页里照样实时渲染，
  我们通过 CDP screencast 收它的帧（实测后台标签页推帧正常）。
* 所有交互都走 CDP 底层输入（Input.dispatchMouseEvent / insertText / dispatchKeyEvent），
  不会激活面板标签页，所以扩展全程看到的活动标签页都是内容页。
* 渲染线程按固定帧率组装画面（背景 + 虚拟 Edge 窗口 + 网页 + 面板 + 光标 + 高亮 + 字幕），
  直接管道喂给 ffmpeg 编码；驱动线程按分镜脚本操作浏览器。

时间轴
------
画面与旁白不做「先算好时间再录」，而是**先录、再按实际时刻贴旁白**：
录制时把每个镜头的起始时刻与旁白起点写进 take.json，build.py 据此摆放配音与字幕，
于是模型流式输出快一点慢一点都不会跑偏。

用法：
  python record.py --script ../script/promo.json --tts ../assets/voice/promo/tts.json --out ../out/promo-silent.mp4
  python record.py --script ../script/promo.json --dry-run          # 只走动作，不录画面
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from PIL import Image
from playwright.async_api import async_playwright

import cards
import compose as C

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
EXT = os.path.join(ROOT, "extension", ".output", "edge-mv3")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SCENES = os.path.join(HERE, "scenes")

# 采集倍率：页面 1.25x、面板 1.6x —— 既保持超采样清晰度，又把每帧解码+缩放成本压进 40ms 预算
PAGE_DSF = 1.25
PANEL_DSF = 1.6
JPEG_Q = 92


# ------------------------------------------------------------------ 采集源
class Source:
    """一路画面源：CDP screencast 推帧，渲染线程按需解码。"""

    def __init__(self, name: str):
        self.name = name
        self._pending: str | None = None
        self._lock = threading.Lock()
        self.image: Image.Image | None = None
        self.version = 0
        self.count = 0
        self.pushed = 0
        self.pushed_at = 0.0              # 最近一次推帧的墙钟时刻（用于测量画面源滞后）
        self.size: tuple | None = None
        self.draft: tuple | None = None   # 目标尺寸提示：让 JPEG 解码直接出小图，省时间

    def push(self, b64: str) -> None:
        with self._lock:
            self._pending = b64
            self.pushed += 1
            self.pushed_at = time.monotonic()

    def pump(self):
        with self._lock:
            d, self._pending = self._pending, None
        if d:
            img = Image.open(io.BytesIO(base64.b64decode(d)))
            if self.draft:
                try:
                    img.draft("RGB", self.draft)   # JPEG 可 1/2、1/4 解码，省下大半解码时间
                except Exception:
                    pass
            img = img.convert("RGB")
            self.image, self.size = img, img.size
            self.version += 1
            self.count += 1
        return self.image, self.version


# ------------------------------------------------------------------ 渲染线程
class Renderer(threading.Thread):
    def __init__(self, comp: C.Compositor, page_src: Source, panel_src: Source,
                 ff, fps: float, t0: float):
        super().__init__(daemon=True)
        self.comp, self.page_src, self.panel_src = comp, page_src, panel_src
        self.ff, self.fps, self.t0 = ff, fps, t0
        self.finish_at: float | None = None
        self.frames = 0
        self.late = 0
        self.dropped = 0          # 为追上进度而复用的帧数（等同录屏丢帧）
        self.max_lag = 0.0        # 最大落后秒数
        self._pv = self._pnv = -1
        self._last: bytes | None = None
        self.debug = False

    def run(self) -> None:
        i = 0
        while True:
            target = self.t0 + i / self.fps
            now = time.monotonic()
            if now < target:
                time.sleep(target - now)
            lag = (time.monotonic() - self.t0) - i / self.fps
            self.max_lag = max(self.max_lag, lag)
            if lag > 1.5 / self.fps:
                self.late += 1
            if self.finish_at is not None and i / self.fps >= self.finish_at:
                break
            # 跟不上就复用上一帧：宁可局部降帧，也不让画面整体落后于旁白
            if self._last is not None and lag > 1.1 / self.fps:
                self.ff.stdin.write(self._last)
                i += 1
                self.dropped += 1
                continue
            # 先按当前机位告诉解码器目标尺寸
            try:
                _, _, pw_, ph_ = self.comp.cam.map_rect((0, C.CHROME_H, C.PAGE_W, C.PAGE_H))
                self.page_src.draft = (max(1, int(pw_)), max(1, int(ph_)))
                px_, py_, pw2_, ph2_ = self.comp.panel_canvas_rect()
                self.panel_src.draft = (max(1, int(pw2_)), max(1, int(ph2_)))
            except Exception:
                pass
            p_img, pv = self.page_src.pump()
            n_img, nv = self.panel_src.pump()
            self.comp.set_layers(page=p_img if pv != self._pv and p_img is not None else None,
                                 panel=n_img if nv != self._pnv and n_img is not None else None)
            self._pv, self._pnv = pv, nv
            frame = self.comp.frame(time.monotonic() - self.t0, 1.0 / self.fps)
            if self.debug:
                from PIL import ImageDraw as _ID
                _d = _ID.Draw(frame)
                _now = time.monotonic()
                _txt = (f"t={_now - self.t0:6.2f}  lag={(_now - self.t0) - i / self.fps:5.2f}s  "
                        f"page_age={_now - self.page_src.pushed_at:5.2f}s  "
                        f"panel_age={_now - self.panel_src.pushed_at:5.2f}s")
                _d.rectangle([0, 0, 700, 34], fill=(0, 0, 0))
                _d.text((8, 8), _txt, fill=(0, 255, 120))
            self._last = frame.tobytes()
            try:
                self.ff.stdin.write(self._last)
            except (BrokenPipeError, ValueError):
                break
            i += 1
        self.frames = i


# ------------------------------------------------------------------ 录制器
class Recorder:
    def __init__(self, script: dict, tts: dict, args):
        self.script = script
        self.tts = tts
        self.args = args
        self.fps = float(script.get("fps", 25))
        self.shots = script["shots"]
        self.pw = None
        self.ctx = None
        self.page = None
        self.panel = None
        self.cdps: dict = {}
        self.sources: dict = {}
        self.comp: C.Compositor | None = None
        self.mock = None
        self.ff = None
        self.t0 = 0.0
        self.timeline: list = []
        self.warnings: list = []
        self.cursor_pos = (760.0, 620.0)

    # ---------------- 浏览器
    async def launch(self):
        self.profile = tempfile.mkdtemp(prefix="zhiyao-take-")
        self.pw = await async_playwright().start()
        self.ctx = await self.pw.chromium.launch_persistent_context(
            user_data_dir=self.profile, executable_path=EDGE, headless=True, viewport=None,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  "--no-first-run", "--no-default-browser-check",
                  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                  "--disable-backgrounding-occluded-windows",
                  "--disable-features=CalculateNativeWinOcclusion", "--hide-scrollbars"])
        eid = None
        for _ in range(80):
            for w in self.ctx.service_workers:
                if "background.js" in w.url:
                    eid = w.url.split("/")[2]
            if eid:
                break
            await asyncio.sleep(0.25)
        if not eid:
            raise RuntimeError("扩展没加载起来")
        self.ext_id = eid
        print("[take] 扩展 ID:", eid, flush=True)

        self.page = await self.ctx.new_page()
        await self.page.set_viewport_size({"width": C.PAGE_W, "height": C.PAGE_H})
        pc = await self.ctx.new_cdp_session(self.page)
        await pc.send("Emulation.setDeviceMetricsOverride",
                      {"width": C.PAGE_W, "height": C.PAGE_H, "deviceScaleFactor": PAGE_DSF, "mobile": False})
        self.cdps["page"] = pc
        first = self.shots[0].get("scene") or "shop"
        await self.page.goto(f"http://127.0.0.1:{self.args.port}/scenes/{first}.html")
        await self.page.wait_for_timeout(400)

        # 面板：同一窗口的新标签页（同窗口才保证「最后聚焦窗口」里活动页是内容页）
        await pc.send("Target.createTarget",
                      {"url": f"chrome-extension://{eid}/sidepanel.html", "newWindow": False})
        self.panel = None
        for _ in range(80):
            for pg in self.ctx.pages:
                if "sidepanel.html" in pg.url:
                    self.panel = pg
            if self.panel:
                break
            await asyncio.sleep(0.25)
        if self.panel is None:
            raise RuntimeError("面板没打开")
        await self.panel.wait_for_load_state("domcontentloaded")
        await self.panel.set_viewport_size({"width": C.PANEL_W, "height": C.PANEL_H})
        nc = await self.ctx.new_cdp_session(self.panel)
        await nc.send("Emulation.setDeviceMetricsOverride",
                      {"width": C.PANEL_W, "height": C.PANEL_H, "deviceScaleFactor": PANEL_DSF, "mobile": False})
        self.cdps["panel"] = nc

        provider = {"id": "mock-1", "presetId": "custom", "name": "本地演示模型",
                    "baseUrl": f"http://127.0.0.1:{self.args.port}/v1",
                    "models": ["zhiyao-demo-chat"], "activeModel": "zhiyao-demo-chat", "enabled": True}
        settings = {"providers": [provider], "activeProviderId": "mock-1", "rememberKeys": True,
                    "demoMode": False, "autoReadPage": True, "previewBeforeSend": True,
                    "enabledSkillIds": [], "defaultSkillsSeeded": True, "lang": "zh"}
        await self.panel.evaluate(
            "async ([s,k]) => { await chrome.storage.local.set({settings: s, apiKeys: {'mock-1': k}}); }",
            [settings, "sk-demo"])
        await self.panel.reload()
        await self.panel.wait_for_timeout(1200)
        await self.page.bring_to_front()
        await asyncio.sleep(0.3)

    async def start_capture(self):
        for name, pg in (("page", self.page), ("panel", self.panel)):
            src = Source(name)
            self.sources[name] = src
            cdp = self.cdps[name]

            def make_handler(s):
                async def h(params):
                    s.push(params["data"])
                    try:
                        await self.cdps[s.name].send("Page.screencastFrameAck",
                                                     {"sessionId": params["sessionId"]})
                    except Exception:
                        pass
                return h
            cdp.on("Page.screencastFrame", lambda p, s=src: asyncio.create_task(make_handler(s)(p)))
            await cdp.send("Page.startScreencast",
                           {"format": "jpeg", "quality": JPEG_Q, "everyNthFrame": 1})
        # 等首帧：静态页面只在必要时推帧，给足时间并主动戳一下画面
        for _ in range(30):
            if all(s.pushed > 0 for s in self.sources.values()):
                break
            await asyncio.sleep(0.25)
        for n, s in self.sources.items():
            print(f"[take] {n} 采集尺寸 {s.size}（已推 {s.pushed} 帧）", flush=True)
        if any(s.pushed == 0 for s in self.sources.values()):
            print("[take] !! 有画面源没收到帧，检查 screencast", flush=True)

    # ---------------- 目标定位
    async def box(self, target: str, selector: str):
        cdp = self.cdps[target]
        try:
            doc = await cdp.send("DOM.getDocument", {"depth": -1})
            node = await cdp.send("DOM.querySelector",
                                  {"nodeId": doc["root"]["nodeId"], "selector": selector})
            if not node or not node.get("nodeId"):
                return None
            m = await cdp.send("DOM.getBoxModel", {"nodeId": node["nodeId"]})
            q = m["model"]["content"]
            xs, ys = q[0::2], q[1::2]
            return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
        except Exception:
            return None

    def to_window(self, target: str, box):
        ox, oy = (C.PAGE_ORIGIN if target == "page" else C.PANEL_ORIGIN)
        return (ox + box[0], oy + box[1], box[2], box[3])

    def to_canvas(self, win_rect):
        return self.comp.cam.map_rect(win_rect)

    async def move_cursor_to(self, win_rect, dur=None, offset=(0.5, 0.5)):
        cx, cy, cw, ch = self.to_canvas(win_rect)
        x = cx + cw * offset[0]
        y = cy + ch * offset[1]
        now = time.monotonic() - self.t0
        d = dur if dur is not None else min(0.85, max(0.32, ((x - self.comp.cursor.x) ** 2 + (y - self.comp.cursor.y) ** 2) ** 0.5 / 2200))
        self.comp.cursor.move_to(x, y, d, now)
        self.cursor_pos = (x, y)
        await asyncio.sleep(d)

    async def click_at(self, target: str, box, hold=0.25):
        cdp = self.cdps[target]
        x = box[0] + box[2] / 2
        y = box[1] + box[3] / 2
        now = time.monotonic() - self.t0
        self.comp.cursor.click(now)
        for t in ("mousePressed", "mouseReleased"):
            await cdp.send("Input.dispatchMouseEvent",
                           {"type": t, "x": x, "y": y, "button": "left", "clickCount": 1})
            await asyncio.sleep(0.045)
        await asyncio.sleep(hold)

    async def focus(self, target: str, selector: str):
        cdp = self.cdps[target]
        doc = await cdp.send("DOM.getDocument", {"depth": -1})
        node = await cdp.send("DOM.querySelector",
                              {"nodeId": doc["root"]["nodeId"], "selector": selector})
        if node and node.get("nodeId"):
            await cdp.send("DOM.focus", {"nodeId": node["nodeId"]})

    async def type_text(self, target: str, text: str, speed: float):
        cdp = self.cdps[target]
        for ch in text:
            await cdp.send("Input.insertText", {"text": ch})
            await asyncio.sleep(speed)

    async def press_enter(self, target: str):
        cdp = self.cdps[target]
        for t in ("keyDown", "keyUp"):
            await cdp.send("Input.dispatchKeyEvent",
                           {"type": t, "key": "Enter", "code": "Enter",
                            "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
            await asyncio.sleep(0.03)

    # ---------------- 动作
    async def do_action(self, act: dict):
        kind = act.get("do")
        target = act.get("target", "panel")
        if kind == "camera":
            self.comp.cam.to(C.preset(act["to"]), act.get("dur", 0.9), time.monotonic() - self.t0)
            await asyncio.sleep(act.get("wait", 0.0))
        elif kind == "panel":
            await self.animate_panel(1.0 if act.get("open", True) else 0.0, act.get("dur", 0.55))
        elif kind == "card":
            img = {"intro": cards.intro_card, "outro": cards.outro_card}[act["name"]]()
            await self.fade_card(img, act.get("fade", 0.7))
        elif kind == "card_off":
            await self.fade_card(None, act.get("fade", 0.7))
        elif kind == "caption":
            self.comp.caption.set(act.get("text", ""), time.monotonic() - self.t0)
        elif kind == "scene":
            await self.page.goto(f"http://127.0.0.1:{self.args.port}/scenes/{act['page']}.html")
            await self.page.wait_for_timeout(act.get("settle", 500))
            fav = tuple(act.get("favicon", [0, 120, 212]))
            self.comp.set_page_meta(act.get("url", ""), act.get("title", ""), fav)
        elif kind == "scroll":
            await self.page.evaluate(
                "([y, ms]) => new Promise(r => { const t0=performance.now(); const y0=window.scrollY;"
                " const step=()=>{const p=Math.min(1,(performance.now()-t0)/ms);"
                " const e=p*p*(3-2*p); window.scrollTo(0, y0+(y-y0)*e);"
                " if(p<1) requestAnimationFrame(step); else r(); }; step(); })",
                [int(act.get("to", 0)), int(act.get("dur", 1.0) * 1000)])
        elif kind == "click":
            box = await self.box(target, act["selector"])
            if box is None:
                self.warnings.append(f"click 找不到元素 {act['selector']}")
                return
            await self.move_cursor_to(self.to_window(target, box), act.get("move"))
            await asyncio.sleep(act.get("pre", 0.12))
            await self.click_at(target, box, act.get("hold", 0.3))
        elif kind == "hover":
            box = await self.box(target, act["selector"])
            if box is None:
                return
            await self.move_cursor_to(self.to_window(target, box), act.get("move"))
        elif kind == "type":
            await self.focus(target, act.get("into", "textarea"))
            await self.type_text(target, act["text"], act.get("speed", 0.09))
        elif kind == "enter":
            await self.press_enter(target)
        elif kind == "wait":
            ok = await self.wait_selector(target, act["selector"], act.get("timeout", 30))
            if not ok:
                self.warnings.append(f"wait 超时 {act['selector']}")
        elif kind == "wait_gone":
            ok = await self.wait_gone(target, act["selector"], act.get("timeout", 90))
            if not ok:
                self.warnings.append(f"wait_gone 超时 {act['selector']}")
        elif kind == "highlight":
            box = await self.box(target, act["selector"])
            if box is None:
                self.warnings.append(f"highlight 找不到 {act['selector']}")
                return
            self.comp.highlights.add(self.to_window(target, box), time.monotonic() - self.t0,
                                     act.get("dur", 2.2), tuple(act.get("color", [255, 92, 92])))
        elif kind == "toast":
            img = cards.toast(act.get("title", ""), act.get("body", ""))
            x = C.CANVAS_W - img.width - 42
            y = 42
            self.comp.toast = (img, x, y, 0.0)
            soon = time.monotonic() - self.t0
            await self.fade_toast(1.0, act.get("fade", 0.35))
            await asyncio.sleep(act.get("dur", 4.0))
            await self.fade_toast(0.0, act.get("fade", 0.5))
        elif kind == "sleep":
            await asyncio.sleep(act.get("t", 0.5))
        else:
            self.warnings.append(f"未知动作 {kind}")

    async def animate_panel(self, to: float, dur: float) -> None:
        frm = self.comp.panel_slide
        steps = max(2, int(dur * self.fps))
        for i in range(1, steps + 1):
            p = i / steps
            e = p * p * (3 - 2 * p)
            self.comp.panel_slide = frm + (to - frm) * e
            await asyncio.sleep(dur / steps)

    async def fade_card(self, img, dur: float):
        frm = self.comp.card[1] if self.comp.card else 0.0
        to = 0.0 if img is None else 1.0
        steps = max(2, int(dur * self.fps))
        for i in range(1, steps + 1):
            p = i / steps
            a = frm + (to - frm) * p
            self.comp.card = ((img if img is not None else self.comp.card[0]), a) if (img or self.comp.card) else None
            await asyncio.sleep(dur / steps)
        if img is None:
            self.comp.card = None

    async def fade_toast(self, to: float, dur: float):
        if not self.comp.toast:
            return
        img, x, y, frm = self.comp.toast
        steps = max(2, int(dur * 20))
        for i in range(1, steps + 1):
            p = i / steps
            self.comp.toast = (img, x, y, frm + (to - frm) * p)
            await asyncio.sleep(dur / steps)

    async def wait_selector(self, target: str, selector: str, timeout: float) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if await self.box(target, selector):
                return True
            await asyncio.sleep(0.12)
        return False

    async def wait_gone(self, target: str, selector: str, timeout: float) -> bool:
        end = time.monotonic() + timeout
        gone_since = None
        while time.monotonic() < end:
            if await self.box(target, selector) is None:
                gone_since = gone_since or time.monotonic()
                if time.monotonic() - gone_since > 0.25:
                    return True
            else:
                gone_since = None
            await asyncio.sleep(0.12)
        return False

    # ---------------- 主流程
    async def run(self) -> dict:
        await self.launch()
        first = self.shots[0]
        self.comp = C.Compositor(self.sources_page_placeholder(), self.sources_panel_placeholder(),
                                 url=first.get("url", "https://item.yunji.com/100058712345.html"),
                                 title=first.get("title", ""),
                                 favicon=tuple(first.get("favicon", [0, 120, 212])))
        await self.start_capture()
        self.comp.cam.jump(C.preset(self.shots[0].get("camera", "wide")))
        self.comp.cursor.jump(*self.cursor_pos)
        self.comp.panel_slide = float(self.shots[0].get("panel_slide", 1.0))

        ff_cmd = [self.args.ffmpeg, "-y", "-loglevel", "error",
                  "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{C.CANVAS_W}x{C.CANVAS_H}",
                  "-r", str(self.fps), "-i", "-", "-an",
                  "-c:v", "libx264", "-preset", self.args.preset, "-crf", str(self.args.crf),
                  "-pix_fmt", "yuv420p", "-movflags", "+faststart", self.args.out]
        self.t0 = time.monotonic()
        renderer = None
        if not self.args.dry_run:
            os.makedirs(os.path.dirname(os.path.abspath(self.args.out)), exist_ok=True)
            self.ff = subprocess.Popen(ff_cmd, stdin=subprocess.PIPE)
            renderer = Renderer(self.comp, self.sources["page"], self.sources["panel"],
                                self.ff, self.fps, self.t0)
            renderer.debug = bool(self.args.debug_overlay)
            renderer.start()

        only = {x.strip() for x in (self.args.shots or "").split(",") if x.strip()}
        for shot in self.shots:
            if only and shot["id"] not in only:
                continue
            await self.run_shot(shot)

        elapsed = time.monotonic() - self.t0
        if renderer is not None:
            renderer.finish_at = elapsed
            while renderer.is_alive():
                await asyncio.sleep(0.15)
            self.ff.stdin.close()
            self.ff.wait()
            print(f"[take] 编码完成：{renderer.frames} 帧 / {renderer.frames / self.fps:.1f}s"
                  f"（迟到帧 {renderer.late}，复用帧 {renderer.dropped}，最大落后 {renderer.max_lag*1000:.0f}ms）",
                  flush=True)
        stats = {}
        if renderer is not None:
            stats = {"frames": renderer.frames, "late": renderer.late,
                     "dropped": renderer.dropped, "max_lag": round(renderer.max_lag, 3)}
        return {"video": self.script.get("id"), "fps": self.fps, "duration": round(elapsed, 3),
                "shots": self.timeline, "warnings": self.warnings, "stats": stats}

    def sources_page_placeholder(self):
        return Image.new("RGB", (int(C.PAGE_W * PAGE_DSF), int(C.PAGE_H * PAGE_DSF)), (255, 255, 255))

    def sources_panel_placeholder(self):
        return Image.new("RGB", (int(C.PANEL_W * PANEL_DSF), int(C.PANEL_H * PANEL_DSF)), (255, 255, 255))

    async def run_shot(self, shot: dict):
        sid = shot["id"]
        t_start = time.monotonic() - self.t0
        narr_at = float(shot.get("narration_at", 0.4))
        line = self.tts.get("lines", {}).get(sid, {})
        speech = float(line.get("speech", 0.0)) or (len(shot.get("narration", "")) / 4.4)
        pad_tail = float(shot.get("tail", 1.1))

        if shot.get("caption") is not None:
            self.comp.caption.set(shot["caption"], time.monotonic() - self.t0)
        elif shot.get("narration"):
            # 字幕用短句：过长时在标点处截断
            n = shot["narration"]
            short = n.split("。")[0] + "。" if "。" in n else n
            self.comp.caption.set(short, time.monotonic() - self.t0)

        if "camera" in shot and not any(a.get("do") == "camera" for a in shot.get("actions", [])):
            self.comp.cam.to(C.preset(shot["camera"]), shot.get("camera_dur", 0.0) or 0.001,
                             time.monotonic() - self.t0)

        for act in shot.get("actions", []):
            if "at" in act:
                due = t_start + float(act["at"])
                wait = due - (time.monotonic() - self.t0)
                if wait > 0:
                    await asyncio.sleep(wait)
            await self.do_action(act)

        need = narr_at + speech + pad_tail
        now = time.monotonic() - self.t0 - t_start
        if now < need:
            await asyncio.sleep(need - now)
        elif now > need + 0.4:
            self.warnings.append(f"{sid} 动作比旁白长 {now - need:.1f}s（画面会等旁白）")
        t_end = time.monotonic() - self.t0
        self.timeline.append({"id": sid, "start": round(t_start, 3),
                              "narration_at": round(t_start + narr_at, 3),
                              "end": round(t_end, 3),
                              "speech": round(speech, 3)})
        print(f"[take] {sid:<4} {t_start:6.1f}s → {t_end:6.1f}s"
              f"（旁白 {speech:.1f}s @ {narr_at:.1f}s）", flush=True)

    async def close(self):
        try:
            for name in self.sources:
                try:
                    await self.cdps[name].send("Page.stopScreencast")
                except Exception:
                    pass
            if self.ctx:
                await self.ctx.close()
            if self.pw:
                await self.pw.stop()
        except Exception:
            pass
        shutil.rmtree(getattr(self, "profile", ""), ignore_errors=True)


# ------------------------------------------------------------------ 入口
def build_scene_dict(path: str) -> str | None:
    """若存在文章页译文词典，返回路径（供假模型生成整页翻译）。"""
    return path if path and os.path.isfile(path) else None


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--tts", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--take", default="")
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--dict", dest="dict_path", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--shots", default="", help="只录指定镜头（逗号分隔），用于快速看画面")
    ap.add_argument("--probe", default="", help="录制后抽帧到 .smoke/probe-<t>.png，逗号分隔秒数")
    ap.add_argument("--debug-overlay", action="store_true", help="画面左上角烧入时间/画面源帧龄，用于诊断同步")
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--ffmpeg", default="")
    a = ap.parse_args()

    import imageio_ffmpeg
    a.ffmpeg = a.ffmpeg or imageio_ffmpeg.get_ffmpeg_exe()

    with open(a.script, encoding="utf-8") as f:
        script = json.load(f)
    tts = {"lines": {}}
    if a.tts and os.path.isfile(a.tts):
        with open(a.tts, encoding="utf-8") as f:
            tts = json.load(f)

    if not a.dry_run and not a.out:
        a.out = os.path.join(ROOT, "docs", "video", "out", f"{script.get('id','video')}-silent.mp4")

    events = os.path.join(tempfile.gettempdir(), f"zhiyao-events-{script.get('id','v')}.jsonl")
    mock_cmd = [sys.executable, os.path.join(HERE, "mock_provider.py"),
                "--port", str(a.port), "--scenario", script.get("scenario", "promo"),
                "--cps", str(script.get("cps", 34)), "--events", events]
    d = build_scene_dict(a.dict_path)
    if d:
        mock_cmd += ["--dict", d]
    mock = subprocess.Popen(mock_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8")
    await asyncio.sleep(1.0)

    rec = Recorder(script, tts, a)
    try:
        take = await rec.run()
    finally:
        await rec.close()
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except Exception:
            mock.kill()

    if a.probe and not a.dry_run:
        os.makedirs(os.path.join(HERE, ".smoke"), exist_ok=True)
        for t in [x.strip() for x in a.probe.split(",") if x.strip()]:
            dst = os.path.join(HERE, ".smoke", f"probe-{t}.png")
            subprocess.run([a.ffmpeg, "-y", "-loglevel", "error", "-ss", t,
                            "-i", a.out, "-frames:v", "1", dst], check=False)
            print("[take] 抽帧 →", dst)

    if a.take:
        with open(a.take, "w", encoding="utf-8") as f:
            json.dump(take, f, ensure_ascii=False, indent=2)
        print("[take] 时间轴 →", a.take)
    if take.get("warnings"):
        print("\n[take] 警告：")
        for w in take["warnings"]:
            print("   -", w)
    print(f"[take] 总时长 {take['duration']:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
