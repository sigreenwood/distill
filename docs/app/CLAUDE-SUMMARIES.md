# Summaries with Claude Code (optional)

distill writes every summary on your Mac with Ollama, and nothing leaves it.
This guide is for the **optional** alternative: letting
[Claude Code](https://code.claude.com) write the summary for clients you choose.
Summaries are usually better. The cost is that **the transcript is sent to
Anthropic**, which is the one thing distill otherwise never does.

It is off until you turn it on, and it only ever applies to clients you have
allowed one by one.

## What goes where

| | Local (default) | Claude Code (opt-in) |
|---|---|---|
| Who writes the summary | Ollama, on this Mac | Claude, via your Claude Code sign-in |
| Transcript leaves the Mac | No | **Yes**, to Anthropic |
| Transcription (audio → text) | On this Mac | **Still on this Mac.** Audio is never sent. |
| Works offline | Yes | No |
| Same input, same output | Yes (temperature 0) | No (Claude Code cannot set a temperature) |
| Cost | Free | Counts against your Claude plan (or your API billing if you use a key) |

For a recording going to Claude, what is sent is: the transcript, that meeting
type's prompt, the attendee list, the client's account context, and notes made
from any attached slides. Nothing else. The audio is never sent, and neither is
anything from other recordings.

Everything else that uses a model stays local: filing suggestions, meeting
search, client briefs, transcript corrections, attached-file notes, and the
reader's "try an alternative summary".

## Before you start

- macOS 13 or later, and a country Anthropic supports.
- A Claude plan that includes Claude Code: Pro, Max, Ultra, Team or Enterprise,
  or an Anthropic Console account. The free claude.ai plan does not.
- **Check the data terms of that account.** Consumer and business plans differ
  in how data is retained and whether it can be used to improve models. If the
  material belongs to a client, make sure the account you sign in with is one
  your agreement with them allows. The Claude tab shows exactly which account
  will receive the data.

## Step 1. Install Claude Code

Any one of these (from Anthropic's setup page):

```bash
curl -fsSL https://claude.ai/install.sh | bash     # native installer (recommended)
brew install --cask claude-code                    # Homebrew
npm install -g @anthropic-ai/claude-code           # npm, Node 22+, never with sudo
```

The native installer puts `claude` in `~/.local/bin`, which a normal Terminal
sees but an app launched from Finder does not. distill looks there itself, and
in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.bun/bin` and
`~/.volta/bin`, so you do not need to change any PATH.

Open a **new** Terminal window and check it:

```bash
claude --version        # prints something like: 2.1.123 (Claude Code)
```

## Step 2. Sign in

```bash
claude
```

Follow the browser prompt, then type `/exit`. Check it took:

```bash
claude auth status      # "loggedIn": true
```

`claude doctor` prints a fuller health check if anything looks wrong.

## Step 3. Turn it on in distill

1. **Settings → Claude.** Step 1 on the page should show a tick, your version
   and the account. If not, press **Check again** after fixing it.
2. Press **Send a test**. It sends one fixed sentence (nothing from any
   recording) and shows the model, the time and the cost. This proves the whole
   path works.
3. Tick **Allow Claude Code to write summaries** and confirm the prompt.
   **Nothing is sent yet.**
4. **Settings → Clients.** Open a client and tick **Let Claude Code write
   summaries for …**. Confirm. Only now do that client's *new* summaries go to
   Claude.
5. Optionally pick a model (Sonnet, Opus, Haiku, or Claude Code's default).

Recordings that are not filed to any client stay local unless you also tick
*Also use it for recordings not filed to any client*. A recording that has only
a **suggested** client (from "Queue all") always stays local: the suggestion
comes from a local model and can be wrong, so it can hold a summary back but can
never allow one to leave.

## How you can tell what happened

- The model on a recording starts with **`claude-code:`** (for example
  `claude-code: claude-sonnet-4-6`) when Claude wrote it, and is the Ollama
  model name when it was local. It is in History and in the saved output.
- The log, `~/Library/Logs/distill/app.log`, has one line per transcript that
  went out: `summarising with Claude Code (transcript sent to Anthropic)`, with
  the recording and the reason, and another for every one that stayed local.
- Existing summaries are never rewritten when you change a setting.

## If it does not work

distill then writes the summary **locally** and tells you with a notification.
It never goes the other way: if Ollama fails, nothing is sent to Claude.

| Message | What to do |
|---|---|
| Claude Code was not found | Install it (step 1), then **Check again**. It may be in an unusual place; `which claude` in Terminal shows where. |
| Not signed in | Run `claude` in Terminal and sign in. |
| Rate-limited / usage limit | Wait, or switch the client back to local. Claude Code uses your plan's allowance. |
| Did not answer within 10 minutes | Try again; very long transcripts take longer. |
| Billed unexpectedly | If `ANTHROPIC_API_KEY` is set where distill runs, Claude Code may use it (API billing) instead of your plan. |

## Turning it off

- **One client:** untick it under Settings → Clients. Immediate.
- **Everything:** untick *Allow Claude Code to write summaries* in Settings →
  Claude. Immediate. Client permissions are kept but do nothing.
- To go back to a clean slate, `claudeSummaries` in
  `~/Library/Application Support/distill/config.json` can be deleted.

## How it works (for the curious)

distill runs `claude -p` with the meeting type's prompt as the system prompt and
the transcript on standard input. A plain `claude -p` is **not** a clean
summariser: it also loads your own `~/.claude/CLAUDE.md`, settings, hooks and
tools into the request. Measured here, a note from a personal `CLAUDE.md` was
quoted back and the call used about 11,000 extra tokens. So distill passes
`--tools ""`, `--no-session-persistence`, `--setting-sources ""`,
`--disable-slash-commands` and `--strict-mcp-config`, and runs from an empty
folder; the same probe then found nothing and the request was about 190 tokens.
`--bare` would isolate it too, but it only works with an API key and ignores the
sign-in most people use.

Claude Code also uses a small model for its own housekeeping, so both a small
and a large model may see the start of the request. Both are Anthropic's, under
the same account.

The code is `src/main/claudeCode.ts` (running a call), `summaryProvider.ts` (the
rules above, as short pure functions) and `pipelineSteps.ts` (`tryClaudeSummary`).
The design record is DECISIONS.md §8. To run the live test against your own
Claude Code (one tiny call with made-up text):

```bash
DISTILL_LIVE_CLAUDE_TEST=1 npx vitest run packages/app/test/claudeCode.test.ts -t live
```
