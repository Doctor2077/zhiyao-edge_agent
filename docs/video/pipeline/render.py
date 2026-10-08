#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线渲染器：把采集轮的产物重放成成片。

采集轮（record.py --capture）只留下三样东西：
  * page.mp4 / panel.mp4 —— 网页与面板两块「面」，30fps 的源视频；
  * samples —— 镜头、面板滑出量、光标位置，120Hz 的状态采样；
  * events  —— 大字、标注、卡片、通知这类离散事件。

渲染时按目标帧率（默认 120fps）走时间轴：镜头/光标在相邻采样之间插值，
两帧源之间保持上一帧。于是镜头推拉、光标移动、大字入场都是**真·逐帧**
（每秒 120 个不同机位），而浏览器内容本身仍是 30fps 的采集率 ——
这是实时录屏管线无法回避的上限，但画面的「运动感」几乎全部来自前者。

合成是纯 CPU 的，所以默认按帧区间切成分片并行跑（本机 32 核），
分片各编码一个 mp4，最后无损拼接。60 秒成片从 20 分钟降到 2 分钟上下。

用法：
  python render.py --take ../out/promo-take.json --out ../out/promo.mp4 --fps 120
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import subprocess
import sys
import time

from PIL import Image

import cards
import compose as C

HERE = os.path.dirname(os.path.abspath(__file__))


# ------------------------------------------------------------------ 源视频
class Stream:
    """一路源视频，按「源帧序号」顺序取帧。

    分片并行时每片都要从中途开始，所以支持 -ss 输入定位；定位之后
    第 0 帧就对应 base 号源帧，取的帧号只往前走，不回头。
    """

    def __init__(self, ffmpeg: str, path: str, size, ss: float = 0.0, src_fps: float = 30.0):
        self.w, self.h = int(size[0]), int(size[1])
        self.n = self.w * self.h * 3
        # 必须和取帧侧的 int(t*src_fps) 用同一种取整，否则分片首帧会差一格
        self.base = int(ss * src_fps)
        cmd = [ffmpeg, "-v", "error"]
        if ss > 0.01:
            cmd += ["-ss", f"{ss:.5f}"]
        cmd += ["-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        # 取完就 kill，解码器会往 stderr 刷一堆 broken pipe —— 直接堵掉
        self.p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.idx = self.base - 1
        self.img: Image.Image | None = None
        self.eof = False

    def at(self, want: int):
        if self.img is not None and want <= self.idx:
            return self.img
        if want <= self.idx:
            want = self.idx + 1          # 一帧都还没读过，至少先读一帧
        while self.idx < want and not self.eof:
            b = self.p.stdout.read(self.n)
            if not b or len(b) < self.n:
                self.eof = True
                break
            self.idx += 1
            self.img = Image.frombytes("RGB", (self.w, self.h), b)
        return self.img

    def close(self):
        try:
            self.p.stdout.close()
            self.p.kill()
        except Exception:
            pass


def lerp(a: float, b: float, k: float) -> float:
    return a + (b - a) * k


def sample_at(samples, t: float, ptr: list):
    """在 120Hz 状态采样之间线性插值。时间轴单调递增，游标只往前走。"""
    n = len(samples)
    if n == 0:
        return None
    i = ptr[0]
    while i < n - 1 and samples[i + 1][0] <= t:
        i += 1
    ptr[0] = i
    if i >= n - 1:
        return samples[-1][1:]
    a, b = samples[i], samples[i + 1]
    dt = b[0] - a[0]
    k = 0.0 if dt <= 1e-9 else max(0.0, min(1.0, (t - a[0]) / dt))
    return [lerp(a[j], b[j], k) for j in range(1, len(a))]


class Tween:
    """卡片 / 通知气泡的透明度补间，由事件驱动、按时间取值。"""

    def __init__(self):
        self.img = None
        self.a = 0.0
        self.frm = 0.0
        self.to = 0.0
        self.t0 = 0.0
        self.dur = 1.0

    def start(self, img, to: float, t0: float, dur: float, now: float):
        if img is not None:
            self.img = img
        self.frm = self.value(now)
        self.to = to
        self.t0 = t0
        self.dur = max(1e-3, dur)

    def value(self, now: float) -> float:
        p = max(0.0, min(1.0, (now - self.t0) / self.dur))
        return self.frm + (self.to - self.frm) * p


# ------------------------------------------------------------------ 重放
class Replayer:
    """把「状态采样 + 离散事件」重新灌进合成器，让它回到任意时刻的样子。"""

    def __init__(self, comp: C.Compositor, cap: dict):
        self.comp = comp
        self.samples = cap.get("samples", [])
        self.events = sorted(cap.get("events", []), key=lambda e: e["t"])
        self.ev_ptr = 0
        self.sm_ptr = [0]
        self.imgs: dict = {}
        self.card = Tween()
        self.toast = Tween()

    def _img(self, key, build):
        if key not in self.imgs:
            self.imgs[key] = build()
        return self.imgs[key]

    def apply_until(self, now: float) -> None:
        comp = self.comp
        while self.ev_ptr < len(self.events) and self.events[self.ev_ptr]["t"] <= now:
            e = self.events[self.ev_ptr]
            k = e["k"]
            if k == "headline":
                comp.headline.set(e.get("text", ""), e.get("kicker", ""), e["t"],
                                  e.get("pos", "bottom"))
            elif k == "sub":
                comp.caption.set(e.get("text", ""), e["t"])
            elif k == "highlight":
                comp.highlights.add(tuple(e["rect"]), e["t"], e.get("dur", 2.2),
                                    tuple(e.get("color", [72, 140, 255])))
            elif k == "pagemeta":
                comp.set_page_meta(e.get("url", ""), e.get("title", ""),
                                   tuple(e.get("favicon", [0, 120, 212])))
            elif k == "card":
                name = e.get("name")
                img = self._img(("card", name), lambda n=name: {
                    "intro": cards.intro_card, "outro": cards.outro_card}[n]()) if name else None
                self.card.start(img, float(e.get("to", 1.0)), e["t"], e.get("dur", 0.7), now)
            elif k == "toast":
                key = ("toast", e.get("title", ""), e.get("body", ""))
                img = self._img(key, lambda kk=key: cards.toast(kk[1], kk[2]))
                self.toast.start(img, float(e.get("to", 1.0)), e["t"], e.get("dur", 0.4), now)
            elif k == "click":
                comp.cursor.click(e["t"])
            self.ev_ptr += 1

    def at(self, t: float) -> None:
        """把合成器摆到 t 时刻的状态。"""
        comp = self.comp
        st = sample_at(self.samples, t, self.sm_ptr)
        if st is not None:
            comp.cam.jump((st[0], st[1], st[2], st[3]))
            comp.panel_slide = st[4]
            comp.cursor.jump(st[5], st[6])
        if self.card.img is not None:
            ca = max(0.0, min(1.0, self.card.value(t)))
            comp.card = (self.card.img, ca) if ca > 0.004 else None
        if self.toast.img is not None:
            ta = max(0.0, min(1.0, self.toast.value(t)))
            comp.toast = (self.toast.img, C.CANVAS_W - self.toast.img.width - 42, 42, ta) \
                if ta > 0.004 else None


# ------------------------------------------------------------------ 分片
def render_chunk(job: dict) -> str:
    """渲染 [t0, t1) 这一段到一个 mp4 分片。"""
    cap = job["cap"]
    ff = job["ffmpeg"]
    fps = job["fps"]
    t_a, t_b = job["t0"], job["t1"]
    src_dir = cap["dir"]
    src_fps = float(cap["src_fps"])
    sizes = cap["sizes"]

    page = Stream(ff, os.path.join(src_dir, "page.mp4"), sizes["page"], t_a, src_fps)
    panel = Stream(ff, os.path.join(src_dir, "panel.mp4"), sizes["panel"], t_a, src_fps)
    comp = C.Compositor(page.at(int(t_a * src_fps)), panel.at(int(t_a * src_fps)))

    rep = Replayer(comp, cap)
    rep.apply_until(t_a)                 # 先把这一片之前发生的事全部重放一遍

    out = job["out"]
    enc = subprocess.Popen(
        [ff, "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{C.CANVAS_W}x{C.CANVAS_H}",
         "-r", f"{fps:g}", "-i", "-", "-an",
         "-c:v", "libx264", "-preset", job["preset"], "-crf", str(job["crf"]),
         "-pix_fmt", "yuv420p", out],
        stdin=subprocess.PIPE)

    n = max(1, int(round((t_b - t_a) * fps)))
    last_pg = last_pn = -1
    probes = job.get("probes") or {}
    probe_dir = job.get("probe_dir") or ""
    for i in range(n):
        t = t_a + i / fps
        rep.apply_until(t)
        rep.at(t)
        si = int(t * src_fps)
        if si != last_pg or si != last_pn:
            comp.set_layers(page=page.at(si) if si != last_pg else None,
                            panel=panel.at(si) if si != last_pn else None)
            last_pg = last_pn = si
        frame = comp.frame(t, 1.0 / fps)
        if probes:
            hit = next((k for k in list(probes) if abs(k - t) <= 0.5 / fps), None)
            if hit is not None:
                frame.save(os.path.join(probe_dir, f"r-{hit:.2f}.png"))
                probes.pop(hit)
        try:
            enc.stdin.write(frame.tobytes())
        except (BrokenPipeError, ValueError):
            break
    enc.stdin.close()
    enc.wait()
    page.close()
    panel.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--take", required=True, help="record.py 写出的 take json（需含 capture 段）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=120.0)
    ap.add_argument("--crf", type=int, default=16)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--ffmpeg", default="")
    ap.add_argument("--workers", type=int, default=0, help="0 = 按 CPU 核数自动")
    ap.add_argument("--from", dest="t_from", type=float, default=0.0)
    ap.add_argument("--to", dest="t_to", type=float, default=0.0)
    ap.add_argument("--probe-at", default="", help="抽帧时刻，逗号分隔秒数（会退化为单进程）")
    ap.add_argument("--probe-dir", default="")
    a = ap.parse_args()

    import imageio_ffmpeg
    ff = a.ffmpeg or imageio_ffmpeg.get_ffmpeg_exe()

    take = json.load(open(a.take, encoding="utf-8"))
    cap = take.get("capture")
    if not cap:
        print("!! take 里没有 capture 段，先用 record.py --capture 录一遍", file=sys.stderr)
        return 2

    duration = float(cap["duration"])
    t0 = max(0.0, a.t_from)
    t1 = min(duration, a.t_to) if a.t_to > 0 else duration
    n_frames = max(1, int(round((t1 - t0) * a.fps)))

    probes = {}
    probe_dir = a.probe_dir
    if a.probe_at and probe_dir:
        os.makedirs(probe_dir, exist_ok=True)
        probes = {float(x): True for x in a.probe_at.split(",") if x.strip()}

    workers = a.workers or max(1, min(8, (os.cpu_count() or 4) - 2))
    if probes:
        workers = 1                       # 抽帧要顺序，别分片

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = os.path.join(os.path.dirname(os.path.abspath(a.out)), "_parts")
    os.makedirs(tmp, exist_ok=True)

    # 按帧数均分，保证每片帧数接近、且边界对齐
    n_parts = max(1, min(workers, n_frames))
    per = n_frames // n_parts
    jobs = []
    for i in range(n_parts):
        f0 = i * per
        f1 = n_frames if i == n_parts - 1 else (i + 1) * per
        jobs.append({
            "cap": cap, "ffmpeg": ff, "fps": a.fps, "preset": a.preset, "crf": a.crf,
            "t0": t0 + f0 / a.fps, "t1": t0 + f1 / a.fps,
            "out": os.path.join(tmp, f"part-{i:03d}.mp4"),
            "probes": probes if i == 0 else None, "probe_dir": probe_dir})

    print(f"[render] {n_frames} 帧 @ {a.fps:g}fps（{t1 - t0:.1f}s，源 {cap['src_fps']:g}fps），"
          f"{n_parts} 片并行", flush=True)
    wall = time.monotonic()

    if n_parts == 1:
        render_chunk(jobs[0])
    else:
        ctx = mp.get_context("spawn")
        with ctx.Pool(n_parts) as pool:
            for k, _ in enumerate(pool.imap_unordered(render_chunk, jobs), 1):
                el = time.monotonic() - wall
                print(f"[render] 分片 {k}/{n_parts} 完成  {el:.0f}s", flush=True)

    parts = [j["out"] for j in jobs]
    if len(parts) == 1:
        os.replace(parts[0], a.out)
    else:
        lst = os.path.join(tmp, "list.txt")
        with open(lst, "w", encoding="utf-8") as f:
            for p in parts:
                f.write("file '%s'\n" % p.replace("\\", "/"))
        subprocess.run([ff, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", lst, "-c", "copy", "-movflags", "+faststart", a.out], check=True)
        for p in parts:
            try:
                os.remove(p)
            except Exception:
                pass
        try:
            os.remove(lst)
        except Exception:
            pass

    print(f"[render] 成片 → {a.out}（{os.path.getsize(a.out)/1e6:.1f} MB，"
          f"耗时 {time.monotonic()-wall:.0f}s）", flush=True)
    return 0


if __name__ == "__main__":
    mp.freeze_support()
    sys.exit(main())
