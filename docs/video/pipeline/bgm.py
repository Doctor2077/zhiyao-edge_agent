#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""极简氛围电子 BGM 合成器：纯 numpy + 标准库 wave，无第三方依赖。

生成两段立体声 WAV：
  - bgm-promo.wav    100 秒（产品宣传片垫底音乐）
  - bgm-tutorial.wav 360 秒（教程垫底音乐）

和声：Am - F - C - G 循环，每 4 秒换一次。
"""

import os
import random
import wave

import numpy as np

SR = 44100
CHORD_SECONDS = 4.0
FADE_SECONDS = 2.5

# 响度目标：RMS 打到 -27 dBFS（落在 -28 ~ -24 内），峰值压到 <= -12.5 dBFS。
TARGET_RMS_DB = -27.0
TARGET_PEAK_DB = -12.5

# 固定随机种子：两段音轨各用一个稳定种子，保证逐字节可复现。
SEEDS = {
    "promo": 20240601,
    "tutorial": 20240602,
}

# 和弦（MIDI 音高）：根音 + 三音 + 五音，再补一个高八度根音，作为缓慢的铺底。
CHORDS = {
    "Am": [45, 57, 60, 64],   # A2 A3 C4 E4
    "F":  [41, 53, 57, 60],   # F2 F3 A3 C4
    "C":  [48, 52, 55, 60],   # C3 E3 G3 C4
    "G":  [43, 50, 55, 59],   # G2 D3 G3 B3
}
PROGRESSION = ["Am", "F", "C", "G"]

# 钟琴式点缀：只从当前和弦内音（及其高八度）里选，避免和铺底打架。
PLUCK_POOL = {
    "Am": [69, 72, 76, 81],   # A4 C5 E5 A5
    "F":  [65, 69, 72, 77],   # F4 A4 C5 F5
    "C":  [67, 72, 76, 79],   # G4 C5 E5 G5
    "G":  [62, 67, 71, 74],   # D4 G4 B4 D5
}

# ---- 音色参数 ----
PAD_ATTACK = 1.0
PAD_RELEASE = 1.5
PAD_SINE_MIX = 0.72
PAD_TRI_MIX = 0.28
PAD_AMP_PER_NOTE = 0.026
PAD_PHASE_OFFSET = 0.35  # 左右声道相位差，制造轻微宽度

PULSE_PERIOD = 2.0       # 每 2 秒一次极轻低频脉冲
PULSE_DURATION = 1.3
PULSE_SINE_MIX = 0.82
PULSE_TRI_MIX = 0.18
PULSE_AMP = 0.050
PULSE_PHASE_OFFSET = 0.50

PLUCK_LENGTH = 3.0
PLUCK_ATTACK = 0.006
PLUCK_DECAY_MIN = 0.55
PLUCK_DECAY_MAX = 1.15
PLUCK_AMP = 0.055


def midi_hz(n: int) -> float:
    return 440.0 * (2.0 ** ((n - 69) / 12.0))


def db_from_lin(x: float) -> float:
    return 20.0 * np.log10(max(float(x), 1e-12))


def _tri(phase: np.ndarray) -> np.ndarray:
    """正弦相位 -> 三角波（仅用 numpy 基础函数）。"""
    return (2.0 / np.pi) * np.arcsin(np.sin(phase))


def _pad_envelope(n: int) -> np.ndarray:
    """整段和弦块的 ADSR 风格包络：余弦起音 + 余弦释音。"""
    t = np.arange(n, dtype=np.float64) / SR
    env = np.ones(n, dtype=np.float64)

    a = np.clip(t / PAD_ATTACK, 0.0, 1.0)
    env *= 0.5 * (1.0 - np.cos(np.pi * a))

    release_start = (n - 1) / SR - PAD_RELEASE
    r = np.clip((t - release_start) / PAD_RELEASE, 0.0, 1.0)
    env *= 0.5 * (1.0 + np.cos(np.pi * r))
    return env


def _add_chord_block(master: np.ndarray, chord_name: str, rng: random.Random,
                     start: int) -> None:
    """往 master 中叠加一段 4 秒和弦（含 1.5 秒释音尾巴，用于段落间交叉）。"""
    block_n = int(round(CHORD_SECONDS * SR))
    n = block_n + int(round(PAD_RELEASE * SR))
    t = np.arange(n, dtype=np.float64) / SR
    env = _pad_envelope(n)
    amp = PAD_AMP_PER_NOTE / max(1, len(CHORDS[chord_name]))

    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)

    for midi in CHORDS[chord_name]:
        freq = midi_hz(midi)
        phase_l = rng.uniform(0.0, 2.0 * np.pi)
        phase = 2.0 * np.pi * freq * t + phase_l

        sine_l = np.sin(phase)
        tri_l = _tri(phase)
        mono_l = (PAD_SINE_MIX * sine_l + PAD_TRI_MIX * tri_l) * env * amp

        phase_r = phase + PAD_PHASE_OFFSET
        sine_r = np.sin(phase_r)
        tri_r = _tri(phase_r)
        mono_r = (PAD_SINE_MIX * sine_r + PAD_TRI_MIX * tri_r) * env * amp

        left += mono_l
        right += mono_r

    total = master.shape[0]
    if start >= total:
        return
    n_use = min(n, total - start)
    master[start:start + n_use, 0] += left[:n_use]
    master[start:start + n_use, 1] += right[:n_use]


def _add_pulses(master: np.ndarray, rng: random.Random) -> None:
    """极轻的低频正弦/三角脉冲，与和弦根音同音名、低一个八度。"""
    total = master.shape[0]
    dur = total / SR
    n_pulse = int(round(PULSE_DURATION * SR))
    t = np.arange(n_pulse, dtype=np.float64) / SR
    env = np.sin(np.pi * np.clip(t / PULSE_DURATION, 0.0, 1.0)) ** 2

    onset = 0.0
    while onset < dur - 0.05:
        chord_idx = int(onset // CHORD_SECONDS) % len(PROGRESSION)
        chord_name = PROGRESSION[chord_idx]
        root_midi = CHORDS[chord_name][0] - 12  # 根音再低一个八度
        freq = midi_hz(root_midi)

        phase_l = rng.uniform(0.0, 2.0 * np.pi)
        phase = 2.0 * np.pi * freq * t + phase_l
        mono_l = (PULSE_SINE_MIX * np.sin(phase)
                  + PULSE_TRI_MIX * _tri(phase)) * env * PULSE_AMP
        phase_r = phase + PULSE_PHASE_OFFSET
        mono_r = (PULSE_SINE_MIX * np.sin(phase_r)
                  + PULSE_TRI_MIX * _tri(phase_r)) * env * PULSE_AMP

        pos = int(round(onset * SR))
        n_use = min(n_pulse, total - pos)
        if n_use > 0:
            master[pos:pos + n_use, 0] += mono_l[:n_use]
            master[pos:pos + n_use, 1] += mono_r[:n_use]

        onset += PULSE_PERIOD


def _add_plucks(master: np.ndarray, rng: random.Random) -> None:
    """稀疏的钟琴式点缀：快速起音 + 指数衰减，随机声像分布。"""
    total = master.shape[0]
    dur = total / SR
    n_pluck = int(round(PLUCK_LENGTH * SR))
    t = np.arange(n_pluck, dtype=np.float64) / SR
    attack = np.clip(t / PLUCK_ATTACK, 0.0, 1.0)

    events = []
    event_t = rng.uniform(0.8, 2.8)
    while event_t < dur - 1.0:
        events.append(event_t)
        event_t += rng.uniform(2.2, 4.8)

    for event_t in events:
        chord_idx = int(event_t // CHORD_SECONDS) % len(PROGRESSION)
        chord_name = PROGRESSION[chord_idx]
        pool = PLUCK_POOL[chord_name]
        midi = rng.choice(pool)
        if rng.random() < 0.20:
            midi += 12  # 偶尔翻高八度，增加一点空气感
        freq = midi_hz(midi)

        amp = PLUCK_AMP * rng.uniform(0.50, 1.00)
        decay = rng.uniform(PLUCK_DECAY_MIN, PLUCK_DECAY_MAX)
        pan = rng.uniform(0.10, 0.90)  # 0=左，1=右
        left_gain = float(np.cos(pan * np.pi / 2.0))
        right_gain = float(np.sin(pan * np.pi / 2.0))

        phase_l = rng.uniform(0.0, 2.0 * np.pi)
        phase = 2.0 * np.pi * freq * t + phase_l
        phase_shimmer = 2.0 * np.pi * freq * 2.76 * t + phase_l

        env = attack * np.exp(-t / decay)
        # 基频正弦 + 三角波 + 极轻的高八度泛音（仍是正弦叠加），接近钟琴质感。
        mono = amp * env * (
            0.55 * np.sin(phase)
            + 0.30 * _tri(phase)
            + 0.15 * np.sin(phase_shimmer)
        )

        pos = int(round(event_t * SR))
        n_use = min(n_pluck, total - pos)
        if n_use > 0:
            master[pos:pos + n_use, 0] += mono[:n_use] * left_gain
            master[pos:pos + n_use, 1] += mono[:n_use] * right_gain


def _apply_fade(master: np.ndarray) -> None:
    """首尾各 2.5 秒余弦淡入淡出。"""
    total = master.shape[0]
    fade_n = min(int(round(FADE_SECONDS * SR)), total // 2)
    ramp_in = np.sin(0.5 * np.pi * np.linspace(0.0, 1.0, fade_n))
    ramp_out = np.cos(0.5 * np.pi * np.linspace(0.0, 1.0, fade_n))
    master[:fade_n, :] *= ramp_in[:, None]
    master[-fade_n:, :] *= ramp_out[:, None]


def _render(duration_sec: float, seed: int) -> np.ndarray:
    total = int(round(duration_sec * SR))
    master = np.zeros((total, 2), dtype=np.float64)
    rng = random.Random(seed)

    block_n = int(round(CHORD_SECONDS * SR))
    start = 0
    idx = 0
    while start < total:
        chord_name = PROGRESSION[idx % len(PROGRESSION)]
        _add_chord_block(master, chord_name, rng, start)
        start += block_n
        idx += 1

    _add_pulses(master, rng)
    _add_plucks(master, rng)
    _apply_fade(master)

    # 归一化：优先把 RMS 定到目标值；若会超过峰值上限，则以峰值上限为准。
    peak = float(np.max(np.abs(master)))
    rms = float(np.sqrt(np.mean(master * master)))
    peak_db = db_from_lin(peak)
    rms_db = db_from_lin(rms)
    gain_db = min(TARGET_RMS_DB - rms_db, TARGET_PEAK_DB - peak_db)
    gain = 10.0 ** (gain_db / 20.0)
    master *= gain

    final_peak_db = db_from_lin(np.max(np.abs(master)))
    final_rms_db = db_from_lin(np.sqrt(np.mean(master * master)))
    return master, final_peak_db, final_rms_db


def _write_wav(path: str, master: np.ndarray) -> None:
    pcm = np.clip(np.round(master * 32767.0), -32768.0, 32767.0).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.normpath(os.path.join(here, "..", "assets"))
    os.makedirs(assets_dir, exist_ok=True)

    jobs = {
        "promo": (100.0, os.path.join(assets_dir, "bgm-promo.wav")),
        "tutorial": (360.0, os.path.join(assets_dir, "bgm-tutorial.wav")),
    }

    for name, (duration, path) in jobs.items():
        master, peak_db, rms_db = _render(duration, SEEDS[name])
        _write_wav(path, master)
        print(
            f"[{name}] {os.path.basename(path)} | "
            f"duration={master.shape[0] / SR:.3f}s | "
            f"peak={peak_db:.2f} dBFS | rms={rms_db:.2f} dBFS | "
            f"bytes={os.path.getsize(path)}"
        )


if __name__ == "__main__":
    main()
