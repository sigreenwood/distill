# 08 — Errors, logging, testing

## 8.1 Error taxonomy

Classify errors to drive retry behaviour.

| Class | Examples | Retry policy |
|---|---|---|
| Transient network | fetch timeout, DNS failure, 5xx | Auto-retry 3 times with backoff 5s / 30s / 2min |
| Rate limit | 429 from Anthropic or HF | Auto-retry after Retry-After header if present, else 60s / 5min / 15min |
| Auth | 401/403 on Plaud, Anthropic, or HF | No retry. Surface to user with a "Fix in Settings" action. |
| Quota / credits | Anthropic 400 for insufficient credits | No retry. Surface with link to console.anthropic.com. |
| Plaud no-MP3-yet | `getMp3Url` returns null | Retry after 10 minutes (recording may still be processing Plaud-side). |
| Disk full | ENOSPC on audio write | No retry. Surface with disk usage. |
| Python crash | non-zero exit from `transcribe.py` | Retry once; if still failing, surface full stderr to user. |
| Corrupt audio | ffprobe fails, Whisper refuses | No retry. Mark recording as unprocessable. |
| AppleScript fail | osascript non-zero exit | Retry once; if still failing, Markdown backup is still written — mark note step as errored, let user retry from Settings. |

Every error captures:

- `error` text on the recording row
- `last_step` for targeted retry
- A `jobs` row with `status='error'` and the full stderr if available
- An entry in `~/Library/Logs/distill/app.log`

## 8.2 Logging

Rolling file logger (winston, pino, or similar — **Verify** which works cleanly in Electron main).

- File: `~/Library/Logs/distill/app.log`
- Rotation: 5 files × 5 MB each
- Default level: `info`. Settings exposes `debug`.
- Format: JSON lines with `time`, `level`, `component`, `recording_id` (if relevant), `message`, `data`.

Log the following at `info`:
- Poll start / end / recordings found / recordings inserted
- Pipeline step start / success / failure per recording
- Model suggestion discovered / accepted / dismissed / rolled_back
- Prompt reflection triggered / suggestion produced / user action
- First-run wizard steps

Log at `debug`:
- Full Plaud API requests / responses (minus tokens)
- Python subprocess stdout/stderr
- AppleScript invocations

Never log: API keys, JWT tokens, HF token, transcript content, summary content, recording titles.

## 8.3 Error UI

- Tray shows "Errors (N)" when N > 0 errors are outstanding.
- Errors window lists all `status='error'` recordings. Each row: filename, step that failed, error message, "Retry" and "Skip" buttons.
- Settings → General → "Open log folder" opens the log directory in Finder.
- Notifications fire for:
  - First error in a clean state (not repeated for the same run of errors)
  - Auth / quota errors (always — they need attention)

## 8.4 Telemetry

**No telemetry.** The app does not phone home to Anthropic, the author, or anywhere else. Model update checks hit Anthropic and HuggingFace public APIs, but those are user-initiated in intent and only fetch metadata, not send any user data.

Document this clearly in Settings → About and in the README.

## 8.5 Testing

### 8.5.1 Unit tests (vitest)

Located in `packages/app/test/main/`. Cover:

- State machine transitions: all legal transitions accept valid inputs; all illegal transitions throw.
- SQLite migrations: from an empty DB, all migrations apply cleanly; rerunning the migrator is idempotent.
- Config loader: missing keys default correctly; corrupt JSON recovered to defaults with a log warning.
- Seed loader: seeds only if tables are empty; does not overwrite user edits.
- Transcript flattener: various shapes of `segments` array flatten deterministically.
- Prompt snapshot: snapshots written on summarise, reflected back in Markdown frontmatter.
- Client/meeting-type CRUD: add/edit/delete with validation, including uniqueness.
- Reflection response parser: accepts valid JSON, rejects invalid, handles both `changes_needed: true` and `false`.

### 8.5.2 Integration tests

Located in `packages/app/test/integration/`. Mocked Plaud SDK, mocked Anthropic SDK, real SQLite, real Python subprocess against a bundled 10-second sample clip.

Scenarios:

- Full happy path: insert mock recording → tag → pipeline → Markdown file exists, SQLite row is `complete`.
- Download failure → error → retry → success.
- Transcribe failure (Python exits 1) → error → retry once → still fails → final error state.
- Summariser 429 → auto-retry after delay → success.
- AppleScript failure → Markdown still written → status=error on note step → retry succeeds.
- Reflection happy path: insert 20 mock complete recordings for a meeting type → run reflection → `prompt_suggestions` row created.

### 8.5.3 Manual smoke checklist

Run before releasing a new `.pkg`:

1. Fresh Mac (or fresh user) install: double-click, accept Gatekeeper, first-run wizard completes.
2. Create real recording on Plaud device → dock → appears in inbox within a poll cycle.
3. Tag it as a client / meeting type → processes → Apple Note appears in the matching client folder with summary-above-transcript → Markdown file exists at expected path.
4. Thumbs-down the note → rating stored → verify in SQLite via the debug menu.
5. Add a new client "TestClient" from the tag sheet → subsequent recording tagged with TestClient → new Apple Notes folder created.
6. Edit a meeting type's prompt → next recording of that type uses the new prompt → prompt_history has a new row.
7. Pause polling → no new recordings enter inbox → resume → they appear.
8. Quit the app → launchd restarts it within seconds (`KeepAlive`).
9. Reboot the Mac → app starts at login.
10. Force a model-update check via Settings → proceeds without error, shows either "up to date" or a pending suggestion.
11. Uninstall via Settings → everything is removed except Markdown backups and Apple Notes.

### 8.5.4 Loose ends worth manual testing

- Very long recordings (3+ hours) — does the summariser hit context limits; does pyannote run in reasonable time; does the UI stay responsive.
- Multiple recordings landing in the inbox at once (dock the device after a week of meetings).
- Apple Notes account switched from iCloud to On My Mac — does the folder creation still work.
- Network offline during pipeline — behaviour at each step.
- Quitting mid-pipeline and relaunching — resume from last successful step.

## 8.6 Performance targets (v1)

These are starting points, not hard gates. Real figures depend on model choice and M4/M5 variant.

- Poll: <2s per cycle on a good connection.
- Download: ~5-20MB per hour of audio; <30s for a typical hour-long recording.
- Transcription (Whisper large-v3 on M4): ~5-10 minutes for a 1-hour recording.
- Diarisation (pyannote 3.1 on M4 CPU): ~10-20 minutes for a 1-hour recording.
- Summarisation: ~30-90s for a typical meeting.
- Note write: ~1-3s.

Total end-to-end for a 1-hour recording: ~20-35 minutes. The user won't sit watching — they'll tag and come back.

If transcribe + diarise significantly exceeds this, consider:
- Whisper `large-v3-turbo` instead of `large-v3` (half the time, marginal quality trade-off)
- Running pyannote with a smaller checkpoint if one exists
- Skipping diarisation for meeting types where speaker labels don't matter (e.g. `training` / `all-hands` where the speaker is largely one person)
