"""Run: python -m unittest test_speakers   (from this directory, in the venv)."""
import unittest

import numpy as np

import speakers as sp


def seg(s, e, t):
    return {"start": s, "end": e, "text": t}


class MapTime(unittest.TestCase):
    # Two speech runs: original 10-14s and 30-33s, compacted with a 2s join.
    pieces = [(0.0, 10.0, 4.0), (6.0, 30.0, 3.0)]

    def test_inside_runs(self):
        self.assertAlmostEqual(sp.map_time(1.0, self.pieces, "start"), 11.0)
        self.assertAlmostEqual(sp.map_time(7.5, self.pieces, "end"), 31.5)

    def test_join_silence_snaps_away_from_removed_time(self):
        self.assertAlmostEqual(sp.map_time(5.0, self.pieces, "start"), 30.0)
        self.assertAlmostEqual(sp.map_time(5.0, self.pieces, "end"), 14.0)

    def test_past_the_end_and_no_vad(self):
        self.assertAlmostEqual(sp.map_time(99.0, self.pieces, "end"), 33.0)
        self.assertEqual(sp.map_time(12.5, None, "start"), 12.5)

    def test_remap_drops_empty_and_keeps_order(self):
        out = sp.remap_segments([seg(0, 1, " hi "), seg(1, 2, "  ")], self.pieces)
        self.assertEqual(out, [{"start": 10.0, "end": 11.0, "text": "hi"}])


class TextSimilarity(unittest.TestCase):
    def test_identical_and_unrelated(self):
        self.assertEqual(sp.text_similarity("the budget is approved", "The budget is approved."), 1.0)
        self.assertEqual(sp.text_similarity("hello there", "completely different words"), 0.0)

    def test_empty(self):
        self.assertEqual(sp.text_similarity("", "x"), 0.0)


def speech_like(seconds, seed):
    """Noise whose loudness bursts at irregular, syllable-like intervals."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sp.SAMPLE_RATE)
    syl = int(0.18 * sp.SAMPLE_RATE)
    amps = np.clip(rng.normal(0.6, 0.5, n // syl + 2), 0, None) * (rng.random(n // syl + 2) > 0.2)
    contour = np.interp(np.arange(n), np.arange(len(amps)) * syl, amps)
    return (rng.standard_normal(n) * contour).astype(np.float32)


class SuppressEcho(unittest.TestCase):
    def setUp(self):
        self.others_audio = np.zeros(20 * sp.SAMPLE_RATE, dtype=np.float32)
        self.others_audio[2 * sp.SAMPLE_RATE : 8 * sp.SAMPLE_RATE] = speech_like(6, 1)
        self.others = [seg(2, 8, "we should launch on the fifteenth of march")]

    def test_bleed_with_same_words_is_dropped(self):
        you_audio = 0.3 * self.others_audio
        you = [seg(2.1, 8.0, "We should launch on the 15th of March")]
        kept, dropped = sp.suppress_echo(you, self.others, you_audio, self.others_audio)
        self.assertEqual((len(kept), len(dropped)), (0, 1))

    def test_bleed_with_garbled_words_is_dropped_by_contour(self):
        delay = int(0.09 * sp.SAMPLE_RATE)
        you_audio = np.zeros_like(self.others_audio)
        you_audio[delay:] = 0.3 * self.others_audio[:-delay]
        you = [seg(2.1, 8.0, "wheat shod lunch honk the fifth teen of arch")]
        kept, dropped = sp.suppress_echo(you, self.others, you_audio, self.others_audio)
        self.assertEqual((len(kept), len(dropped)), (0, 1))

    def test_real_speech_while_others_talk_is_kept(self):
        you_audio = speech_like(20, 99)  # different contour from the others
        you = [seg(3, 7, "sorry could I just add something about the budget")]
        kept, dropped = sp.suppress_echo(you, self.others, you_audio, self.others_audio)
        self.assertEqual((len(kept), len(dropped)), (1, 0))

    def test_speech_when_others_silent_is_kept_even_if_same_words(self):
        you = [seg(12, 16, "we should launch on the fifteenth of march")]
        kept, dropped = sp.suppress_echo(you, self.others, np.zeros(1), self.others_audio)
        self.assertEqual((len(kept), len(dropped)), (1, 0))


class Turns(unittest.TestCase):
    def test_interleave_and_merge(self):
        you = [seg(7, 10, "I think March."), seg(10.5, 12, "If approved.")]
        others = [seg(0, 5, "Thanks for joining."), seg(12, 18, "Budget meets Tuesday.")]
        text = sp.render_turns(sp.build_turns(you, others))
        self.assertEqual(
            text,
            "Others: Thanks for joining.\n\nYou: I think March. If approved.\n\nOthers: Budget meets Tuesday.",
        )

    def test_long_gap_starts_new_turn(self):
        turns = sp.build_turns([], [seg(0, 2, "a"), seg(20, 22, "b")])
        self.assertEqual(len(turns), 2)


if __name__ == "__main__":
    unittest.main()
