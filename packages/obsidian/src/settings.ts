export interface PlaudSettings {
  plaudRegion: 'us' | 'eu';
  pythonPath: string;
  whisperModel: string;
  whisperLanguage: string;
  audioFolder: string;
  notesFolder: string;
  syncIntervalMinutes: number;
  noteTemplate: string;
  syncedIds: string[];
}

export const DEFAULT_SETTINGS: PlaudSettings = {
  plaudRegion: 'eu',
  pythonPath: '/Users/tensor/.mlx-whisper-venv/bin/mlx_whisper',
  whisperModel: 'mlx-community/whisper-large-v3-mlx',
  whisperLanguage: 'auto',
  audioFolder: 'Plaud/Audio',
  notesFolder: 'Plaud/Notes',
  syncIntervalMinutes: 60,
  noteTemplate: `---
plaud_id: {{id}}
title: "{{title}}"
date: "{{date}}"
time: {{time}}
duration: "{{duration}}"
source: plaud_pin
audio: "[[{{audio_path}}]]"
tags: [voice-note, transcription]
---

# {{title}}

## Transcript

{{transcript}}

## Timestamps

{{timestamps}}
`,
  syncedIds: [],
};
