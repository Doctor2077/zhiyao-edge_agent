#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""总装：把录好的无声画面、逐句配音、背景音乐、字幕合成成片。

时间轴来自 record.py 写出的 take.json —— 那里记的是每个镜头**实际**的起始时刻
与旁白起点，所以模型流式输出快慢不影响音画同步。

用法：
  python build.py --take ../out/promo-take.json --script ../script/promo.json \
                  --tts ../assets/voice/promo/tts.json \
                  --silent ../out/promo-silent.mp4 --bgm ../assets/bgm-promo.wav \
                  --out ../out/promo.mp4
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import wave

import numpy as np

SR = 44100


def read_wav(path: str):
    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        ch = w.getnchannels()
        raw = w.readframes(w.getnframes())
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a, rate


def resample(a: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return a
    n = int(len(a) * sr_out / sr_in)
    x = np.linspace(0, len(a) - 1, n)
    return np.interp(x, np.arange(len(a)), a).astype(np.float32)


def fade(seg: np.ndarray, ms: float = 18.0) -> np.ndarray:
    k = max(1, int(SR * ms / 1000))
    if len(seg) < 2 * k:
        return seg
    env = np.ones(len(seg), dtype=np.float32)
    env[:k] = np.linspace(0, 1, k)
    env[-k:] = np.linspace(1, 0, k)
    return seg * env


def db(x: float) -> float:
    return float(10 ** (x / 20.0))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--take", required=True)
    ap.add_argument("--script", required=True)
    ap.add_argument("--tts", required=True)
    ap.add_argument("--silent", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bgm", default="")
    ap.add_argument("--bgm-gain", type=float, default=-30.0, help="BGM 增益 dB（相对满刻度）")
    ap.add_argument("--voice-gain", type=float, default=-1.2, help="旁白峰值 dB")
    ap.add_argument("--srt", default="")
    ap.add_argument("--audio-only", action="store_true")
    ap.add_argument("--ffmpeg", default="")
    a = ap.parse_args()

    import imageio_ffmpeg
    a.ffmpeg = a.ffmpeg or imageio_ffmpeg.get_ffmpeg_exe()

    take = json.load(open(a.take, encoding="utf-8"))
    script = json.load(open(a.script, encoding="utf-8"))
    tts = json.load(open(a.tts, encoding="utf-8"))
    voice_dir = os.path.dirname(os.path.abspath(a.tts))
    by_id = {s["id"]: s for s in script["shots"]}

    duration = float(take["duration"]) + 1.2
    total = int(duration * SR)
    track = np.zeros(total, dtype=np.float32)

    placed = []
    for shot in take["shots"]:
        sid = shot["id"]
        line = tts["lines"].get(sid)
        if not line:
            continue
        wav = os.path.join(voice_dir, line["file"])
        if not os.path.isfile(wav):
            print("  !! 缺少配音", wav)
            continue
        v, sr = read_wav(wav)
        v = resample(v, sr, SR)
        lead = float(line.get("lead", 0.0))
        speech = float(line.get("speech", 0.0))
        s0 = max(0, int((lead - 0.03) * SR))
        s1 = min(len(v), int((lead + speech + 0.12) * SR))
        seg = fade(v[s0:s1])
        at = int(float(shot["narration_at"]) * SR)
        end = min(total, at + len(seg))
        if end > at:
            track[at:end] += seg[: end - at]
        placed.append((sid, float(shot["narration_at"]), len(seg) / SR,
                       float(shot["narration_at"]) + speech))

    # 旁白归一化
    peak = float(np.abs(track).max()) or 1.0
    track *= db(a.voice_gain) / peak
    print(f"[mix] 旁白：{len(placed)} 句，峰值归一到 {a.voice_gain} dBFS")

    stereo = np.stack([track, track], axis=1)

    if a.bgm and os.path.isfile(a.bgm):
        b, sr = read_wav(a.bgm)
        b = resample(b, sr, SR)
        if len(b) < total:
            reps = int(np.ceil(total / len(b)))
            b = np.tile(b, reps)
        b = b[:total]
        k = int(SR * 2.5)
        env = np.ones(len(b), dtype=np.float32)
        env[:k] = np.linspace(0, 1, k)
        env[-k:] = np.linspace(1, 0, k)
        g = db(a.bgm_gain)
        stereo[:, 0] += b * env * g
        stereo[:, 1] += b * env * g
        print(f"[mix] BGM：{os.path.basename(a.bgm)} 增益 {a.bgm_gain} dB")
    else:
        print("[mix] 未使用 BGM")

    peak = float(np.abs(stereo).max())
    if peak > 0.99:
        stereo *= 0.99 / peak
        print(f"[mix] 限幅：整体衰减 {20*np.log10(0.99/peak):.2f} dB")
    out_audio = os.path.splitext(a.out)[0] + "-audio.wav"
    with wave.open(out_audio, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((stereo * 32767.0).astype(np.int16).tobytes())
    print(f"[mix] 音轨 → {out_audio}（{duration:.1f}s，峰值 {20*np.log10(max(peak,1e-9)):.1f} dBFS）")

    # 字幕
    if a.srt:
        blocks = []
        for shot in take["shots"]:
            sid = shot["id"]
            text = (by_id.get(sid, {}).get("narration") or "").strip()
            if not text:
                continue
            t0 = float(shot["narration_at"])
            dur = float(shot.get("speech", 0.0)) or len(text) / 4.4
            # 长句按标点在时间上按比例拆成两块
            if len(text) > 26:
                # 在靠近中间的标点处断句，避免把「Edge 侧边栏」这类词组从中间切开
                cands = [i for i, ch in enumerate(text) if ch in "。！？；：，、 " and 4 <= i <= len(text) - 5]
                # 空格也允许断句，但加权惩罚：真标点优先，避免把「Edge 侧边栏」拆开
                cut = (min(cands, key=lambda i: abs(i - len(text) / 2)
                           + (0 if text[i] in "。！？；：，" else 7)) if cands else len(text) // 2)
                if cut <= 0 or cut >= len(text) - 1:
                    cut = len(text) // 2
                head, tail = text[: cut + 1], text[cut + 1 :]
                mid = t0 + dur * len(head) / len(text)
                blocks.append((t0, mid - 0.04, head))
                blocks.append((mid, t0 + dur + 0.5, tail))
            else:
                blocks.append((t0, t0 + dur + 0.5, text))

        def ts(t: float) -> str:
            h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
            return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")

        with open(a.srt, "w", encoding="utf-8") as f:
            for i, (t0, t1, txt) in enumerate(blocks, 1):
                f.write(f"{i}\n{ts(t0)} --> {ts(t1)}\n{txt}\n\n")
        print(f"[mix] 字幕 → {a.srt}（{len(blocks)} 条）")

    if a.audio_only:
        return 0

    cmd = [a.ffmpeg, "-y", "-loglevel", "error",
           "-i", a.silent, "-i", out_audio,
           "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", "-shortest", a.out]
    subprocess.run(cmd, check=True)
    size = os.path.getsize(a.out) / 1e6
    print(f"[mix] 成片 → {a.out}（{size:.1f} MB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
