# 07 — Install, first run, launchd

## 7.1 `.pkg` installer

Goal: Si double-clicks `distill-{version}.pkg`, accepts a Gatekeeper prompt the first time only, and the app is installed, launched, and running at login on every subsequent boot. No terminal, no manual steps.

### 7.1.1 Build tools

Native macOS tools only: `pkgbuild` and `productbuild`. No third-party packagers.

The build script `packages/app/build/build-pkg.sh` does:

1. `pnpm --filter @distill/app build` — produces a production Electron bundle at `packages/app/dist/`.
2. `electron-builder --mac --arm64 dir` — produces `distill.app` (unsigned). **Verify**: electron-builder's `mac.target: "dir"` skips DMG/PKG creation and gives us a raw `.app` we can wrap ourselves. If electron-builder is unsuitable, `@electron/packager` is a simpler alternative.
3. Ad-hoc sign: `codesign --force --deep --options runtime --sign - "distill.app"`. Ad-hoc signing (`--sign -`) produces an unverifiable signature that macOS accepts after one user-initiated right-click-open. Good enough for personal multi-Mac deployment.
4. `pkgbuild --root <staging>/Applications --install-location /Applications --identifier com.distill.app --version {version} --scripts ./build/scripts distill-component.pkg` — the component package. The `--scripts` folder contains `postinstall` (see 7.1.3).
5. `productbuild --package distill-component.pkg Plaud-Local-{version}.pkg` — the distributable product package.

Artifact: `packages/app/build/out/Plaud-Local-{version}.pkg`.

### 7.1.2 First Gatekeeper prompt

Because the `.pkg` is ad-hoc signed, macOS will block the first double-click. The user sees a dialog with only a "Move to Bin" option. The workaround is:

1. Right-click the `.pkg` → "Open" → the dialog now has an "Open" button.
2. After that, the Installer runs normally.

This happens once per Mac. Document in the README and show it as a step in the first-run docs. Accept that it's a minor friction cost of skipping the $99 Apple Developer Program.

### 7.1.3 `postinstall` script

Runs after the `.app` is copied to `/Applications`. Responsibilities:

1. Determine the current user (the `postinstall` script runs as root, but files need to belong to the user):

   ```sh
   TARGET_USER="${USER:-$(stat -f "%Su" /dev/console)}"
   TARGET_HOME=$(eval echo "~$TARGET_USER")
   ```

2. Write the LaunchAgent plist:

   ```sh
   install -m 644 -o "$TARGET_USER" \
     "/Applications/distill.app/Contents/Resources/launchd.plist.template" \
     "$TARGET_HOME/Library/LaunchAgents/com.distill.app.plist"
   ```

3. Load the LaunchAgent as the user (avoid `launchctl load` — deprecated; use `launchctl bootstrap`):

   ```sh
   sudo -u "$TARGET_USER" launchctl bootstrap \
     "gui/$(id -u "$TARGET_USER")" \
     "$TARGET_HOME/Library/LaunchAgents/com.distill.app.plist"
   ```

   **Verify** the correct `launchctl` invocation for current macOS. On modern macOS the `bootstrap`/`bootout` pair replaces `load`/`unload`.

4. Optionally: spawn the app immediately so first-run wizard appears without a logout/login.

The postinstall must be idempotent — re-running the installer must not double-install the agent.

### 7.1.4 LaunchAgent plist

Template at `resources/launchd.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.distill.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/distill.app/Contents/MacOS/distill</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/{USER}/Library/Logs/distill/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/{USER}/Library/Logs/distill/stderr.log</string>
</dict>
</plist>
```

The `{USER}` placeholder is substituted by the `postinstall` script.

`KeepAlive: SuccessfulExit=false` means: restart the app if it crashes, but don't fight a deliberate Quit. Quitting from the tray menu keeps it stopped until next login.

### 7.1.5 Uninstaller

Ship an uninstaller as a tiny shell script at `/Applications/distill.app/Contents/Resources/uninstall.sh`, callable from Settings → General → "Uninstall distill". It:

1. Prompts the user to confirm (with explicit mention that Apple Notes and Markdown backups are kept).
2. `launchctl bootout` the agent; remove the plist.
3. Remove `~/Library/Application Support/distill/` (offer to keep if user wants).
4. Remove `~/Library/Logs/distill/`.
5. Delete the `.app`.
6. Leave Markdown backups, Apple Notes, and Keychain items untouched unless the user opts in to full removal.

## 7.2 First-run wizard

Triggered the first time the app starts if any of these is missing:

- Anthropic API key in Keychain
- HF token in Keychain
- Plaud auth state
- Python venv at `~/Library/Application Support/distill/python/`
- Whisper / pyannote model files in HF cache

The wizard UI is described in `05-ui.md` §5.7. Here's what happens under the hood on the "Download models" page.

### 7.2.1 Python bootstrap

Python is not bundled. The bootstrap installs it on first run.

1. **Check for `uv`**. Run `which uv`. If absent, install it:

   ```sh
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

   **Verify** the current install command at `https://docs.astral.sh/uv/getting-started/installation/`. If we can't depend on curl availability, vendor the `uv` binary inside the `.app` bundle instead (arm64 builds are ~10MB).

2. **Create venv**:

   ```sh
   uv venv ~/Library/Application\ Support/Plaud\ Local/python --python 3.12
   ```

3. **Install dependencies** from a pinned `pyproject.toml` inside the app bundle:

   ```sh
   cd "$APP/Contents/Resources/python"
   uv pip install --python ~/Library/Application\ Support/Plaud\ Local/python/bin/python -r requirements.txt
   ```

   `requirements.txt` should pin:
   - `mlx-whisper` (latest stable)
   - `pyannote.audio` (latest stable 3.x)
   - `torch` (MPS-enabled build for arm64)
   - `soundfile`, `numpy`, etc. as transitive deps

   **Verify** the exact package names and versions at install-script-authoring time. `mlx-whisper` on PyPI is the Apple MLX implementation; `pyannote.audio` is the dot-separated package name (not `pyannote-audio`).

### 7.2.2 Model downloads

After Python is ready:

1. **Whisper model**: trigger a one-off transcription of a 2-second sample clip (bundled at `resources/smoke-test.wav`) to force HF hub to download and cache the Whisper model. Parse progress from `mlx-whisper`'s stderr if possible; if not, show an indeterminate spinner with "Downloading Whisper model (~3GB)".

2. **pyannote model**: similar approach — run the diarisation pipeline on the same sample clip. This download is smaller (~250MB) but requires the HF token in env. On 401: show a clear error with the two licence acceptance links and a "Try again" button.

3. **Smoke test**: the full sample clip transcription + diarisation is the smoke test. If it completes, mark first-run as done.

Persist the first-run completion state in `config.json`:

```json
{ "firstRunCompleted": true, "firstRunCompletedAt": 1712800000000 }
```

### 7.2.3 Failure modes

The wizard must be resumable. Store the last successful step in `config.json`:

```json
{ "firstRunStep": "anthropicKey" | "hfToken" | "plaud" | "pythonInstalled" | "modelsDownloaded" | "done" }
```

If the user quits mid-wizard or the network drops during model download, next launch resumes from the last completed step.

Ship a "Reset first-run" button in Settings → General → Advanced so the user can re-run the wizard if they need to re-install Python dependencies.

## 7.3 Updating the app itself

Not an auto-updater in v1. Because there's no Developer ID, `Sparkle` (the standard macOS auto-update framework) won't work cleanly without signing. For v1:

- The app checks GitHub Releases (or a user-configured URL) weekly for a newer tagged version.
- If found, tray shows "App update available: X.Y.Z".
- Clicking opens the release page so the user can download and run the new `.pkg` manually.

When a new `.pkg` is installed over an old one, the `postinstall` script should bootout the old LaunchAgent and bootstrap the new one. The running instance of the old app should detect the install and offer a "Relaunch" button.

## 7.4 Multi-Mac deployment

the contributor has "several Macs". Workflow:

1. Build the `.pkg` once on his main Mac.
2. AirDrop or iCloud Drive the `.pkg` to the other Macs.
3. On each: right-click → Open on first install.
4. First-run wizard on each machine prompts for the same API keys. Optionally, a "Import config from another Mac" step accepts a config bundle exported from the first Mac (JSON + prompts only; secrets re-entered).

A v1.1 improvement: export/import a signed config bundle that includes secrets wrapped to the user's iCloud Keychain. Out of scope for v1.
