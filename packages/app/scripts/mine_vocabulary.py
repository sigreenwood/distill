#!/usr/bin/env python3
"""
mine_vocabulary.py — build a starter vocabulary from your own transcripts.

Whisper's initial_prompt biases recognition toward terms you list, but
only toward terms you actually list. Measured on a real call: `turbo`
transcribed a colleague's name as "Rajesh" correctly, while the same
model given a generic industry term list produced "Ratchet" — because
the name was not in the list. Generic hints do not help; your names do.

This scans the recordings already in distill's database and the Markdown
summaries already written, extracts recurring proper nouns, and emits a
vocabulary file ready for Settings -> Vocabulary -> Import.

Usage:
    python mine_vocabulary.py                 # print candidates
    python mine_vocabulary.py -o vocab.json   # write an importable file
    python mine_vocabulary.py --min-count 2

Review the output before importing. It cannot tell a correctly-heard
name from a consistently mis-heard one — if a term looks wrong, put the
CORRECT spelling in whisperHints and add a replacement rule for the
wrong one.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

APP_SUPPORT = Path.home() / "Library/Application Support/distill"
LEGACY_SUPPORT = Path.home() / "Library/Application Support/Plaud Local"

# Capitalised words that are ordinary English rather than names. Whisper
# has no trouble with these, and listing them wastes the prompt budget —
# which is capped at 800 characters.
STOPWORDS = {
    "The", "This", "That", "There", "These", "Those", "Then", "They", "Their",
    "And", "But", "For", "With", "From", "Into", "Over", "Under", "About",
    "What", "When", "Where", "Which", "While", "Who", "Why", "How",
    "Yes", "Yeah", "Okay", "Right", "Well", "Sure", "Thanks", "Thank",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
    "I", "We", "You", "He", "She", "It", "Not", "Was", "Were", "Have", "Has",
    "Just", "Like", "Get", "Got", "Going", "Good", "Great", "Some", "One", "Two",
    "Actually", "Basically", "Obviously", "Probably", "Maybe", "Sorry",
    "Meeting", "Summary", "Transcript", "Team", "Call",
    # Section headings from the meeting-type prompts. These appear in the
    # summaries, not in anything anyone said, so they would waste prompt
    # budget biasing Whisper toward words it will never hear.
    "Topics", "Notes", "Focused", "Discussion", "Actions", "Assignments",
    "Unresolved", "Insights", "Sentiment", "Score", "Executive", "Overall",
    "Follow", "Key", "Strategic", "Optional", "Customer", "Questions",
    "Commercial", "Operational", "Performance", "Engagement", "Governance",
}

# Mid-sentence capitalisation is the signal: a capital after a full stop
# is just a new sentence, but a capital mid-clause is usually a name,
# product or acronym.
PROPER = re.compile(r"(?<![.!?]\s)(?<!^)\b([A-Z][A-Za-z][A-Za-z'’-]{1,})\b", re.M)
ACRONYM = re.compile(r"\b([A-Z]{2,6})\b")


def find_db() -> Path | None:
    for base in (APP_SUPPORT, LEGACY_SUPPORT):
        db = base / "state.db"
        if db.exists():
            return db
    return None


def read_sources(markdown_dir: Path | None) -> list[str]:
    texts: list[str] = []
    db = find_db()
    if db:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        for (t,) in con.execute(
            "SELECT transcript_text FROM recordings WHERE transcript_text IS NOT NULL"
        ):
            texts.append(t)
        # Summaries are model-cleaned, so their spellings tend to be the
        # tidier ones — useful as a second opinion on the same meeting.
        for (s,) in con.execute(
            "SELECT summary_text FROM recordings WHERE summary_text IS NOT NULL"
        ):
            texts.append(s)
        con.close()
    if markdown_dir and markdown_dir.exists():
        for p in markdown_dir.rglob("*.md"):
            try:
                texts.append(p.read_text(encoding="utf-8"))
            except Exception:
                pass
    return texts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--min-count", type=int, default=3, help="occurrences required (default 3)")
    ap.add_argument("--limit", type=int, default=60, help="max hints to emit (default 60)")
    ap.add_argument("--markdown-dir", type=Path, default=Path.home() / "Documents/distill")
    ap.add_argument("-o", "--out", type=Path, help="write a vocabulary JSON here")
    args = ap.parse_args()

    texts = read_sources(args.markdown_dir)
    if not texts:
        print("No transcripts or summaries found. Process a recording first.", file=sys.stderr)
        return 1

    blob = "\n".join(texts)
    counts: Counter[str] = Counter()
    for m in PROPER.finditer(blob):
        w = m.group(1)
        if w not in STOPWORDS:
            counts[w] += 1
    for m in ACRONYM.finditer(blob):
        w = m.group(1)
        if w not in STOPWORDS:
            counts[w] += 1

    candidates = [(w, c) for w, c in counts.most_common() if c >= args.min_count]
    hints = [w for w, _ in candidates][: args.limit]

    print(f"# scanned {len(texts)} documents, {len(blob):,} chars")
    print(f"# {len(candidates)} terms seen >= {args.min_count} times; emitting {len(hints)}\n")
    for w, c in candidates[: args.limit]:
        print(f"  {c:>4}  {w}")

    prompt_len = len(", ".join(hints))
    print(f"\n# hint string would be {prompt_len} chars (Whisper budget is 800)")
    if prompt_len > 700:
        print("# consider --limit to trim; the least frequent terms are dropped first")

    if args.out:
        doc = {
            "$description": "Mined from existing distill transcripts and summaries. Review before use.",
            "$version": 1,
            "whisperHints": hints,
            "replacements": [],
            "notes": [
                "Generated by mine_vocabulary.py. Check for mis-heard names: if a "
                "term here is wrong, replace it with the correct spelling and add a "
                "replacement rule mapping the wrong form to the right one.",
            ],
        }
        args.out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        print(f"\nWrote {args.out} — import via Settings -> Vocabulary -> Import…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
