"""
Read meetings out of an Outlook on the web calendar printed to PDF
(Calendar -> Print -> detailed agenda, saved from Chrome as PDF).

Prints JSON to stdout: {"events": [...], "pages": n, "warnings": [...]}.

The printout has no structure beyond layout, so this reads it the way a
person does: each event starts with its subject, set in a larger font
directly above a line like "Mon 2026-08-03 9:00 AM - 9:30 AM", followed
by Location/Organiser/Required Attendees/Optional Attendees and the
invite body. Font sizes vary with the print scale, so the subject size is
learned from the document (the most common size of the line above a time
line) rather than hard-coded.

Times are the local wall-clock times Outlook printed; the caller converts
them using the Mac's time zone. Runs locally; nothing leaves the machine.
"""
import collections
import json
import re
import sys

import pypdf

DAYS = r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)"
TIME = r"\d{1,2}:\d{2} [AP]M"
# "Mon 2026-08-03 9:00 AM - 9:30 AM", "Tue 2026-08-04 (All day)",
# "Mon 2026-08-10 to Mon 2026-08-17", "Fri 2026-08-07 11:00 PM - Sat 2026-08-08 1:00 AM"
TIME_LINE = re.compile(
    rf"^{DAYS} (?P<date>\d{{4}}-\d{{2}}-\d{{2}})"
    rf"(?: (?P<start>{TIME}))?"
    rf"(?: \((?P<allday>All day)\))?"
    rf"(?: (?:-|to) (?:{DAYS} (?P<end_date>\d{{4}}-\d{{2}}-\d{{2}}))? ?(?P<end>{TIME})?(?: \(All day\))?)?\s*$"
)
DAY_HEADER = re.compile(r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \w+ \d{1,2}, \d{4}$")
LABELS = ("Location:", "Organiser:", "Organizer:", "Required Attendees:", "Optional Attendees:")
PERSON = re.compile(r"([^;<>]+?)\s*<([^<>\s]+@[^<>\s]+)>")
# Where the Teams/Webex dial-in block and the recording notice begin;
# everything after is boilerplate, not what the meeting is about.
BOILERPLATE = re.compile(
    r"_{10,}|Microsoft Teams (?:meeting|Need help)|Join on your computer|Join Zoom Meeting|"
    r"Meeting ID:|This meeting may be recorded|Recording and transcription notice",
    re.I,
)
BODY_CHARS = 1500


def page_lines(page):
    """Lines of text on a page, in reading order, each with its largest font size."""
    pieces = []

    def visit(text, cm, tm, font, size):
        if not text or text == "\n":
            return
        scale = abs(tm[3] or 1) * abs(cm[3] or 1)
        y = tm[5] * (cm[3] or 1) + cm[5]
        pieces.append((round(size * scale, 1), round(y, 1), text))

    page.extract_text(visitor_text=visit)
    lines = []
    for size, y, text in pieces:
        if lines and abs(lines[-1]["y"] - y) < 0.5:
            lines[-1]["text"] += text
            lines[-1]["size"] = max(lines[-1]["size"], size)
        else:
            lines.append({"y": y, "size": size, "text": text})
    for line in lines:
        # Outlook's icons print as private-use glyphs (, , …)
        # and page breaks leave lines of only those or of zero-width
        # spaces; such a line must not separate a subject at the foot of
        # one page from its time line at the top of the next.
        line["text"] = re.sub(r"[\s ​-‍﻿-]+", " ", line["text"]).strip()
    return [l for l in lines if l["text"]]


def person_name(raw):
    """'Greenwood, Simon' -> 'Simon Greenwood'."""
    raw = " ".join(raw.split()).strip(" ;,")
    if raw.count(",") == 1:
        last, first = [p.strip() for p in raw.split(",")]
        if first and last:
            return f"{first} {last}"
    return raw


def people(text):
    return [{"name": person_name(n), "email": e.strip().lower()} for n, e in PERSON.findall(text)]


def to_24h(t):
    if not t:
        return None
    hm, ampm = t.split(" ")
    h, m = (int(x) for x in hm.split(":"))
    if ampm == "PM" and h != 12:
        h += 12
    if ampm == "AM" and h == 12:
        h = 0
    return f"{h:02d}:{m:02d}"


def parse_event(subject, time_match, rest):
    fields = {label: [] for label in LABELS}
    body = []
    current = None
    for line in rest:
        label = next((l for l in LABELS if line.startswith(l)), None)
        if label:
            current = label
            fields[label].append(line[len(label):].strip())
        elif current in ("Required Attendees:", "Optional Attendees:") and ("@" in line or line.endswith(";") or line.endswith(",")):
            fields[current].append(line)
        else:
            current = None
            body.append(line)
    text = "\n".join(body)
    cut = BOILERPLATE.search(text)
    text = (text[: cut.start()] if cut else text).strip()
    organiser = " ".join(fields["Organiser:"] + fields["Organizer:"]).strip()
    g = time_match.groupdict()
    return {
        "subject": subject,
        "date": g["date"],
        "start": to_24h(g["start"]),
        "end": to_24h(g["end"]),
        "endDate": g["end_date"] or g["date"],
        "allDay": bool(g["allday"]) or (g["start"] is None),
        "location": " ".join(fields["Location:"]).strip() or None,
        "organiser": person_name(organiser) if organiser else None,
        "required": people(" ".join(fields["Required Attendees:"])),
        "optional": people(" ".join(fields["Optional Attendees:"])),
        "body": text[:BODY_CHARS] or None,
    }


def read(path):
    reader = pypdf.PdfReader(path)
    lines = []
    for page in reader.pages:
        lines.extend(page_lines(page))
    time_idx = [i for i, l in enumerate(lines) if TIME_LINE.match(l["text"])]
    warnings = []
    if not time_idx:
        return {"events": [], "pages": len(reader.pages), "warnings": ["No meeting times found — is this an Outlook calendar printout?"]}
    subject_size = collections.Counter(lines[i - 1]["size"] for i in time_idx if i > 0).most_common(1)[0][0]

    starts = []  # (subject_start_index, time_index)
    for i in time_idx:
        j = i
        while j > 0 and abs(lines[j - 1]["size"] - subject_size) < 0.2 and not TIME_LINE.match(lines[j - 1]["text"]):
            j -= 1
        if j == i:
            warnings.append(f"Event at {lines[i]['text']} has no subject line")
        starts.append((j, i))

    events = []
    for k, (j, i) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else len(lines)
        rest = [l["text"] for l in lines[i + 1 : end] if not DAY_HEADER.match(l["text"])]
        subject = " ".join(l["text"] for l in lines[j:i]).strip()
        events.append(parse_event(subject, TIME_LINE.match(lines[i]["text"]), rest))
    return {"events": events, "pages": len(reader.pages), "warnings": warnings}


if __name__ == "__main__":
    out = {"files": []}
    for path in sys.argv[1:]:
        try:
            result = read(path)
        except Exception as e:  # a corrupt or non-PDF file shouldn't sink the others
            result = {"events": [], "pages": 0, "warnings": [f"Could not read: {e}"]}
        out["files"].append({"path": path, **result})
    json.dump(out, sys.stdout)
