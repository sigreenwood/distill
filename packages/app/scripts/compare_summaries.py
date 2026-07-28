#!/usr/bin/env python3
"""
compare_summaries.py — measure how much summaries of the SAME transcript vary.

A single summary is one sample from the model, not a stable extraction.
Running the same transcript several times shows how much of the output is
signal and how much is sampling noise — which is the number that tells you
whether to reach for a bigger model, a lower temperature, or a tighter
prompt.

Usage:
    python compare_summaries.py ~/Documents/distill/HSBC/*.md

Files are grouped by the transcript they summarise (SHA of the Transcript
section), so you can point it at a whole folder and it will only compare
like with like.

Reports per group:
  - length spread (words)
  - structural shape (bullets, sections)
  - entity agreement: how many named things appear in ALL runs vs only some
  - the entities that appear in only one run — the ones you cannot trust
"""

from __future__ import annotations

import hashlib
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

SUMMARY_RE = re.compile(r"^##\s*Summary\s*$", re.I | re.M)
TRANSCRIPT_RE = re.compile(r"^##\s*Transcript\s*$", re.I | re.M)
ENTITY_RE = re.compile(r"\b[A-Z][A-Za-z]{2,}(?: [A-Z][A-Za-z]+)?\b")
FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---", re.S)

# Words that start sentences and aren't really names — they inflate the
# entity overlap and hide the real disagreements.
STOPWORDS = {
    "The", "This", "That", "These", "Those", "There", "They", "Their", "Then",
    "Both", "Each", "All", "Also", "However", "While", "When", "With", "From",
    "For", "And", "But", "Not", "New", "Next", "Key", "Action", "Actions",
    "Summary", "Discussed", "Addressed", "Noted", "Agreed", "Need", "Needs",
    "Overall", "Internal", "Formal", "Optional", "Clarity", "Clarification",
    "How", "Long", "Management", "Deployment", "Governance", "Methodology",
}


def read_sections(path: Path) -> tuple[str, str, str]:
    """Return (summary, transcript, model) for a distill Markdown file."""
    text = path.read_text(encoding="utf-8")
    model = ""
    fm = FRONTMATTER_RE.search(text)
    if fm:
        m = re.search(r"^model:\s*\"?([^\"\n]+)\"?", fm.group(1), re.M)
        if m:
            model = m.group(1).strip()
    s = SUMMARY_RE.search(text)
    t = TRANSCRIPT_RE.search(text)
    summary = text[s.end() : (t.start() if t else len(text))] if s else ""
    transcript = text[t.end() :] if t else ""
    return summary.strip(), transcript.strip(), model


def entities(summary: str) -> set[str]:
    return {e for e in ENTITY_RE.findall(summary) if e not in STOPWORDS}


def main() -> int:
    paths = [Path(p) for p in sys.argv[1:]]
    if not paths:
        print(__doc__)
        return 2

    groups: dict[str, list[tuple[Path, str, str]]] = defaultdict(list)
    for p in paths:
        try:
            summary, transcript, model = read_sections(p)
        except Exception as e:
            print(f"  skipping {p.name}: {e}")
            continue
        if not summary or not transcript:
            continue
        key = hashlib.sha256(transcript.encode()).hexdigest()[:12]
        groups[key].append((p, summary, model))

    for key, items in groups.items():
        if len(items) < 2:
            continue
        print(f"\n=== transcript {key} — {len(items)} summaries ===")
        all_sets = []
        for p, summary, model in items:
            words = len(summary.split())
            bullets = len(re.findall(r"^\s*[-*] ", summary, re.M))
            sections = len(re.findall(r"\*\*[^*]+\*\*|^#{2,4} ", summary, re.M))
            ents = entities(summary)
            all_sets.append(ents)
            print(
                f"  {p.name[:48]:50} {model:16} "
                f"{words:>4}w {bullets:>3}b {sections:>3}s {len(ents):>3}e"
            )

        counts = Counter()
        for s in all_sets:
            counts.update(s)
        n = len(all_sets)
        in_all = [e for e, c in counts.items() if c == n]
        in_one = [e for e, c in counts.items() if c == 1]
        total = len(counts)
        print()
        print(f"  entities in EVERY run : {len(in_all):>3} / {total}  "
              f"({len(in_all)/total*100:.0f}% — the trustworthy core)")
        print(f"  entities in ONE run   : {len(in_one):>3} / {total}  "
              f"({len(in_one)/total*100:.0f}% — coin-flips)")
        if in_one:
            print(f"  appear only once: {', '.join(sorted(in_one)[:20])}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
