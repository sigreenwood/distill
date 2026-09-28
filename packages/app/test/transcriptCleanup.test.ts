import { describe, it, expect } from 'vitest';
import { cleanWhisperRepetitions } from '../src/main/transcriptCleanup.js';

describe('cleanWhisperRepetitions', () => {
  describe('single-word runs', () => {
    it('collapses long single-word runs ("Repeat Repeat Repeat...")', () => {
      const input = 'Some normal text. Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat. More text.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toBe('Some normal text. Repeat […]. More text.');
      expect(result.runsCollapsed).toBe(1);
    });

    it('collapses "Yeah" runs with punctuation between repeats', () => {
      const input = 'Yeah. Yeah. Yeah. Yeah. Yeah. Yeah. Yeah. Yeah. Yeah.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toContain('Yeah […]');
      expect(result.runsCollapsed).toBe(1);
    });

    it('preserves a few yeahs (natural conversation)', () => {
      const input = 'Yeah, yeah, yeah, exactly.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toBe('Yeah, yeah, yeah, exactly.');
      expect(result.runsCollapsed).toBe(0);
    });

    it('preserves single-occurrence words', () => {
      const input = 'The quick brown fox jumps over the lazy dog.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toBe(input);
      expect(result.runsCollapsed).toBe(0);
    });
  });

  describe('multi-word runs', () => {
    it('collapses 5+ identical short phrases', () => {
      const input = 'Thank you. Thank you. Thank you. Thank you. Thank you. Thank you.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toContain('Thank you. […]');
      expect(result.runsCollapsed).toBe(1);
    });

    it('collapses long-phrase repetitions like "I\'ve been so sad"', () => {
      const input =
        "I've been so sad. I've been so sad. I've been so sad. I've been so sad. I've been so sad. I've been so sad.";
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toContain("I've been so sad. […]");
      expect(result.runsCollapsed).toBe(1);
    });

    it('does NOT collapse 3 repeats of a phrase (legitimate emphasis)', () => {
      const input = 'No, no, no. That is wrong.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toBe(input);
      expect(result.runsCollapsed).toBe(0);
    });

    it('handles repeated phrases separated by newlines', () => {
      const input = 'OK\nOK\nOK\nOK\nOK\nOK\nOK\nOK\nOK';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toContain('OK […]');
      expect(result.runsCollapsed).toBe(1);
    });
  });

  describe('multiple runs in one transcript', () => {
    it('collapses each run independently and counts them', () => {
      const input =
        'Intro text. Yeah Yeah Yeah Yeah Yeah Yeah Yeah Yeah. Middle. Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat. End.';
      const result = cleanWhisperRepetitions(input);
      expect(result.runsCollapsed).toBe(2);
      expect(result.text).toContain('Yeah […]');
      expect(result.text).toContain('Repeat […]');
      expect(result.charsRemoved).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty input', () => {
      const result = cleanWhisperRepetitions('');
      expect(result.text).toBe('');
      expect(result.runsCollapsed).toBe(0);
      expect(result.charsRemoved).toBe(0);
    });

    it('returns identical text when nothing matches', () => {
      const input = 'A normal paragraph with no repetition at all.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toBe(input);
      expect(result.charsRemoved).toBe(0);
    });

    it('preserves paragraph breaks', () => {
      const input = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
      const result = cleanWhisperRepetitions(input);
      expect(result.text).toBe(input);
    });

    it('reports accurate charsRemoved', () => {
      // 9 instances of "OK" in a row
      const input = 'OK OK OK OK OK OK OK OK OK';
      const result = cleanWhisperRepetitions(input);
      expect(result.charsRemoved).toBe(input.length - result.text.length);
    });

    it('handles a real-world chunk from a transcript', () => {
      // Compressed sample of the actual artefact pattern observed in
      // a real distill-produced transcript: a long Repeat run inside
      // otherwise normal speech.
      const input =
        'travelling in that role then or? Well, supposedly, but no one\'s ever given me a travel budget. ' +
        'Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat Repeat ' +
        'Because I\'m still desperate to go to Hyderabad and to Pune.';
      const result = cleanWhisperRepetitions(input);
      expect(result.runsCollapsed).toBeGreaterThanOrEqual(1);
      expect(result.text).toContain('Repeat […]');
      expect(result.text).toContain('travelling in that role');
      expect(result.text).toContain('Hyderabad');
      // The cleaned version should be much shorter.
      expect(result.text.length).toBeLessThan(input.length);
    });
  });
});
