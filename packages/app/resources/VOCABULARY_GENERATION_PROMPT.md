# Vocabulary generation prompt

A copy-paste prompt for generating a distill vocabulary JSON file from
your own domain notes via an external LLM (ChatGPT, Claude.ai, Gemini,
or any tool that takes a system + user message and returns text).

## Why you'd want this

distill ships with empty vocabulary scopes (`global`, `organisation`,
`industry`, plus one per client). Populating them by hand works but is
tedious — you have to think up every term, every common
mistranscription, every homophone. This prompt does the heavy lifting:
you give the LLM a paragraph or two of domain notes, it gives you a
ready-to-import JSON file.

The output of the prompt below is the same shape distill writes when
you save a scope through Settings, so it imports cleanly via
**Settings → Vocabulary → Import…**.

## The schema

A distill vocabulary file is a JSON object with three meaningful
fields:

```json
{
  "$description": "Optional human-readable description of the file.",
  "$version": 1,
  "whisperHints": ["Term1", "Term2", "..."],
  "replacements": [
    { "from": "miss-transcribed", "to": "Correct Term" },
    { "from": "homophone", "to": "Homophone Match", "requiresContext": ["context-word-1", "context-word-2"] }
  ],
  "notes": ["Optional free-text notes about why a rule exists."]
}
```

**`whisperHints`** — terms Whisper should be biased toward recognising.
These get baked into Whisper's `initial_prompt` at transcription time
so the model knows they're real words. Use the spelling and
capitalisation you want in the transcript.

**`replacements`** — post-transcription rewrites. Whisper does its
best, but proper nouns and acronyms still come out wrong sometimes.
Each rule rewrites every case-insensitive whole-word match of `from`
to `to`.

**`requiresContext`** (optional) — only fire the rule when at least
one of these words appears elsewhere in the same transcript. Used for
homophones: e.g. `"sim" → "CIM"` should only apply when the
transcript is talking about marketing (so `requiresContext:
["marketing", "campaign", "audience"]`), not when someone literally
said "sim card".

**`notes`** — free text for humans. Not used by the pipeline; useful
for documenting why an unusual rule exists.

## The prompt

Copy everything between the `BEGIN PROMPT` and `END PROMPT` markers,
paste it into your LLM of choice, and replace the `<your domain
notes>` block at the bottom with your own content. The LLM should
return a single JSON object you can save as `myscope.json` and import
into distill.

```text
BEGIN PROMPT

You are helping me build a vocabulary file for a meeting transcription tool called distill. distill uses Whisper for speech-to-text plus a post-transcription replacement pass. Both stages benefit from a vocabulary file that lists domain-specific terms.

The vocabulary file is a single JSON object with this shape:

{
  "$description": "string, optional",
  "$version": 1,
  "whisperHints": ["string", "..."],
  "replacements": [
    { "from": "string", "to": "string" },
    { "from": "string", "to": "string", "requiresContext": ["string", "..."] }
  ],
  "notes": ["string", "..."]
}

Field semantics:

- `whisperHints`: A list of terms Whisper should know about. Use the spelling and capitalisation you want in the transcript. Acronyms, product names, proper nouns, technical jargon. Do NOT include common English words.

- `replacements`: A list of rules that rewrite likely Whisper mistranscriptions. Each rule has `from` (what Whisper outputs incorrectly) and `to` (what we want it to be). Rules are matched case-insensitively at word boundaries. Examples of good `from` values: phonetically-similar spellings of acronyms ("see ess oh" → "CSO"), common Whisper failure modes for non-English names, multi-word company names that Whisper splits oddly.

- `requiresContext`: Optional. When set, the replacement rule only applies if at least one of the listed words also appears in the transcript. Use this for homophones — e.g. "sim" → "CIM" only when "marketing" or "campaign" is also in the transcript.

- `notes`: Free text for humans. Not used by the pipeline.

Rules for what you generate:

1. Output a single JSON object, valid JSON, and nothing else. No markdown fences, no commentary. Start with `{` and end with `}`.
2. Every `from` and `to` value must be non-empty.
3. Don't repeat the same `from` value twice.
4. `whisperHints` should not duplicate the `from` or `to` of any replacement — Whisper biasing and post-replacement are complementary, not the same thing.
5. Generate at most ~80 hints and ~80 replacements. Quality over quantity.
6. Only include `requiresContext` when the rule is genuinely a homophone or context-dependent rewrite. Don't add it speculatively.

Now generate a vocabulary JSON file from these domain notes:

<your domain notes>

END PROMPT
```

## Example domain notes

If you're not sure what "domain notes" should look like, here's a
sketch you can model yours on:

```text
I work at Acme Corp on the Falcon and Phoenix product lines.
Falcon is our flagship database; Phoenix is the analytics layer
on top. Common acronyms in our meetings: ACL (access control list),
SLO (service-level objective), GTM (go-to-market), QBR (quarterly
business review). My main customer contacts are Karen Velasquez
at Globex Industries and Liam Okonkwo at Initech. Whisper often
mishears "Acme" as "acne", "Falcon" as "fall come", and "Velasquez"
as "Velazquez" or "Velasco". The acronym "CIM" (customer interaction
manager) is a homophone of the word "sim" — only rewrite it when
the transcript is talking about customers or marketing.
```

The LLM should turn that into something like:

```json
{
  "$description": "Vocabulary for Acme Corp meetings.",
  "$version": 1,
  "whisperHints": [
    "Acme Corp", "Falcon", "Phoenix", "Globex Industries",
    "Initech", "Karen Velasquez", "Liam Okonkwo", "ACL", "SLO",
    "GTM", "QBR", "CIM"
  ],
  "replacements": [
    { "from": "acne", "to": "Acme" },
    { "from": "fall come", "to": "Falcon" },
    { "from": "Velazquez", "to": "Velasquez" },
    { "from": "Velasco", "to": "Velasquez" },
    { "from": "sim", "to": "CIM", "requiresContext": ["customer", "marketing", "campaign"] }
  ],
  "notes": [
    "CIM is a homophone of sim card; the requiresContext on the sim rule prevents it firing when the speaker means a literal SIM."
  ]
}
```

Save the LLM's output as `whatever.json` and import it via **Settings
→ Vocabulary → Import…** in distill. Pick the scope you want to
populate first (e.g. select your client scope, then click Import).
Existing entries in that scope are preserved; entries that conflict
on the `from` value are overwritten by the import.

## Tips

- **Iterate.** Run the prompt, look at what comes out, edit your
  domain notes to push the LLM toward what you want, run again.
  Two or three rounds usually gets a better result than trying to
  write perfect notes the first time.
- **Per-scope files.** Build separate files for separate scopes:
  one for `global` (anything you want applied to every meeting),
  one per client. You'll get cleaner replacement rules because
  the LLM isn't trying to handle every domain at once.
- **Double-check `requiresContext`.** The LLM tends to add it
  liberally. Review and remove anywhere it doesn't actually
  matter.
- **Don't import twice without thinking.** distill's import is
  merge-with-import-wins — re-importing the same file with
  changed `to` values will overwrite your edits to those rules.
  If you've been editing entries in the Settings UI, those edits
  are clobbered by a re-import.
