# Import formats

distill's Settings window has two bulk-import affordances. This file
documents the file shapes both expect, so a contributor can prepare
their personal data for re-import on a fresh install.

## Prompts → markdown file

**Where:** Settings → Prompts → "Import…"

The picker accepts `.md` / `.markdown` files. Each prompt is one
section of the file, headed by an H2 heading containing a backticked
id and (optionally) a display name:

    ## 1. `client-call` — Client Call

    ```
    You are a meeting summariser for client calls.

    [the rest of the prompt body]
    ```

    ## 2. `weekly-sync` — Weekly Sync

    ```
    You are a meeting summariser for the weekly sync.

    [the rest of the prompt body]
    ```

The repo's own [`docs/app/PROMPTS.md`](./PROMPTS.md) is in exactly this
shape; it's both the in-repo reference and a ready-to-import file.

### Heading rules

- The id is the backticked slug. Allowed chars: `a-z`, `0-9`, `-`. The
  id is what's matched against existing rows on import; pick stable
  ids so re-imports update the same prompt.
- The display name is whatever follows the id, separated by an em-dash
  (`—`), en-dash (`–`), or ASCII hyphen (`-`) with surrounding
  whitespace. If no name is on the heading, distill humanises the id
  (`all-hands` → `All Hands`).
- Headings without a backticked id are ignored (so you can mix
  narrative content into the same file freely).

### Body rules

- The first fenced code block in the section is the prompt body.
  Three or more backticks open the fence; the closing fence must be
  the same length. Use four backticks if your prompt itself contains
  triple-backtick code samples.
- Sections without a fenced body are silently skipped.

### Import behaviour

- Existing id (built-in or user-created): the prompt body and display
  name are updated. `is_builtin`, `sort_order`, and the
  `original_prompt_hash` "modified-from-default" anchor are left as
  they are. If the imported text differs from the original seed, the
  built-in's "mod" badge will (correctly) appear after import.
- New id: inserted as a user-created prompt (`is_builtin = 0`). If
  the display name collides with an existing row's name, the
  imported one gets ` (imported)` appended so both stay readable in
  the sidebar.
- In-flight summaries are unaffected — the pipeline snapshots the
  prompt at step start.

## Vocabulary → JSON or markdown table

**Where:** Settings → Vocabulary → "Import…"

The picker accepts both `.json` and `.md` / `.markdown`. The two
shapes serve slightly different needs:

- **JSON** carries the full vocabulary file: hints, replacements with
  optional context cues, and notes. Best for LLM-generated files or
  for round-tripping with the Export… button.
- **Markdown table** carries replacement rules only, in a hand-friendly
  shape that works well alongside narrative prose.

Both formats merge into the selected scope using import-wins on
conflict; existing entries are preserved unless the imported file has
the same `from` value, in which case the imported version replaces
the existing one.

### JSON format

The same shape `Settings → Vocabulary → Export…` produces:

    {
      "$description": "Optional human-readable description.",
      "$version": 1,
      "whisperHints": ["Acme Corp", "Falcon", "QBR"],
      "replacements": [
        { "from": "akmee", "to": "Acme" },
        {
          "from": "sim",
          "to": "CIM",
          "requiresContext": ["marketing", "campaign"]
        }
      ],
      "notes": ["Optional free-text notes for humans."]
    }

`whisperHints` are written into Whisper's `initial_prompt` at
transcription time so the model is more likely to recognise the
listed phrases. `replacements` are post-pass rewrites that fix known
mistranscriptions; the optional `requiresContext` array gates a rule
on at least one of those words appearing elsewhere in the transcript
(useful for homophones).

### Markdown table format

A markdown file containing one or more GitHub-flavoured-markdown
tables with the columns `Heard as`, `Should be`, and (optionally)
`Context cue`:

    # My team's vocabulary

    | Heard as | Should be | Context cue |
    |---|---|---|
    | akmee | Acme | |
    | fall come | Falcon | |
    | sim | CIM | marketing, campaign |

Header column names are matched case-insensitively. The third column
is optional — a two-column `Heard as / Should be` table works too.
`Context cue` cells are split on commas, trimmed, and dropped if
empty. Other tables in the same file (acronym glossaries, narrative
tables, etc.) are silently skipped, so a single file can mix
vocabulary tables with other content without polluting the import.

The markdown shape only expresses replacement rules. If you also
want hints or notes in the same scope, import a JSON file before or
after the markdown one — the merge step keeps both contributions.

## Where to keep your private files

If you're working in the distill repo, the convention is to keep
hand-authored personal vocab and prompts under `private/`, which is
gitignored:

    private/
      MY-PROMPTS.md      ← imports via Settings → Prompts → Import…
      MY-VOCAB.md        ← imports via Settings → Vocabulary → Import…
      import/
        global.json      ← imports via Settings → Vocabulary → Import…
        organisation.json
        industry.json

This keeps personal content out of the public tree while letting you
re-bootstrap a fresh distill install in a few clicks.
