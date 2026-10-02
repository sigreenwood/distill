# Prompt resources

`suggested-meeting-types.md` holds meeting types offered in Settings →
Prompts as suggestions (accept to add, dismiss to hide). Bundled with
the app via electron-builder's `resources/prompts` rule.

The built-in seed prompts are elsewhere: `docs/app/PROMPTS.md`, read by
`src/main/seed.ts::findPromptsMarkdown` in dev trees only.
