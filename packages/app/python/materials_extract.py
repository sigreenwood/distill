"""Text from meeting materials (PowerPoint .pptx, PDF), slide by slide.

Usage: materials_extract.py FILE
Prints JSON: {"slides": [{"n": 1, "text": "...", "notes": "...", "hidden": false}]}

Layout rules only, no model, and nothing leaves this Mac. A .pptx is a
zip of XML: slide order comes from presentation.xml, text from the a:t
runs of each a:p paragraph (tables included), speaker notes from each
slide's notesSlide. PDF pages are read with pypdf, already in the venv
for calendar printouts.
"""
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
R_ID = "{%s}id" % NS["r"]


def _rels(z, part):
    """Relationship id -> target part path, for one part of the package."""
    folder, name = posixpath.split(part)
    rels_path = posixpath.join(folder, "_rels", name + ".rels")
    if rels_path not in z.namelist():
        return {}
    out = {}
    for rel in ET.fromstring(z.read(rels_path)).findall("rel:Relationship", NS):
        target = rel.get("Target", "")
        if rel.get("TargetMode") == "External":
            continue
        out[rel.get("Id")] = (posixpath.normpath(posixpath.join(folder, target)), rel.get("Type", ""))
    return out


def _paragraphs(root, skip_placeholders=()):
    lines = []
    for sp in root.iter():
        if sp.tag != "{%s}sp" % NS["p"] and sp.tag != "{%s}graphicFrame" % NS["p"]:
            continue
        ph = sp.find(".//p:nvPr/p:ph", NS)
        if ph is not None and ph.get("type") in skip_placeholders:
            continue
        for para in sp.iter("{%s}p" % NS["a"]):
            text = "".join(t.text or "" for t in para.iter("{%s}t" % NS["a"])).strip()
            if text:
                lines.append(text)
    return lines


def read_pptx(path):
    slides = []
    with zipfile.ZipFile(path) as z:
        pres_rels = _rels(z, "ppt/presentation.xml")
        pres = ET.fromstring(z.read("ppt/presentation.xml"))
        order = [pres_rels[s.get(R_ID)][0] for s in pres.findall("p:sldIdLst/p:sldId", NS) if s.get(R_ID) in pres_rels]
        for n, part in enumerate(order, start=1):
            if part not in z.namelist():
                continue
            root = ET.fromstring(z.read(part))
            notes = []
            for target, kind in _rels(z, part).values():
                if kind.endswith("/notesSlide") and target in z.namelist():
                    notes = _paragraphs(ET.fromstring(z.read(target)), skip_placeholders=("sldNum", "sldImg", "hdr", "ftr", "dt"))
            slides.append({
                "n": n,
                "text": "\n".join(_paragraphs(root, skip_placeholders=("sldNum", "ftr", "dt"))),
                "notes": "\n".join(notes),
                "hidden": root.get("show") == "0",
            })
    return slides


def read_pdf(path):
    from pypdf import PdfReader

    slides = []
    for n, page in enumerate(PdfReader(path).pages, start=1):
        text = page.extract_text() or ""
        # Private-use glyphs and zero-width spaces, as in calendar_pdf.py.
        text = re.sub(r"[-​]", "", text)
        text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
        slides.append({"n": n, "text": text, "notes": "", "hidden": False})
    return slides


def main():
    path = sys.argv[1]
    lower = path.lower()
    if lower.endswith(".pptx"):
        slides = read_pptx(path)
    elif lower.endswith(".pdf"):
        slides = read_pdf(path)
    else:
        raise SystemExit("Unsupported file type: " + path)
    json.dump({"slides": slides}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
