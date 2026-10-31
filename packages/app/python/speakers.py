"""
speakers.py — turn two per-track transcripts into one labelled conversation.

A recorded call arrives as two tracks: the user's microphone ("You") and the
system audio, which is everyone else on the call mixed together ("Others").
Each track is transcribed on its own, so who spoke is known from where the
words came from, not guessed from the voice. This module does the parts that
are not ASR:

  * map ASR timestamps from VAD-compacted audio back to the original timeline
    (the two tracks are only comparable on the original one),
  * drop microphone segments that are just the speakers' sound bleeding into
    the mic (without headphones, the mic hears the other side of the call),
  * interleave the two tracks into turns and render them as text.

Pure functions over plain dicts/arrays — no model, no I/O — so it is unit
tested without MLX (see test_speakers.py).
"""

from __future__ import annotations

import re

SAMPLE_RATE = 16_000

# Consecutive segments from one speaker join into one turn unless separated
# by more than this much silence.
TURN_GAP_SECONDS = 4.0

# --- echo suppression ------------------------------------------------------
# A mic segment is considered echo only if the other side was audibly talking
# for a good part of it AND it either says the same words or follows the same
# loudness contour. Either test alone is weak (real people overlap and repeat
# each other; loudness contours of any two speech signals correlate a little),
# the pair together is not. Measured: 200 unrelated speech-like pairs topped
# out at a contour correlation of 0.75 (p99 0.64); simulated bleed gave
# 0.92-0.99; bleed recorded through real speakers and a real mic gave
# 0.76-0.94 while its text similarity was 1.00 every time. So words are the
# dependable signal and the contour is a backstop for garbled echo — kept
# conservative at 0.85 because dropping the user's own words is worse than
# leaving a duplicate line. Re-check against real calls.
ECHO_MIN_OVERLAP = 0.4        # fraction of the mic segment the others were speaking
ECHO_RANGE_PAD_SECONDS = 0.5  # tolerance for ASR boundary jitter and speaker->mic delay
ECHO_TEXT_SIMILARITY = 0.5    # shared-word fraction that marks identical speech
ECHO_MIN_WORDS_FOR_TEXT = 3   # too few words to judge by text alone
ECHO_ENVELOPE_CORR = 0.85     # loudness-contour correlation that marks a copy
ENVELOPE_FRAME_SECONDS = 0.02
ENVELOPE_MAX_LAG_SECONDS = 0.3


# --- timeline mapping ------------------------------------------------------

# One kept speech run in the VAD-compacted audio:
#   (start in compacted audio, start in original audio, length), all seconds.
Piece = tuple[float, float, float]


def map_time(t: float, pieces: list[Piece] | None, edge: str) -> float:
    """Map a time in VAD-compacted audio back to the original recording.

    `pieces` None means no VAD ran and the timelines are identical. A time
    inside inserted join-silence has no original counterpart; a segment
    *start* there snaps forward to the next speech run and an *end* snaps back
    to the previous one, so segments never grow to cover removed dead air.
    """
    if not pieces:
        return t
    prev_end: float | None = None
    for g0, o0, dur in pieces:
        if t < g0:
            return o0 if (edge == "start" or prev_end is None) else prev_end
        if t < g0 + dur:
            return o0 + (t - g0)
        prev_end = o0 + dur
    return prev_end if prev_end is not None else t


def remap_segments(segments: list[dict], pieces: list[Piece] | None) -> list[dict]:
    """Return segments with start/end on the original timeline."""
    out = []
    for seg in segments:
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        s = map_time(float(seg["start"]), pieces, "start")
        e = map_time(float(seg["end"]), pieces, "end")
        out.append({"start": s, "end": max(e, s), "text": text})
    return out


# --- echo suppression ------------------------------------------------------


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def text_similarity(a: str, b: str) -> float:
    """Shared-word fraction relative to the shorter text (overlap coefficient)."""
    wa, wb = set(_words(a)), set(_words(b))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


def _envelope(audio, start: float, end: float):
    """Frame-by-frame RMS loudness of audio[start:end]."""
    import numpy as np

    frame = int(ENVELOPE_FRAME_SECONDS * SAMPLE_RATE)
    chunk = np.asarray(audio[int(start * SAMPLE_RATE) : int(end * SAMPLE_RATE)], dtype=np.float32)
    n = len(chunk) // frame
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    return np.sqrt((chunk[: n * frame].reshape(n, frame) ** 2).mean(axis=1))


def envelope_correlation(a, b, start: float, end: float) -> float:
    """Best normalised correlation of the two tracks' loudness contours over
    [start, end], allowing the delay a speaker->mic path introduces."""
    import numpy as np

    ea, eb = _envelope(a, start, end), _envelope(b, start, end)
    n = min(len(ea), len(eb))
    if n < 5:
        return 0.0
    ea, eb = ea[:n], eb[:n]
    max_lag = int(ENVELOPE_MAX_LAG_SECONDS / ENVELOPE_FRAME_SECONDS)
    best = 0.0
    for lag in range(-max_lag, max_lag + 1):
        x = ea[max(0, lag) :] if lag >= 0 else ea[: n + lag]
        y = eb[: n - lag] if lag >= 0 else eb[-lag:]
        m = min(len(x), len(y))
        if m < 5:
            continue
        x, y = x[:m] - x[:m].mean(), y[:m] - y[:m].mean()
        denom = float(np.sqrt((x * x).sum() * (y * y).sum()))
        if denom > 0:
            best = max(best, float((x * y).sum() / denom))
    return best


def _overlap_fraction(seg: dict, ranges: list[tuple[float, float]]) -> float:
    length = seg["end"] - seg["start"]
    if length <= 0:
        return 0.0
    covered = 0.0
    for s, e in ranges:
        covered += max(0.0, min(seg["end"], e) - max(seg["start"], s))
    return min(1.0, covered / length)


def suppress_echo(
    you: list[dict],
    others: list[dict],
    you_audio,
    others_audio,
) -> tuple[list[dict], list[dict]]:
    """Split the mic segments into (kept, dropped-as-echo)."""
    ranges = [(o["start"] - ECHO_RANGE_PAD_SECONDS, o["end"] + ECHO_RANGE_PAD_SECONDS) for o in others]
    kept: list[dict] = []
    dropped: list[dict] = []
    for seg in you:
        if _overlap_fraction(seg, ranges) < ECHO_MIN_OVERLAP:
            kept.append(seg)
            continue
        concurrent = " ".join(
            o["text"]
            for o in others
            if o["end"] + ECHO_RANGE_PAD_SECONDS > seg["start"] and o["start"] - ECHO_RANGE_PAD_SECONDS < seg["end"]
        )
        same_words = (
            len(_words(seg["text"])) >= ECHO_MIN_WORDS_FOR_TEXT
            and text_similarity(seg["text"], concurrent) >= ECHO_TEXT_SIMILARITY
        )
        same_contour = envelope_correlation(you_audio, others_audio, seg["start"], seg["end"]) >= ECHO_ENVELOPE_CORR
        (dropped if (same_words or same_contour) else kept).append(seg)
    return kept, dropped


# --- turns and rendering ---------------------------------------------------


def build_turns(you: list[dict], others: list[dict]) -> list[dict]:
    """Interleave both tracks by start time into speaker turns."""
    tagged = [dict(s, speaker="You") for s in you] + [dict(s, speaker="Others") for s in others]
    tagged.sort(key=lambda s: (s["start"], s["end"]))
    turns: list[dict] = []
    for seg in tagged:
        last = turns[-1] if turns else None
        if last and last["speaker"] == seg["speaker"] and seg["start"] - last["end"] <= TURN_GAP_SECONDS:
            last["text"] += " " + seg["text"]
            last["end"] = max(last["end"], seg["end"])
        else:
            turns.append({"speaker": seg["speaker"], "start": seg["start"], "end": seg["end"], "text": seg["text"]})
    return turns


def render_turns(turns: list[dict]) -> str:
    return "\n\n".join(f"{t['speaker']}: {t['text']}" for t in turns)
