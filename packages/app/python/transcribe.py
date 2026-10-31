#!/usr/bin/env python3
"""
transcribe.py — MLX Whisper / Parakeet MLX transcription for distill.

Input (CLI args):
    --audio <path>            path to the audio file
    --mic-audio <path>        optional second track (the user's microphone only); turns
                               on speaker labelling — see speakers.py
    --engine <whisper|parakeet>  which ASR engine to use (default whisper)
    --whisper-model <id>      HuggingFace model id, e.g. mlx-community/whisper-large-v3-mlx
                               (required when --engine whisper)
    --parakeet-model <id>     HuggingFace model id for Parakeet MLX
                               (default mlx-community/parakeet-tdt-0.6b-v3)
    --language <lang>         optional two-letter language hint (whisper only)
    --initial-prompt <text>   vocabulary primer (whisper only — see below)
    --no-vad                  disable Silero VAD speech gating
    --vad-threshold <p>       speech probability threshold (default 0.35)

Output (stdout):
    A single JSON object with:
        text: the full transcript as plain text (paragraphs separated by blank lines)
        language: detected language ("unknown" for parakeet, which doesn't report one)
        model: model id actually used (whisper or parakeet, whichever ran)
        duration_seconds: audio duration (of the original file, pre-VAD)
        vad: {enabled, total_seconds, speech_seconds, speech_ratio,
              segments, removed_seconds} — present when VAD ran
        speakers: {labelled, you_segments, others_segments, echo_dropped} — present
              only with --mic-audio. labelled is false (and text is plain) when the
              microphone track holds no speech.

Progress (stderr):
    One JSON line per update: {"phase": "transcribe", "progress": 0.42}

Single-track input is not diarised: one continuous text, split into paragraphs
on longer pauses between segments. With --mic-audio the two tracks are
transcribed separately and merged into You:/Others: turns (everyone on the far
side of the call is one "Others" — they are not told apart from each other).

VAD: before transcription, Silero VAD (bundled silero_vad.onnx, run via
onnxruntime) drops non-speech stretches. This removes the silence/noise
regions where the model hallucinates, and cuts transcription time roughly in
proportion to the silence removed. If onnxruntime or the model file is
missing, transcription proceeds without VAD (a warning goes to stderr) —
old venvs keep working unchanged. Engine-agnostic: runs before either model.

Parakeet MLX (--engine parakeet): an alternative, much faster ASR engine
(NVIDIA Parakeet via https://github.com/senstella/parakeet-mlx). It has no
prompt/hotword mechanism — --initial-prompt is accepted for CLI-contract
symmetry but ignored (a warning is emitted) when this engine is selected.
distill's vocabulary hints and pasted meeting attendees therefore do not
bias Parakeet transcription; only the post-transcription find-and-replace
rules still apply. See docs/app/BACKLOG.md.
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

WHISPER_SAMPLE_RATE = 16_000

# --- Silero VAD tuning -----------------------------------------------------
# Deliberately conservative: the failure mode to avoid is clipping soft
# speech or the first syllable after a pause. Missing a hallucination is
# recoverable (the TS-side repetition cleaner still runs); losing real
# words is not.
VAD_WINDOW = 512                 # samples per VAD frame at 16k (32ms)
VAD_SPEECH_THRESHOLD = 0.35      # frame prob >= this → speech starts
VAD_NEG_THRESHOLD = 0.20         # frame prob < this → speech may end (hysteresis)
VAD_PAD_SECONDS = 0.20           # padding kept either side of each speech run
VAD_MERGE_GAP_SECONDS = 0.50     # speech runs closer than this are merged
VAD_MIN_SPEECH_SECONDS = 0.25    # shorter runs are discarded as blips
# Silence inserted between kept segments. Capped at the original gap so
# short natural pauses stay short, but long dead air becomes at most this —
# enough to keep Whisper's segmenting and our paragraph-break logic
# (PARAGRAPH_GAP_SECONDS) working on the compacted audio.
VAD_JOIN_SILENCE_SECONDS = 2.0


DEFAULT_PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"


@dataclass
class Args:
    audio: Path
    mic_audio: Path | None
    engine: str
    whisper_model: str | None
    parakeet_model: str
    language: str | None
    initial_prompt: str | None
    vad: bool
    vad_threshold: float


def parse_args(argv: list[str]) -> Args:
    p = argparse.ArgumentParser(description="Transcribe an audio file with MLX Whisper or Parakeet MLX.")
    p.add_argument("--audio", required=True, type=Path, help="Path to the audio file")
    p.add_argument(
        "--mic-audio",
        type=Path,
        default=None,
        help="Second track holding only the user's microphone. When given, --audio is the"
        " other participants' track, each is transcribed separately, and the output text is a"
        " labelled conversation (You: / Others:) instead of plain paragraphs.",
    )
    p.add_argument(
        "--engine",
        choices=["whisper", "parakeet"],
        default="whisper",
        help="ASR engine to use (default %(default)s)",
    )
    p.add_argument(
        "--whisper-model",
        default=None,
        help="MLX Whisper HuggingFace model id (required when --engine whisper)",
    )
    p.add_argument(
        "--parakeet-model",
        default=DEFAULT_PARAKEET_MODEL,
        help="Parakeet MLX HuggingFace model id (default %(default)s)",
    )
    p.add_argument("--language", default=None, help="Optional language hint (e.g. 'en'); whisper only")
    p.add_argument(
        "--initial-prompt",
        default=None,
        help="Optional vocabulary primer biasing Whisper's recognition. Typically a"
        " short list of domain-specific proper nouns / acronyms the speaker uses."
        " Ignored (with a warning) when --engine parakeet — Parakeet MLX has no"
        " prompt/hotword mechanism.",
    )
    p.add_argument(
        "--no-vad",
        action="store_true",
        help="Disable Silero VAD speech gating (transcribe the raw audio)",
    )
    p.add_argument(
        "--vad-threshold",
        type=float,
        default=VAD_SPEECH_THRESHOLD,
        help="Speech probability threshold for VAD (default %(default)s)",
    )
    ns = p.parse_args(argv)
    if ns.engine == "whisper" and not ns.whisper_model:
        p.error("--whisper-model is required when --engine whisper")
    return Args(
        audio=ns.audio,
        mic_audio=ns.mic_audio,
        engine=ns.engine,
        whisper_model=ns.whisper_model,
        parakeet_model=ns.parakeet_model,
        language=ns.language,
        initial_prompt=ns.initial_prompt,
        vad=not ns.no_vad,
        vad_threshold=ns.vad_threshold,
    )


def emit_progress(phase: str, progress: float) -> None:
    sys.stderr.write(json.dumps({"phase": phase, "progress": progress}) + "\n")
    sys.stderr.flush()


def emit_warning(message: str) -> None:
    sys.stderr.write(json.dumps({"warning": message}) + "\n")
    sys.stderr.flush()


# --- Silero VAD (ONNX, no torch dependency) --------------------------------


class SileroVad:
    """Minimal wrapper around the bundled silero_vad.onnx (v5).

    The model consumes 512-sample windows at 16kHz, each with the last 64
    samples of the previous window prepended as context (input length 576
    — without the context the model reads near-zero probability even on
    clear speech), plus a recurrent state tensor. Emits a per-window
    speech probability. Run via onnxruntime so the venv stays torch-free
    (torch arrives with pyannote in v1.2).
    """

    CONTEXT = 64

    def __init__(self, model_path: Path):
        import onnxruntime as ort  # deferred: optional dependency

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )

    def speech_probs(self, audio: "np.ndarray") -> "np.ndarray":
        import numpy as np

        n_frames = len(audio) // VAD_WINDOW
        probs = np.zeros(n_frames, dtype=np.float32)
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros(self.CONTEXT, dtype=np.float32)
        sr = np.array(WHISPER_SAMPLE_RATE, dtype=np.int64)
        for i in range(n_frames):
            frame = audio[i * VAD_WINDOW : (i + 1) * VAD_WINDOW].astype(np.float32)
            out, state = self.session.run(
                None,
                {
                    "input": np.concatenate([context, frame]).reshape(1, -1),
                    "state": state,
                    "sr": sr,
                },
            )
            probs[i] = out[0][0]
            context = frame[-self.CONTEXT :]
        return probs


def probs_to_segments(
    probs: "np.ndarray",
    speech_threshold: float,
) -> list[tuple[float, float]]:
    """Turn per-frame speech probabilities into padded, merged (start, end)
    segments in seconds. Hysteresis: speech starts at `speech_threshold`
    but only ends once the probability drops below VAD_NEG_THRESHOLD, so
    brief mid-word dips don't split a segment."""
    frame_seconds = VAD_WINDOW / WHISPER_SAMPLE_RATE
    raw: list[tuple[float, float]] = []
    start: float | None = None
    for i, p in enumerate(probs):
        t = i * frame_seconds
        if start is None:
            if p >= speech_threshold:
                start = t
        else:
            if p < VAD_NEG_THRESHOLD:
                raw.append((start, t + frame_seconds))
                start = None
    if start is not None:
        raw.append((start, len(probs) * frame_seconds))

    # Pad, then merge overlapping/nearby runs, then drop blips.
    padded = [(max(0.0, s - VAD_PAD_SECONDS), e + VAD_PAD_SECONDS) for s, e in raw]
    merged: list[tuple[float, float]] = []
    for s, e in padded:
        if merged and s - merged[-1][1] < VAD_MERGE_GAP_SECONDS:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return [(s, e) for s, e in merged if e - s >= VAD_MIN_SPEECH_SECONDS]


def apply_vad(audio: "np.ndarray", model_path: Path, speech_threshold: float):
    """Gate `audio` (float32 mono 16k) to its speech segments.

    Returns (gated_audio, stats_dict, pieces). `pieces` maps the compacted
    timeline back to the original (see speakers.Piece); None when nothing was
    gated. Segments are joined with silence
    capped at VAD_JOIN_SILENCE_SECONDS (never longer than the original
    gap), preserving Whisper's pause cues and downstream paragraphing.
    """
    import numpy as np

    if not model_path.exists():
        raise FileNotFoundError(str(model_path))

    total_seconds = len(audio) / WHISPER_SAMPLE_RATE
    vad = SileroVad(model_path)
    emit_progress("vad", 0.0)
    probs = vad.speech_probs(audio)
    segments = probs_to_segments(probs, speech_threshold)
    emit_progress("vad", 1.0)

    speech_seconds = sum(e - s for s, e in segments)
    stats = {
        "enabled": True,
        "total_seconds": round(total_seconds, 2),
        "speech_seconds": round(speech_seconds, 2),
        "speech_ratio": round(speech_seconds / total_seconds, 3) if total_seconds > 0 else 0.0,
        "segments": len(segments),
        "removed_seconds": round(max(0.0, total_seconds - speech_seconds), 2),
    }

    if not segments:
        # Either genuinely no speech, or the VAD misfired. Fall back to the
        # full audio — Whisper deciding "no speech" beats us guessing.
        stats["enabled"] = False
        return audio, stats, None

    pieces: list[np.ndarray] = []
    piece_map: list[tuple[float, float, float]] = []
    prev_end: float | None = None
    compacted = 0  # samples emitted so far
    for s, e in segments:
        if prev_end is not None:
            gap = max(0.0, s - prev_end)
            join = min(gap, VAD_JOIN_SILENCE_SECONDS)
            if join > 0:
                silence = np.zeros(int(join * WHISPER_SAMPLE_RATE), dtype=audio.dtype)
                pieces.append(silence)
                compacted += len(silence)
        chunk = audio[int(s * WHISPER_SAMPLE_RATE) : int(e * WHISPER_SAMPLE_RATE)]
        piece_map.append((compacted / WHISPER_SAMPLE_RATE, s, len(chunk) / WHISPER_SAMPLE_RATE))
        pieces.append(chunk)
        compacted += len(chunk)
        prev_end = e
    return np.concatenate(pieces), stats, piece_map


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


def decode_audio(path: Path) -> "np.ndarray":
    """Decode to float32 mono 16k, always as a real numpy array.

    Primary path is mlx_whisper's ffmpeg-based loader (identical samples
    to what plain `mlx_whisper.transcribe(path)` would see). Machines
    without the ffmpeg CLI fall back to soundfile (libsndfile handles
    mp3/wav/flac/ogg) with linear resampling to 16k — slightly lower
    resample quality, but it beats not transcribing at all.

    load_audio returns an mlx.core.array, not numpy — silently different
    from the soundfile fallback's real np.ndarray. VAD (SileroVad.speech_probs,
    onnxruntime) requires actual numpy and fails with a TypeError on
    mx.array's .astype() (it wants an mx.Dtype, not a numpy dtype class).
    Discovered because that failure is caught and downgraded to "transcribing
    without VAD" (apply_vad must never take transcription down with it) —
    so on any machine with ffmpeg installed, VAD was silently never running
    at all. Converting here, once, keeps every downstream consumer (VAD,
    both ASR engines) on one real type.
    """
    import numpy as np
    from mlx_whisper.audio import load_audio

    try:
        return np.asarray(load_audio(str(path)))
    except FileNotFoundError:
        emit_warning("ffmpeg not found — decoding with soundfile instead.")
    except Exception as e:
        emit_warning(f"ffmpeg decode failed ({e}) — trying soundfile.")

    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != WHISPER_SAMPLE_RATE:
        n_out = int(len(mono) * WHISPER_SAMPLE_RATE / sr)
        mono = np.interp(
            np.linspace(0, len(mono) - 1, n_out, dtype=np.float64),
            np.arange(len(mono), dtype=np.float64),
            mono,
        ).astype(np.float32)
    return mono


def prepare_track(path: Path, args: Args):
    """Decode a track and (unless disabled) gate it to its speech.

    Returns (original_audio, asr_audio, vad_stats, pieces). `pieces` maps the
    gated timeline back to the original (None when nothing was gated).
    """
    # Decode once so VAD and the ASR model share the same samples and the
    # original file is never modified. Always via mlx_whisper's loader
    # (mlx-whisper is a base dependency regardless of --engine) so decoding
    # is identical either way.
    original = decode_audio(path)
    audio = original
    vad_stats: dict | None = None
    pieces = None
    if args.vad:
        model_path = Path(__file__).parent / "silero_vad.onnx"
        try:
            audio, vad_stats, pieces = apply_vad(audio, model_path, args.vad_threshold)
        except ImportError:
            emit_warning(
                "onnxruntime not installed — transcribing without VAD. "
                "Run: pip install onnxruntime (in the distill venv) to enable it."
            )
        except FileNotFoundError:
            emit_warning(f"silero_vad.onnx not found at {model_path} — transcribing without VAD.")
        except Exception as e:  # VAD must never take transcription down with it
            emit_warning(f"VAD failed ({e}) — transcribing without VAD.")
    return original, audio, vad_stats, pieces


def run_asr(audio: "np.ndarray", args: Args):
    """Returns (text, segments, model_used, language)."""
    if args.engine == "parakeet":
        return transcribe_parakeet(audio, args)
    return transcribe_whisper(audio, args)


def transcribe(args: Args) -> dict:
    if not args.audio.exists():
        raise FileNotFoundError(f"Audio file not found: {args.audio}")

    if args.initial_prompt and args.engine == "parakeet":
        emit_warning(
            "--initial-prompt was given but --engine is parakeet — Parakeet MLX has no"
            " prompt/hotword mechanism, so vocabulary hints and pasted attendees will not"
            " bias this transcription. Ignoring."
        )

    if args.mic_audio is not None:
        return transcribe_call(args)

    original, audio, vad_stats, _ = prepare_track(args.audio, args)
    original_duration = len(original) / WHISPER_SAMPLE_RATE

    emit_progress("transcribe", 0.0)
    text, _segments, model_used, language = run_asr(audio, args)
    emit_progress("transcribe", 1.0)

    out: dict = {
        "text": text,
        "language": language,
        "model": model_used,
        # Duration of the source file, not the VAD-compacted audio —
        # downstream consumers expect wall-clock meeting length.
        "duration_seconds": round(original_duration, 2),
    }
    if vad_stats is not None:
        out["vad"] = vad_stats
    return out


# Peak amplitude below which a track is treated as silence. A muted or absent
# microphone records near-digital-zero; Whisper "transcribes" such audio into
# phantom text ("Thank you."), so it must never reach the model.
SILENT_PEAK = 0.002


def has_speech(original: "np.ndarray", vad_stats: dict | None) -> bool:
    import numpy as np

    if len(original) == 0 or float(np.abs(original).max()) < SILENT_PEAK:
        return False
    if vad_stats is not None and vad_stats.get("segments", 1) == 0:
        return False
    return True


def transcribe_call(args: Args) -> dict:
    """Two-track path: --audio is everyone else, --mic-audio is the user."""
    import speakers

    assert args.mic_audio is not None
    if not args.mic_audio.exists():
        raise FileNotFoundError(f"Microphone track not found: {args.mic_audio}")

    others_orig, others_audio, others_vad, others_map = prepare_track(args.audio, args)
    try:
        you_orig, you_audio, you_vad, you_map = prepare_track(args.mic_audio, args)
    except Exception as e:
        # An unavailable microphone leaves a stub file that can't be decoded.
        # That is "the user said nothing we can hear", not a failed transcription.
        import numpy as np

        emit_warning(f"microphone track could not be read ({str(e)[:120]}) — treating it as silent.")
        you_orig = you_audio = np.zeros(0, dtype=np.float32)
        you_vad, you_map = None, None
    duration = max(len(others_orig), len(you_orig)) / WHISPER_SAMPLE_RATE
    others_speech = has_speech(others_orig, others_vad)
    you_speech = has_speech(you_orig, you_vad)

    if not you_speech:
        # The user said nothing audible (listening in, or mic unavailable).
        # Labelling every line "Others" would be noise; return the plain
        # transcript exactly as a single-track recording would.
        emit_warning("microphone track holds no speech — transcript is not speaker-labelled.")
        emit_progress("transcribe", 0.0)
        text, _segs, model_used, language = run_asr(others_audio, args)
        emit_progress("transcribe", 1.0)
        out = {"text": text, "language": language, "model": model_used, "duration_seconds": round(duration, 2)}
        if others_vad is not None:
            out["vad"] = others_vad
        out["speakers"] = {"labelled": False, "you_segments": 0, "others_segments": 0, "echo_dropped": 0}
        return out

    if not others_speech:
        emit_warning(
            "system-audio track holds no speech — check System Audio Recording permission."
            " Only your side of the call was captured."
        )

    emit_progress("transcribe", 0.0)
    others_segs: list[dict] = []
    model_used, language = "", "unknown"
    if others_speech:
        _t, raw, model_used, language = run_asr(others_audio, args)
        others_segs = speakers.remap_segments(raw, others_map)
    emit_progress("transcribe", 0.5)
    _t, raw, you_model, you_lang = run_asr(you_audio, args)
    you_segs = speakers.remap_segments(raw, you_map)
    model_used = model_used or you_model
    if language == "unknown":
        language = you_lang
    emit_progress("transcribe", 1.0)

    you_kept, echo = speakers.suppress_echo(you_segs, others_segs, you_orig, others_orig)
    labelled = bool(you_kept)
    if labelled:
        text = speakers.render_turns(speakers.build_turns(you_kept, others_segs))
    else:
        # Everything on the mic was the speakers bleeding in: the user only
        # listened. Same reasoning as a silent mic — plain text, not a wall of
        # "Others:" lines.
        text = flatten_segments_to_paragraphs(others_segs)

    out = {
        "text": text,
        "language": language,
        "model": model_used,
        "duration_seconds": round(duration, 2),
        "speakers": {
            "labelled": labelled,
            "you_segments": len(you_kept),
            "others_segments": len(others_segs),
            "echo_dropped": len(echo),
        },
    }
    if others_vad is not None and you_vad is not None:
        # Speech on either track. Reporting only the other side's would make a call
        # where the user does most of the talking look nearly empty, and trip the
        # "little speech / wrong microphone" warning (shared/recordingQuality.ts).
        speech, stretches = speakers.speech_union([others_map, you_map])
        out["vad"] = {
            "enabled": True,
            "total_seconds": round(duration, 2),
            "speech_seconds": round(speech, 2),
            "speech_ratio": round(speech / duration, 3) if duration > 0 else 0.0,
            "segments": stretches,
            "removed_seconds": round(max(0.0, duration - speech), 2),
        }
    return out


def transcribe_whisper(audio: "np.ndarray", args: Args) -> tuple[str, list[dict], str, str]:
    """Returns (text, timed_segments, model_id_used, language)."""
    # Import here (not at module top) so that `--help` and argument parsing
    # stay fast and don't require mlx_whisper to be installed just to print
    # help, and so --engine parakeet never needs it importable at all.
    import mlx_whisper

    assert args.whisper_model is not None  # enforced in parse_args

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
        audio,
        path_or_hf_repo=args.whisper_model,
        **kwargs,
    )
    segments = result.get("segments", [])
    text = flatten_segments_to_paragraphs(segments)
    timed = [
        {"start": float(sg.get("start", 0.0)), "end": float(sg.get("end", 0.0)), "text": sg.get("text", "")}
        for sg in segments
    ]
    return text, timed, args.whisper_model, result.get("language", "unknown")


# Mirrors parakeet-mlx CLI's own --chunk-duration/--overlap-duration
# defaults. These are NOT applied automatically by the Python API — unlike
# the CLI, model.transcribe(path) with no kwargs tries to process the
# entire file in one pass. Found the hard way: an unchunked ~94-minute
# meeting blew past Metal's max buffer size (18.5GB requested vs a ~14GB
# cap) and crashed outright. Passing these explicitly is load-bearing,
# not a tuning knob.
PARAKEET_CHUNK_DURATION_SECONDS = 120.0
PARAKEET_OVERLAP_DURATION_SECONDS = 15.0


def transcribe_parakeet(audio: "np.ndarray", args: Args) -> tuple[str, list[dict], str, str]:
    """Returns (text, timed_segments, model_id_used, language). Parakeet doesn't report a
    detected language, so "unknown" is returned for parity with Whisper's
    output contract rather than guessing.

    Parakeet MLX's transcribe() takes a file path, not a raw array, so the
    (possibly VAD-gated) audio is written to a temp WAV first — VAD itself
    is engine-agnostic (see apply_vad) and applies here exactly as it does
    for Whisper.
    """
    import tempfile

    import soundfile as sf
    from parakeet_mlx import from_pretrained

    model = from_pretrained(args.parakeet_model)

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        sf.write(str(tmp_path), audio, WHISPER_SAMPLE_RATE)
        result = model.transcribe(
            str(tmp_path),
            chunk_duration=PARAKEET_CHUNK_DURATION_SECONDS,
            overlap_duration=PARAKEET_OVERLAP_DURATION_SECONDS,
        )
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    timed = [{"start": float(sn.start), "end": float(sn.end), "text": sn.text} for sn in result.sentences]
    return result.text, timed, args.parakeet_model, "unknown"


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
