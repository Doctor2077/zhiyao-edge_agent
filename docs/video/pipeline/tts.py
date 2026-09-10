#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地配音：把分镜脚本里的旁白逐句合成为 wav，并量出每句的真实时长。

用 Windows 自带的中文语音（System.Speech / SAPI），完全离线、零成本。
输出：
  assets/voice/<video>/<shot>.wav   逐句配音（44.1kHz / 16bit / 单声道）
  assets/voice/<video>/tts.json     每句的时长与静音裁剪信息 —— 时间轴的唯一依据

关键点：**时间轴由配音时长驱动**。先量出每句念多久，再决定画面怎么排，
这样字幕、画面动作、旁白天然对齐，不需要猜。

用法：
  python tts.py --script ../script/promo.json --out ../assets/voice/promo
  python tts.py --script ../script/promo.json --out ../assets/voice/promo --rate 2
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PS_TEMPLATE = r"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('{voice}')
$s.Rate = {rate}
$s.Volume = 100
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('{out}', $fmt)
$s.Speak([Console]::In.ReadToEnd())
$s.Dispose()
"""


def synth(text: str, out_path: str, voice: str, rate: int) -> None:
    ps = PS_TEMPLATE.format(voice=voice.replace("'", "''"),
                            rate=rate,
                            out=out_path.replace("\\", "\\\\").replace("'", "''"))
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    p = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       input=text.encode("utf-8"), capture_output=True, env=env)
    if p.returncode != 0 or not os.path.isfile(out_path):
        raise RuntimeError("TTS 失败：" + p.stderr.decode("utf-8", "replace")[:500])


def analyse(path: str, thresh_db: float = -45.0) -> dict:
    """量时长，并用 RMS 找到真正的语音起止（SAPI 头尾会带静音）。"""
    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    win = max(1, int(rate * 0.01))  # 10ms
    frames = a[: len(a) // win * win].reshape(-1, win)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-9)
    db = 20 * np.log10(rms / 32768.0 + 1e-9)
    voiced = np.where(db > thresh_db)[0]
    total = len(a) / rate
    if len(voiced) == 0:
        return {"rate": rate, "total": round(total, 3), "lead": 0.0, "speech": round(total, 3),
                "tail": 0.0, "peak_db": -99.0, "rms_db": -99.0}
    lead = voiced[0] * win / rate
    end = min(len(a), (voiced[-1] + 1) * win)
    speech = (end - voiced[0] * win) / rate
    peak = 20 * np.log10(np.abs(a).max() / 32768.0 + 1e-9)
    rms_all = 20 * np.log10(np.sqrt((a ** 2).mean()) / 32768.0 + 1e-9)
    return {"rate": rate, "total": round(total, 3), "lead": round(lead, 3),
            "speech": round(speech, 3), "tail": round(total - lead - speech, 3),
            "peak_db": round(float(peak), 1), "rms_db": round(float(rms_all), 1)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="Microsoft Huihui Desktop")
    ap.add_argument("--rate", type=int, default=1, help="语速 -10..10，0 为默认")
    ap.add_argument("--only", default="", help="只合成指定 shot id（逗号分隔）")
    a = ap.parse_args()

    with open(a.script, encoding="utf-8") as f:
        script = json.load(f)
    out_dir = os.path.abspath(a.out)
    os.makedirs(out_dir, exist_ok=True)
    only = {s.strip() for s in a.only.split(",") if s.strip()}

    lines = {}
    for shot in script["shots"]:
        text = (shot.get("narration") or "").strip()
        if not text:
            continue
        sid = shot["id"]
        if only and sid not in only:
            continue
        wav = os.path.join(out_dir, sid + ".wav")
        synth(text, wav, a.voice, a.rate)
        info = analyse(wav)
        info["text"] = text
        info["file"] = os.path.basename(wav)
        lines[sid] = info
        print(f"  {sid:<4} {info['speech']:6.2f}s  语音（含头尾静音 {info['total']:.2f}s）  "
              f"峰值 {info['peak_db']:6.1f}dB   {text[:26]}…", flush=True)

    meta = {"video": script.get("id"), "voice": a.voice, "rate": a.rate, "lines": lines}
    with open(os.path.join(out_dir, "tts.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    total = sum(v["speech"] for v in lines.values())
    print(f"\n共 {len(lines)} 句，纯语音合计 {total:.1f}s（不含句间留白）")
    print("已写", os.path.join(out_dir, "tts.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
