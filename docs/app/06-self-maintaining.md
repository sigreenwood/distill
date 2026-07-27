# 06 — Self-maintaining: model updates + prompt improvement

Two background jobs keep the app current without silently changing behaviour. Both produce **suggestions** that the user approves — nothing auto-applies. The reasoning:

- Model output shapes can change between versions. A silently-swapped Claude model could reformat every note, or a new pyannote release could change speaker labels.
- Prompts are editorial choices the contributor made deliberately. An AI-suggested rewrite should be a starting point, not a fait accompli.

## 6.1 Model update checks

A scheduled job runs every `selfMaintaining.modelUpdateCheckIntervalDays` (default 7) or on-demand from Settings. It checks three sources and writes any newer candidates into `model_suggestions`.

### 6.1.1 Claude

Call Anthropic's models endpoint — at time of writing, `GET https://api.anthropic.com/v1/models`. **Verify** at `https://docs.claude.com` — both the endpoint and the response shape.

Response filtering logic:

1. Get the list of models available on the user's key.
2. For each Claude family the user's current model belongs to (e.g. Sonnet), check if a model with a newer release date exists.
3. If yes, insert a `model_suggestions` row with `kind='claude'`, `current=config.anthropic.model`, `proposed=<new id>`, `notes=<release notes or changelog if obtainable>`, `status='pending'`.
4. Dedupe: skip if an identical pending or dismissed suggestion already exists.

Claude Code should also surface Opus and Haiku as tier options in Settings if the user wants to switch tiers; this is separate from the update suggestion flow (which stays within-tier).

### 6.1.2 MLX Whisper

Query HuggingFace Hub for the `mlx-community` org, filtering to models with names starting `whisper-`. The hub API is `GET https://huggingface.co/api/models?author=mlx-community&search=whisper`. **Verify** the query params and response shape at `https://huggingface.co/docs/hub/api`.

Candidate criteria:

- Newer `lastModified` than the user's current model.
- Name matches the size tier the user has chosen (e.g. if user is on `large-v3`, suggest `large-v3-turbo` or `large-v4` when it appears, not `medium`).
- Has an MLX quantisation (tag `mlx` or file `mlx-*.npz` present).

### 6.1.3 pyannote

Query `GET https://huggingface.co/api/models?author=pyannote&search=speaker-diarization`. Surface only minor/major version bumps (e.g. `speaker-diarization-3.2`, `speaker-diarization-4.0`) — not patch releases.

Because pyannote models are gated, the suggestion flow includes a reminder that the user must visit the new model's page and accept the licence before the model can be downloaded.

### 6.1.4 Accept flow

When the user clicks "Switch" on a model suggestion:

1. Write current model ID to `model_suggestions.current` history (already there on row).
2. For Whisper/pyannote: download the new model to the HF cache. Run a smoke test transcription against a short sample clip bundled with the app. If the smoke test passes, update `config.transcription.whisperModel` (or `.diarisation.model`).
3. For Claude: update `config.anthropic.model`. No download needed.
4. Record `model_suggestions.status='accepted'`.
5. The next recording uses the new model. Existing notes keep their `model_snapshot` so their history is preserved.

### 6.1.5 Compare flow

The "Compare on 1 note" button does not apply the update. Instead:

1. Pick the most recent `status='complete'` recording.
2. Re-run the `summariseStep` logic with the proposed model, using the same prompt and transcript.
3. Open a diff window showing old summary vs new summary side-by-side.

Useful for Claude model updates in particular — the user can see whether the new model's output style matches what they want.

### 6.1.6 Rollback

If a user accepts a model update and then realises the new model is worse, Settings → Updates → History shows accepted/rolled-back entries with a "Roll back" button. Rollback sets the config back to the prior model (stored on the `model_suggestions` row) and marks the row `status='rolled_back'`.

## 6.2 Prompt improvement suggestions

A reflection job analyses recent transcript/summary pairs for one meeting type at a time and proposes concrete prompt edits. Triggered when a meeting type has accumulated at least `selfMaintaining.reflectionEveryNSummariesPerType` new summaries (default 20) since the last reflection for that type, and at least `reflectionMinSummariesRequired` total (default 10).

### 6.2.1 Inputs to the reflection

For a given meeting type:

- The current live prompt (`meeting_types.prompt`).
- The last N completed recordings of this type (transcript + summary + rating + rating_comment).
- The `prompt_snapshot` for each of those recordings (some may have been summarised under an older prompt — the reflection needs to know).

### 6.2.2 The reflection call

A single Anthropic API call, using a fixed meta-prompt stored in `src/main/reflection/meta-prompt.ts`. Sketch of the meta-prompt:

```
You are reviewing a summarisation prompt used for a specific kind of meeting, and a set of recent
transcript/summary pairs produced by that prompt. Some pairs include a user rating (👍 / 👎) and
an optional note explaining why.

Your job is to suggest concrete improvements to the prompt so that future summaries capture the
actual content of these transcripts more effectively. Only suggest changes if you identify patterns
— new topics, stakeholder types, structural elements, or gaps — that appear across multiple
transcripts and are not adequately addressed by the current prompt.

If the current prompt is working well, respond with {"changes_needed": false, "rationale": "…"}
and no proposal.

Otherwise respond with:
{
  "changes_needed": true,
  "rationale": "A short explanation (3-6 sentences) of what you noticed, which transcripts show it,
                and why the proposed change helps.",
  "proposed_prompt": "The full revised prompt text.",
  "changes_summary": ["bullet list of the main edits, in plain language"]
}

Rules:
- Preserve the original prompt's structure, headings, tone, and non-negotiables unless you have a
  strong reason. Most changes should be additive, not rewrites.
- Reference specific recordings by index when making a point in the rationale.
- Do not suggest edits based on a single outlier transcript. Require at least 3 transcripts to
  exhibit the pattern.
- Be honest about uncertainty. If you're not sure, respond with changes_needed: false.
```

The user message assembles the prompt + transcripts + summaries + ratings into a structured block:

```xml
<current_prompt>
… full prompt text …
</current_prompt>

<recordings>
  <recording index="1" rating="up">
    <transcript>…</transcript>
    <summary>…</summary>
  </recording>
  <recording index="2" rating="down" rating_comment="Missed the commercial discussion at 38m">
    <transcript>…</transcript>
    <summary>…</summary>
  </recording>
  …
</recordings>
```

### 6.2.3 Handling the response

- Parse as JSON (request JSON-only output with a fixed schema).
- If `changes_needed: false`: record a lightweight "no suggestion" entry with a timestamp so the job doesn't re-run too soon on the same data. No row in `prompt_suggestions`.
- If `changes_needed: true`:
  - Insert a `prompt_suggestions` row: `meeting_type_id`, `based_on_prompt_id` (current `prompt_history` row), `proposed_prompt`, `rationale`, `sample_recordings` (the recording IDs used), `status='pending'`.
  - Notification: "Suggested improvement for 'Client Call' prompt" with action "Review".
  - Tray menu gains the "Prompt suggestions (N)" entry.

### 6.2.4 User decision

From the Prompt Suggestions window (5.5):

- **Accept as-is**: overwrite `meeting_types.prompt`; insert `prompt_history` row with `reason='accepted-suggestion'`; mark suggestion `status='accepted'`.
- **Edit & accept**: open the proposal in an editor; save with the same history treatment (`reason='accepted-suggestion'` but `prompt` reflects the user's edits).
- **Dismiss**: mark `status='dismissed'`, no further action. Repeated dismissals of similar suggestions are a signal — see 6.2.6.

### 6.2.5 Rollback

Settings → Meeting types → {type} → History shows the prompt version log. Each row has a "Restore this version" button that overwrites the live prompt with the historical text, creating a new `prompt_history` row with `reason='rollback'`. A rollback does not delete any prior history.

### 6.2.6 Fatigue avoidance

Don't nag. Two rules:

1. After a `dismissed` suggestion, don't re-run reflection on that meeting type for at least `2 × reflectionEveryNSummariesPerType` new summaries.
2. If three successive suggestions for the same type are dismissed, back off to a monthly cadence for that type and surface a note in Settings: "Recent suggestions for this prompt have been dismissed — you can trigger a manual reflection anytime."

### 6.2.7 Cost and privacy notes

Reflection calls are expensive: they include a batch of full transcripts. Approximate size for 20 × one-hour meetings at ~12k tokens each = ~240k tokens in plus ~2k tokens out. At Claude Sonnet 4.6 current pricing (**verify**), this is a non-trivial cost per reflection. Settings → Updates → Advanced should show the estimated cost and offer a "Use Haiku for reflections" option for users who want to trade off depth for cost.

Privacy: reflection sends transcripts to Anthropic in the same way summarisation does. No new data-sharing surface. The user can disable reflection entirely in Settings; the feature is opt-in friendly but on by default.

## 6.3 Manual triggers

Settings exposes manual triggers for both jobs:

- "Check for model updates now" — runs all three update checks immediately.
- "Run prompt reflection now" — choose a meeting type; runs the reflection on the latest data regardless of the usual threshold. Useful when the user knows their meetings have shifted in character.

## 6.4 Observability

All background jobs log to the standard app log with a `job=` tag. Settings → General → "View logs" opens the log file in Console.app (or Finder).

Pending suggestion counts appear on the tray menu. Dismissed and accepted suggestions are retained in the database for the user's review in Settings — use this to answer "why did the app suggest X three weeks ago?".
