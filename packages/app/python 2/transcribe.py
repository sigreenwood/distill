#!/usr/bin/env python3
"""
transcribe.py — MLX Whisper transcription for distill.

Input (CLI args):
    --audio <path>            path to the audio file
    --whisper-model <id>      HuggingFace model id, e.g. mlx-community/whisper-large-v3-mlx
    --language <lang>         optional two-letter language hint

Output (stdout):
    A single JSON object with:
        text: the full transcript as plain text (paragraphs separated by blank lines)
        language: detected language
        model: model id used
        duration_seconds: audio duration

Progress (stderr):
    One JSON line per update: {"phase": "transcribe", "progress": 0.42}

v1 does not diarise. The transcript is a single continuous text, split into
paragraphs on longer pauses between Whisper segments.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path


# Threshold (seconds) of silence between consecutive Whisper segments that
# triggers a paragraph break. Tuned empirically; adjust if paragraphs feel
# too chunky or too sparse in the output.
PARAGRAPH_GAP_SECONDS = 1.5


@dataclass
class Args:
    audio: Path
    whisper_model: str
    language: str | None
    initial_prompt: str | None


def parse_args(argv: list[str]) -> Args:
    p = argparse.ArgumentParser(description="Transcribe an audio file with MLX Whisper.")
    p.add_argument("--audio", required=True, type=Path, help="Path to the audio file")
    p.add_argument(
        "--whisper-model",
        required=True,
        help="MLX Whisper HuggingFace model id",
    )
    p.add_argument("--language", default=None, help="Optional language hint (e.g. 'en')")
    p.add_argument(
        "--initial-prompt",
        default=None,
        help="Optional vocabulary primer biasing Whisper's recognition. Typically a"
        " short list of domain-specific proper nouns / acronyms the speaker uses.",
    )
    ns = p.parse_args(argv)
    return Args(
        audio=ns.audio,
        whisper_model=ns.whisper_model,
        language=ns.language,
        initial_prompt=ns.initial_prompt,
    )


def emit_progress(phase: str, progress: float) -> None:
    sys.stderr.write(json.dumps({"phase": phase, "progress": progress}) + "\n")
    sys.stderr.flush()


def flatten_segments_to_paragraphs(segments: list[dict]) -> str:
    """Join Whisper segments into paragraphs separated by blank lines.

    A new paragraph starts whenever the gap between the previous segment's end
    and the current segment's start exceeds PARAGRAPH_GAP_SECONDS.
    """
    if not segments:
        return ""

    paragraphs: list[list[str]] = [[]]
    prev_end: float | None = None

    for seg in segments:
        text = seg.get("text", "").strip()
        if not text:
            continue
        start = float(seg.get("start", 0.0))
        if prev_end is not None and (start - prev_end) > PARAGRAPH_GAP_SECONDS:
            paragraphs.append([])
        paragraphs[-1].append(text)
        prev_end = float(seg.get("end", start))

    return "\n\n".join(" ".join(p) for p in paragraphs if p)


def transcribe(args: Args) -> dict:
    if not args.audio.exists():
        raise FileNotFoundError(f"Audio file not found: {args.audio}")

    # Import here (not at module top) so that `--help` and argument parsing
    # stay fast and don't require mlx to be installed just to print help.
    import mlx_whisper

    emit_progress("transcribe", 0.0)

    kwargs: dict = {}
    if args.language:
        kwargs["language"] = args.language
    if args.initial_prompt:
        # MLX Whisper forwards this through to the underlying Whisper model,
        # which uses it to bias its language-model layer. Keep short —
        # Whisper truncates beyond ~200 tokens.
        kwargs["initial_prompt"] = args.initial_prompt

    # Disable the per-segment conditioning that feeds prior segments back
    # into the language model as context for the next one.
    #
    # Whisper's default (condition_on_previous_text=True) is meant to give
    # the model coherence across long audio. In practice it is the single
    # biggest cause of the "Repeat Repeat Repeat..." / "Yeah. Yeah. Yeah..."
    # hallucination loops that the transcriptCleanup module has to mop up
    # afterwards: once a hallucinated phrase enters the conditioning
    # context, the model loops on it for hundreds of tokens at a stretch.
    # The 04-22 HSBC meeting in Si's outputs is a textbook example.
    #
    # Trade-off: very minor coherence loss across segment boundaries (a
    # speaker mid-sentence at a segment cut may have the second half
    # transcribed without the first half as context). For the kinds of
    # business meetings distill processes, this is the right call —
    # business speech is generally well-bounded by sentences and the
    # silences Whisper uses to cut segments tend to fall at sentence
    # boundaries anyway. The cleanup module stays in place as a belt-
    # and-braces second line of defence.
    kwargs["condition_on_previous_text"] = False

    result = mlx_whisper.transcribe(
        str(args.audio),
        path_or_hf_repo=args.whisper_model,
        **kwargs,
    )

    emit_progress("transcribe", 1.0)

    segments = result.get("segments", [])
    text = flatten_segments_to_paragraphs(segments)
    duration = 0.0
    if segments:
        duration = float(segments[-1].get("end", 0.0))

    return {
        "text": text,
        "language": result.get("language", "unknown"),
        "model": args.whisper_model,
        "duration_seconds": duration,
    }


def main() -> int:
    try:
        args = parse_args(sys.argv[1:])
        output = transcribe(args)
        sys.stdout.write(json.dumps(output, ensure_ascii=False))
        sys.stdout.write("\n")
        return 0
    except Exception as e:
        sys.stderr.write(json.dumps({"error": str(e)}) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
