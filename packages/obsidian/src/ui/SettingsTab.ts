import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type PlaudPlugin from '../../main';

const WHISPER_LANGUAGES: Record<string, string> = {
  auto: 'Auto-detect',
  en: 'English',
  zh: 'Chinese',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  ja: 'Japanese',
  ko: 'Korean',
  pt: 'Portuguese',
  ru: 'Russian',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  uk: 'Ukrainian',
  ar: 'Arabic',
  hi: 'Hindi',
};

export class SettingsTab extends PluginSettingTab {
  plugin: PlaudPlugin;

  constructor(app: App, plugin: PlaudPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Authentication ──────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Authentication' });

    const authStatus = containerEl.createDiv('plaud-token-status');
    if (this.plugin.authManager.isConfigured()) {
      const email = this.plugin.authManager.getEmail() ?? 'unknown';
      const tokenInfo = this.plugin.authManager.tokenStatus();
      authStatus.createEl('span', {
        text: `Logged in as ${email} — token: ${tokenInfo}`,
        cls: 'plaud-token-ok',
      });
    } else {
      authStatus.createEl('span', {
        text: 'Not logged in. Run `plaud login` in your terminal to configure credentials.',
        cls: 'plaud-token-missing',
      });
      const helpEl = containerEl.createEl('p', { cls: 'setting-item-description' });
      helpEl.innerHTML = 'Credentials are stored in <code>~/.plaud/config.json</code> and shared with the plaud CLI and MCP server.';
    }

    new Setting(containerEl)
      .setName('Verify connection')
      .setDesc('Test that the stored credentials work.')
      .addButton(btn => btn
        .setButtonText('Verify')
        .setCta()
        .onClick(async () => {
          if (!this.plugin.authManager.isConfigured()) {
            new Notice('No credentials found. Run `plaud login` in your terminal first.');
            return;
          }
          btn.setDisabled(true);
          btn.setButtonText('Verifying…');
          try {
            const recordings = await this.plugin.plaudClient.listRecordings();
            new Notice(`Connected — ${recordings.length} recording(s) found.`);
            this.display();
          } catch (err: any) {
            new Notice(`Connection failed: ${err.message}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('Verify');
          }
        }),
      );

    new Setting(containerEl)
      .setName('Plaud region')
      .setDesc('Select the API region for your Plaud account.')
      .addDropdown(drop => drop
        .addOption('us', 'US (api.plaud.ai)')
        .addOption('eu', 'EU (api-euc1.plaud.ai)')
        .setValue(this.plugin.settings.plaudRegion)
        .onChange(async value => {
          this.plugin.settings.plaudRegion = value as 'us' | 'eu';
          await this.plugin.saveSettings();
        }),
      );

    // ── Transcription ────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Transcription' });

    new Setting(containerEl)
      .setName('mlx_whisper path')
      .setDesc('Absolute path to the mlx_whisper CLI binary.')
      .addText(text => text
        .setPlaceholder('/Users/tensor/Library/Python/3.9/bin/mlx_whisper')
        .setValue(this.plugin.settings.pythonPath)
        .onChange(async value => {
          this.plugin.settings.pythonPath = value.trim();
          await this.plugin.saveSettings();
        }),
      )
      .addButton(btn => btn
        .setButtonText('Check')
        .onClick(async () => {
          btn.setDisabled(true);
          const err = await this.plugin.whisperBridge.checkInstallation(
            this.plugin.settings.pythonPath,
          );
          btn.setDisabled(false);
          if (err) {
            new Notice(`mlx_whisper check failed:\n${err}`, 8000);
          } else {
            new Notice('mlx_whisper is installed and working!');
          }
        }),
      );

    new Setting(containerEl)
      .setName('Whisper model')
      .setDesc('HuggingFace model ID for mlx_whisper. Requires an Apple Silicon Mac.')
      .addText(text => text
        .setPlaceholder('mlx-community/whisper-large-v3-mlx')
        .setValue(this.plugin.settings.whisperModel)
        .onChange(async value => {
          this.plugin.settings.whisperModel = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Language')
      .setDesc('Transcription language. Auto-detect is recommended.')
      .addDropdown(drop => {
        for (const [code, label] of Object.entries(WHISPER_LANGUAGES)) {
          drop.addOption(code, label);
        }
        drop
          .setValue(this.plugin.settings.whisperLanguage)
          .onChange(async value => {
            this.plugin.settings.whisperLanguage = value;
            await this.plugin.saveSettings();
          });
        return drop;
      });

    // ── Storage ──────────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Storage' });

    new Setting(containerEl)
      .setName('Audio folder')
      .setDesc('Vault path where downloaded MP3 files are saved.')
      .addText(text => text
        .setPlaceholder('Plaud/Audio')
        .setValue(this.plugin.settings.audioFolder)
        .onChange(async value => {
          this.plugin.settings.audioFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Notes folder')
      .setDesc('Vault path where transcription notes are created.')
      .addText(text => text
        .setPlaceholder('Plaud/Notes')
        .setValue(this.plugin.settings.notesFolder)
        .onChange(async value => {
          this.plugin.settings.notesFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    // ── Sync ─────────────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync' });

    new Setting(containerEl)
      .setName('Auto-sync interval')
      .setDesc('How often to check for new recordings. Set to Manual to disable auto-sync.')
      .addDropdown(drop => drop
        .addOption('0', 'Manual only')
        .addOption('15', 'Every 15 minutes')
        .addOption('30', 'Every 30 minutes')
        .addOption('60', 'Every hour')
        .addOption('240', 'Every 4 hours')
        .setValue(String(this.plugin.settings.syncIntervalMinutes))
        .onChange(async value => {
          this.plugin.settings.syncIntervalMinutes = Number(value);
          await this.plugin.saveSettings();
          this.plugin.syncManager.restart();
        }),
      );

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Manually trigger a sync of new recordings.')
      .addButton(btn => btn
        .setButtonText('Sync Now')
        .setCta()
        .onClick(() => {
          this.plugin.syncManager.syncNow();
        }),
      );

    new Setting(containerEl)
      .setName('Clear sync history')
      .setDesc('Remove all synced IDs so all recordings will be re-downloaded on next sync.')
      .addButton(btn => btn
        .setButtonText('Clear')
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.syncedIds = [];
          await this.plugin.saveSettings();
          new Notice('Plaud: sync history cleared.');
        }),
      );

    // ── Note Template ────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Note Template' });
    containerEl.createEl('p', {
      text: 'Available variables: {{id}}, {{title}}, {{date}}, {{time}}, {{duration}}, {{audio_path}}, {{transcript}}, {{timestamps}}',
      cls: 'setting-item-description',
    });

    const templateSetting = new Setting(containerEl)
      .setName('Template')
      .setDesc('Markdown template for generated notes.');
    templateSetting.settingEl.style.display = 'block';

    const textarea = templateSetting.controlEl.createEl('textarea');
    textarea.rows = 20;
    textarea.style.width = '100%';
    textarea.style.fontFamily = 'monospace';
    textarea.style.fontSize = '12px';
    textarea.value = this.plugin.settings.noteTemplate;
    textarea.addEventListener('change', async () => {
      this.plugin.settings.noteTemplate = textarea.value;
      await this.plugin.saveSettings();
    });
  }
}
