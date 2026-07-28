# Meeting-type prompt generation

A copy-paste prompt for getting an external LLM (Claude, ChatGPT, Gemini,
or Qwen itself) to write you a distill meeting-type prompt — the system
message that turns a transcript into a summary.

Paste the block below into the LLM, then describe your meeting type
underneath it. What comes back goes into **Settings → Prompts → + New
prompt…**, or into `docs/app/PROMPTS.md` as a seeded built-in.

## Why the constraints below are what they are

These aren't style preferences. Each one comes from something measured
on real meetings running through distill (July 2026, qwen3.5 9B,
`large-v3-turbo` transcription, 24GB M5):

- **Temperature is 0.** distill summarises at `temperature: 0` because a
  meeting summary is an extraction task. At 0.3, four runs of one
  transcript agreed on **18%** of named entities and half abandoned the
  prompt's structure; at 0, three runs were byte-identical and every
  section appeared. The practical consequence for prompt writing: a
  detailed multi-section schema **is** reliably followed, so you can ask
  for real structure. Don't write defensively as if the model will drift.
- **The first line becomes the filename.** distill takes the first
  non-empty line of the summary as the output filename. The rules it
  applies are strict and silent — get them wrong and you fall back to
  the raw recorder filename like `2026-07-27 13:59:24`.
- **A 9B model is doing the work.** It follows explicit formats well and
  infers poorly. Say exactly what you want; don't rely on it inventing a
  sensible shape.
- **Output lands in Markdown, HTML and Apple Notes.** Markdown structure
  survives all three. Elaborate tables and nested lists do not travel
  well into Notes.

## The prompt to paste

````text
You are helping me write a SYSTEM PROMPT for a local LLM (Qwen 3.5, 9B
parameters, running via Ollama at temperature 0) that summarises
transcripts of my meetings. I will describe the kind of meeting; you
return the finished system prompt and nothing else.

CONTEXT ABOUT THE SYSTEM YOU ARE WRITING FOR

- Input is a raw transcript: no speaker labels, no timestamps,
  punctuation only as good as the transcriber managed. Assume names are
  occasionally mis-heard.
- Temperature is 0, so the model follows detailed structure reliably.
  Prefer explicit sections over vague guidance.
- A 9B model follows explicit formats well but infers poorly. State the
  exact shape of every section rather than describing intent.
- Output is written to Markdown, HTML and Apple Notes. Use headings,
  bold and bullets. Avoid tables, nested lists deeper than one level,
  and HTML.

HARD REQUIREMENT — THE FIRST LINE IS THE FILENAME

The prompt you write MUST instruct the model that line 1 of its output
is a plain-text title, then a blank line, then the summary. The title is
parsed programmatically and is REJECTED — silently falling back to an
unhelpful default — if it:
  - starts with a number and a dot or bracket ("1." / "1)")
  - is, or begins with, a generic label: Summary, Executive Summary,
    Overview, Introduction, Meeting Notes, Meeting Minutes, Transcript
  - contains fewer than 3 words
  - contains markdown (#, *, _), quotes, or a "Title:" prefix
It is truncated after 15 words. Tell the model to write 8-10 words
describing the meeting's actual subject, and give one worked example.

WHAT MAKES THESE PROMPTS WORK

1. Number and name every section explicitly. Tell the model to emit
   every section in order, verbatim, even when empty.
2. For any section that may legitimately be empty, give the exact empty
   value to write (e.g. "- None"). Otherwise the section is silently
   dropped and its absence is ambiguous.
3. Give a literal format line for anything structured, e.g.
   actions as: ✅ **Owner** to <action> by <date or TBD>
4. Demonstrate rather than instruct wherever you can. Show one example
   line; don't describe the style in the abstract.
5. Include an explicit anti-fabrication rule: use only what is in the
   transcript, never infer a name, date, figure or commitment.
6. If you ask for a score or rating, define the scale, require a
   justification citing observed behaviour, and explicitly warn against
   defaulting to a middling or flattering value.
7. Tell it to prefer the speaker's own terms for products and systems.

WHAT TO AVOID

- Instructions the model cannot verify about itself ("be concise",
  "be insightful", "think step by step before answering").
- Asking for more sections than the content can fill: aim for roughly
  60-120 words per section at typical meeting length. Eight sections on
  a 20-minute call produces padding.
- Asking for the transcript to be quoted back at length; distill can
  already embed the full transcript beneath the summary.
- Requesting JSON or YAML. The output is read by humans in Notes.

NOW DO THIS

Ask me any clarifying questions you need about the meeting type, who
attends, and what I need out of it. Then output ONLY the finished
system prompt, in plain text, ready to paste. No preamble, no
explanation, no code fence.
````

## After you paste the result in

1. Add it via **Settings → Prompts → + New prompt…**.
2. Run it against a transcript you already have a summary for — the
   cheapest way is to drag that summary's `.md` file back onto the
   inbox, which re-summarises without re-transcribing.
3. Check the filename that comes out. If it looks like the raw recorder
   name, the title line was rejected — usually a stray `#` or a generic
   opening word.
4. Because temperature is 0, a second run of the same transcript should
   be identical. If it isn't, something is overriding the temperature.

## Related

- [`PROMPTS.md`](./PROMPTS.md) — the seeded built-in prompts, and the
  format for adding your own as built-ins.
- [`VOCABULARY_GENERATION_PROMPT.md`](./VOCABULARY_GENERATION_PROMPT.md)
  — the equivalent for generating vocabulary files.
- `packages/app/scripts/compare_summaries.py` — measures how much two or
  more summaries of the same transcript actually agree, which is how the
  temperature finding above was established.
