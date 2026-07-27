#!/usr/bin/env python3
"""
ab_compare.py — A/B harness for transcribe.py changes.

Runs transcribe.py twice on each given audio file — once with VAD (the new
default) and once with --no-vad (the old behaviour) — and reports wall
time, output size, speech stats, and a rough text-similarity score, so a
change can be judged on real recordings before it's trusted in the app.

Usage:
    python ab_compare.py --whisper-model mlx-community/whisper-large-v3-mlx \
        recording1.mp3 [recording2.m4a ...]

The similarity score is difflib's ratio over normalised words: ~1.0 means
the transcripts agree; a low score on a quiet recording usually means one
side hallucinated (inspect the diff files it writes next to each input).
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent


def run_transcribe(audio: Path, model: str, extra_args: list[str]) -> tuple[dict, float]:
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "transcribe.py"),
        "--audio",
        str(audio),
        "--whisper-model",
        model,
        *extra_args,
    ]
    started = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.monotonic() - started
    if proc.returncode != 0:
        raise RuntimeError(f"transcribe.py failed ({proc.returncode}): {proc.stderr[-500:]}")
    return json.loads(proc.stdout), elapsed


def normalise_words(text: str) -> list[str]:
    return re.findall(r"[\w']+", text.lower())


def main() -> int:
    p = argparse.ArgumentParser(description="A/B compare transcribe.py with and without VAD.")
    p.add_argument("--whisper-model", required=True, help="MLX Whisper model id to use for both runs")
    p.add_argument("audio", nargs="+", type=Path, help="Audio file(s) to compare on")
    args = p.parse_args()

    for audio in args.audio:
        print(f"\n=== {audio.name} ===")
        base, base_time = run_transcribe(audio, args.whisper_model, ["--no-vad"])
        vad, vad_time = run_transcribe(audio, args.whisper_model, [])

        base_words = normalise_words(base["text"])
        vad_words = normalise_words(vad["text"])
        similarity = difflib.SequenceMatcher(None, base_words, vad_words).ratio()

        stats = vad.get("vad") or {}
        speedup = base_time / vad_time if vad_time > 0 else float("inf")
        print(f"  no-vad : {base_time:7.1f}s  {len(base_words):6d} words")
        print(f"  vad    : {vad_time:7.1f}s  {len(vad_words):6d} words   speedup ×{speedup:.2f}")
        if stats:
            print(
                f"  speech : {stats.get('speech_seconds', '?')}s of {stats.get('total_seconds', '?')}s"
                f" ({stats.get('speech_ratio', 0) * 100:.0f}%),"
                f" {stats.get('segments', '?')} segments,"
                f" {stats.get('removed_seconds', '?')}s removed"
            )
        print(f"  word-level similarity: {similarity:.3f}")

        # Full outputs for eyeballing where they disagree.
        for label, result in (("no-vad", base), ("vad", vad)):
            out_path = audio.with_suffix(f".{label}.txt")
            out_path.write_text(result["text"], encoding="utf-8")
            print(f"  wrote {out_path.name}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
