# 04 — Pipeline

The full journey of one recording, from discovery to filed note.

## 4.1 Poll

Every `config.pollIntervalMinutes`, run:

```ts
import { PlaudAuth, PlaudClient } from '@plaud/core';

const auth = new PlaudAuth(plaudConfig);
const client = new PlaudClient(auth, region);
const recordings = await client.listRecordings();

for (const r of recordings) {
  if (!db.recordingExists(r.id)) {
    db.insertRecording({
      id: r.id,
      filename: r.filename,
      plaud_fullname: r.fullname,
      duration_seconds: r.duration,
      start_time: r.start_time,
      end_time: r.end_time,
      filesize_bytes: r.filesize,
      serial_number: r.serial_number,
      synced_at: Date.now(),
      status: 'inbox',
    });
    notify(`New recording: ${r.filename}`, `${formatDuration(r.duration)} — tap to tag`);
  }
}
```

On `listRecordings()` failure: increment a poll-failure counter, log, and if 3 consecutive failures, show a tray warning and back off to 15-minute polls until the next success.

Update tray icon state: inbox count → badge; recent poll success → `tray-idle`; active pipeline work → `tray-processing`; errors present → `tray-error`.

The poller does NOT download, transcribe, or summarise. Tagged-then-processed is the only path in v1.

## 4.2 Tag

The tagging UX lives in `05-ui.md`. Functionally:

- User picks a `client_id` and `meeting_type_id`. Either can be an existing one or a newly added one (the sheet supports `+ Add new…` inline).
- On save, update the recording row: set `client_id`, `meeting_type_id`, `status='tagged'`, `updated_at=now`.
- Enqueue the recording on the pipeline worker.

## 4.3 Pipeline orchestration

A single in-process worker, FIFO, `concurrency=1` for v1. Reasons for serial: transcription is compute-heavy and diarisation holds a GPU/MPS context; running two at once will thrash. Future v1.1 could add a second lane for non-transcription steps.

```ts
async function runPipeline(recordingId: string) {
  await runStep(recordingId, 'downloading', downloadStep);
  await runStep(recordingId, 'transcribing', transcribeStep);
  await runStep(recordingId, 'summarising', summariseStep);
  await runStep(recordingId, 'writing_note', writeNoteStep);
  db.updateStatus(recordingId, 'complete');
}
```

`runStep` handles:

- Set status, create `jobs` row
- Try; on success mark step done; on failure mark `status='error'`, `last_step=step`, write the error, increment retries, stop
- Retries: up to 3 automatic with exponential backoff (5s, 30s, 2min) for transient errors only (network, 5xx). Permanent errors (401/403, out-of-credits, file corrupt) go straight to `error` and surface to the user.

On app restart: scan for recordings in `downloading` / `transcribing` / `summarising` / `writing_note` (i.e. the app was killed mid-pipeline). Resume from the last successful step.

## 4.4 Step 1 — Download

```ts
async function downloadStep(r: Recording) {
  const url = await plaudClient.getMp3Url(r.id);
  if (!url) {
    throw new Error('No MP3 URL returned — recording may still be processing on Plaud side');
  }

  const dir = path.join(appSupport, 'audio');
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${r.id}.mp3`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await streamToFile(res.body, out);

  const stat = await fs.stat(out);
  if (stat.size < 1024) throw new Error(`Downloaded file too small: ${stat.size} bytes`);

  db.update(r.id, { audio_path: out });
}
```

The temp URL from Plaud is time-limited — fetch immediately after getting it. If the URL 403s after issuing, retry the whole step from `getMp3Url`.

## 4.5 Step 2 — Transcribe + diarise

Spawn the Python CLI in the managed venv:

```ts
async function transcribeStep(r: Recording) {
  const pyBin = path.join(appSupport, 'python', 'bin', 'python');
  const script = path.join(app.getAppPath(), 'python', 'transcribe.py');

  const args = [
    script,
    '--audio', r.audio_path,
    '--whisper-model', config.transcription.whisperModel,
    '--diarise', String(config.transcription.diarisation.enabled),
  ];
  if (config.transcription.language) args.push('--language', config.transcription.language);
  if (config.transcription.diarisation.minSpeakers != null)
    args.push('--min-speakers', String(config.transcription.diarisation.minSpeakers));
  if (config.transcription.diarisation.maxSpeakers != null)
    args.push('--max-speakers', String(config.transcription.diarisation.maxSpeakers));

  const env = { ...process.env, HF_TOKEN: await keychain.get('hf-token') };

  const { stdout, stderr } = await runChild(pyBin, args, { env });
  const result = JSON.parse(stdout);

  const transcriptText = flattenToSpeakerText(result.segments);

  db.update(r.id, {
    transcript_json: JSON.stringify(result),
    transcript_text: transcriptText,
    whisper_snapshot: result.whisper_model,
    pyannote_snapshot: result.diarisation_model,
  });
}
```

### Python script contract

`packages/app/python/transcribe.py` — takes audio, emits JSON on stdout, logs progress on stderr.

Required behaviour:

1. Load MLX Whisper with the configured model. Transcribe the audio. Obtain word-level timestamps.
2. If `--diarise true`:
   - Load `pyannote/speaker-diarization-3.1` with `HF_TOKEN` from env.
   - Use `min_speakers` / `max_speakers` hints if supplied.
   - Run on the audio. This is CPU-bound and the slow part on Apple Silicon — expect ~0.2-0.4× real-time. **Verify** if torch MPS backend works end-to-end with pyannote; some ops fall back to CPU, that's fine.
3. Align: for each Whisper word, assign the speaker whose pyannote segment contains the word's midpoint. If no segment covers it, assign to the nearest segment within 500ms, else `"Speaker ?"`.
4. Merge consecutive same-speaker words into segments. Preserve punctuation and capitalisation exactly as Whisper produced.
5. Emit JSON to stdout:

```json
{
  "language": "en",
  "whisper_model": "mlx-community/whisper-large-v3-mlx",
  "diarisation_model": "pyannote/speaker-diarization-3.1",
  "duration_seconds": 1823.4,
  "speaker_count": 3,
  "segments": [
    { "start": 0.12, "end": 3.47, "speaker": "Speaker 1", "text": "Thanks for joining." },
    { "start": 3.60, "end": 8.91, "speaker": "Speaker 2", "text": "No problem at all." }
  ]
}
```

Progress on stderr, one JSON line per update:
```
{"phase":"transcribe","progress":0.42}
{"phase":"diarise","progress":0.10}
```
Electron parses these and updates the tray tooltip.

Speaker labels are anonymous (`Speaker 1…N`). No voiceprint identification in v1.

### Flattened transcript

`transcript_text` format used by the summariser:

```
Speaker 1: Thanks for joining. Wanted to walk through where we are on the BigQuery migration.

Speaker 2: Sure, happy to. The first phase completed last month — about 60% of the reporting workloads are now on BigQuery.

Speaker 1: And how's performance been?

Speaker 2: Mixed. Query latency on the large joins is noticeably worse than what we had on the legacy warehouse.
```

One blank line between speaker turns. No timestamps in the flattened form.

## 4.6 Step 3 — Summarise

```ts
async function summariseStep(r: Recording) {
  const meetingType = db.getMeetingType(r.meeting_type_id);
  const client = db.getClient(r.client_id);

  const anthropic = new Anthropic({ apiKey: await keychain.get('anthropic-api-key') });

  const systemPrompt = meetingType.prompt;
  const userMessage = [
    `<context>`,
    `Client: ${client.name}`,
    `Meeting type: ${meetingType.name}`,
    `Date: ${new Date(r.start_time * 1000).toISOString()}`,
    `Duration: ${formatDuration(r.duration_seconds)}`,
    `Speakers detected: ${JSON.parse(r.transcript_json).speaker_count}`,
    `</context>`,
    ``,
    `<transcript>`,
    r.transcript_text,
    `</transcript>`,
    ``,
    `Produce the output exactly as specified in the system prompt.`,
  ].join('\n');

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxOutputTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const summary = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { text: string }).text)
    .join('\n');

  db.update(r.id, {
    summary_text: summary,
    prompt_snapshot: systemPrompt,
    model_snapshot: config.anthropic.model,
  });
}
```

If the transcript plus context exceeds the model's input window (unlikely but possible for multi-hour all-hands recordings), chunk by speaker turns into ~100k-token windows, summarise each window using the same prompt, then run a final "roll up these partial summaries into the full output" call with the same prompt. Implement this path only if the first real run hits the limit — defer to v1.1 otherwise.

## 4.7 Step 4 — Write note + Markdown backup

### Apple Notes

```applescript
tell application "Notes"
  tell account "iCloud"
    if not (exists folder "distill") then make new folder with properties {name:"distill"}
    tell folder "distill"
      if not (exists folder "{client}") then make new folder with properties {name:"{client}"}
      tell folder "{client}"
        make new note with properties {name:"{title}", body:"{html_body}"}
      end tell
    end tell
  end tell
end tell
```

Notes treats the `body` property as HTML. Build the body as minimal, stable HTML:

```html
<h1>Summary</h1>
{summary_text converted to paragraphs / headers / lists}
<hr>
<h1>Transcript</h1>
<pre>{transcript_text, HTML-escaped}</pre>
<hr>
<p><i>Recorded {friendly_date} · {duration} · Plaud file {id}</i></p>
```

Markdown-in-summary → HTML conversion: use `marked` or `markdown-it` in the renderer process. Keep the converter strict (no raw HTML injection, no images). **Verify** the exact AppleScript idiom for HTML notes against Apple's current behaviour — Notes' HTML handling has changed over time. A short test script that creates one note with varied formatting is a good smoke test before wiring up the real writer.

Title template (default): `{client} — {meeting_type} — {YYYY-MM-DD HH:mm}`. Meeting types may override via `note_title_template` (e.g. for `ladffa`, an override could be `Committee Meeting — {YYYY-MM-DD}`).

After creation, capture the note ID returned by AppleScript and store in `apple_note_id`. This lets Settings offer "Open in Notes" links.

### Markdown backup

Always write a Markdown file to disk, even on Apple Notes success. Provides durable offline access, trivial grep/search, and survives Apple Notes corruption or account migrations.

Path: `~/Documents/distill/{client}/{YYYY-MM-DD HH-mm} — {sanitised title}.md`

Content:

```markdown
---
client: {client}
meeting_type: {meeting_type}
recorded: {ISO timestamp}
duration: {HH:MM:SS}
plaud_id: {recording id}
model: {model_snapshot}
whisper: {whisper_snapshot}
pyannote: {pyannote_snapshot}
prompt_version: {prompt_history.id that was used}
rating: {rating or null}
apple_note_id: {apple_note_id}
---

# Summary

{summary_text}

---

# Transcript

{transcript_text}
```

YAML frontmatter is not strictly required but makes the Markdown backups discoverable by Obsidian, grep, and future tooling.

If Apple Notes write fails but Markdown succeeds, the recording stays in `error` with `last_step='writing_note'`. User can retry; the Markdown is already safely on disk.

## 4.8 Cross-cutting: progress and tray tooltips

Every step posts progress updates via IPC:

- `pipeline.progress { recording_id, step, phase, fraction }`

The tray subscribes and updates its tooltip: `"Processing: Transcribing (42%)"` or `"Processing: Writing note"`. On `complete`, `"Last completed: {filename}"`. On `error`, `"Error on {filename}: {short message}"`.

macOS notifications fire on:
- New recording in inbox
- Processing complete (with "Open note" action → opens the Apple Note)
- Processing error (with "Show errors" action → opens the errors window)
