import { describe, it, expect } from 'vitest';
import { buildTranscribeArgs } from '../src/main/pipelineSteps.js';

describe('buildTranscribeArgs', () => {
  it('whisper: passes --whisper-model and no engine flag', () => {
    const args = buildTranscribeArgs({
      engine: 'whisper',
      whisperModel: 'mlx-community/whisper-large-v3-mlx',
      parakeetModel: 'mlx-community/parakeet-tdt-0.6b-v3',
      initialPrompt: null,
    });
    expect(args).toEqual(['--whisper-model', 'mlx-community/whisper-large-v3-mlx']);
  });

  it('whisper: includes --initial-prompt when given', () => {
    const args = buildTranscribeArgs({
      engine: 'whisper',
      whisperModel: 'mlx-community/whisper-large-v3-mlx',
      parakeetModel: 'mlx-community/parakeet-tdt-0.6b-v3',
      initialPrompt: 'Simon Greenwood, Teradata.',
    });
    expect(args).toEqual([
      '--whisper-model',
      'mlx-community/whisper-large-v3-mlx',
      '--initial-prompt',
      'Simon Greenwood, Teradata.',
    ]);
  });

  it('whisper: omits --initial-prompt when empty string', () => {
    const args = buildTranscribeArgs({
      engine: 'whisper',
      whisperModel: 'mlx-community/whisper-large-v3-mlx',
      parakeetModel: 'mlx-community/parakeet-tdt-0.6b-v3',
      initialPrompt: '',
    });
    expect(args).toEqual(['--whisper-model', 'mlx-community/whisper-large-v3-mlx']);
  });

  it('parakeet: passes --engine and --parakeet-model, never --whisper-model', () => {
    const args = buildTranscribeArgs({
      engine: 'parakeet',
      whisperModel: 'mlx-community/whisper-large-v3-mlx',
      parakeetModel: 'mlx-community/parakeet-tdt-0.6b-v3',
      initialPrompt: null,
    });
    expect(args).toEqual(['--engine', 'parakeet', '--parakeet-model', 'mlx-community/parakeet-tdt-0.6b-v3']);
  });

  it('parakeet: never includes --initial-prompt, even when one is given', () => {
    // The whole point of the engine split — Parakeet has no prompt/hotword
    // mechanism, so silently passing this through would be a lie about
    // what the vocabulary/attendee system is actually doing.
    const args = buildTranscribeArgs({
      engine: 'parakeet',
      whisperModel: 'mlx-community/whisper-large-v3-mlx',
      parakeetModel: 'mlx-community/parakeet-tdt-0.6b-v3',
      initialPrompt: 'Simon Greenwood, Teradata.',
    });
    expect(args).not.toContain('--initial-prompt');
    expect(args).toEqual(['--engine', 'parakeet', '--parakeet-model', 'mlx-community/parakeet-tdt-0.6b-v3']);
  });
});
