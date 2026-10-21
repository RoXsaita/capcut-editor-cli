"""Standalone adapter contract; run with the optional captions dependencies installed."""
import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))


class CaptionGenerationTests(unittest.TestCase):
    def test_staging_snapshot_is_bundled_and_hash_pinned(self):
        vendor = ROOT / 'tools' / 'caption_engine'
        self.assertTrue((vendor / 'provenance.json').is_file(), 'Staging engine not bundled')
        manifest = json.loads((vendor / 'provenance.json').read_text())
        for name, sha in manifest['files'].items():
            self.assertEqual(hashlib.sha256((vendor / name).read_bytes()).hexdigest(), sha, name)

    def build(self, **kwargs):
        from caption_generate import prepare_captions
        transcript = {'language':'ar', 'backend':'mlx-whisper', 'model':'mlx-community/whisper-large-v3-turbo',
            'text':'خليت الـ CV برومت', 'segments':[{'words':[
                {'word':'خليت','start':0,'end':.3}, {'word':'الـ','start':.3,'end':.4},
                {'word':'CV','start':.4,'end':.8}, {'word':'برومت','start':.8,'end':1.1}]}]}
        return prepare_captions(transcript, duration=1.2, **kwargs)

    def test_staging_single_word_glue_and_spelling_preserve_times(self):
        b = self.build()
        self.assertEqual([c['text'] for c in b['cues']], ['خليت','الـ CV','برومبت'])
        self.assertEqual([c['start'] for c in b['cues']], [0,.3,.8])
        self.assertEqual(b['asr']['quality'], 'strong')
        self.assertEqual(b['review']['status'], 'needs_review')
        self.assertFalse(b['review']['native_verified'])
        self.assertEqual(b['text_polish']['status'], 'skipped')

    def test_actual_timeline_layout_not_recommended_layout_drives_position(self):
        b = self.build(scenes=[{'at':0,'end':.8,'is':'split-screen','want':'full-face'},
                              {'at':.8,'end':1.2,'is':'full-face','want':'split-screen'}])
        self.assertEqual([c['position'] for c in b['cues']], [50,50,20])

    def test_precomposed_video_placement_runs_before_text_correction(self):
        def positioner(cues):
            return [dict(c, position=50) for c in cues], {'backend':'apple-vision', 'override_count':1}
        b = self.build(positioner=positioner)
        self.assertEqual([c['position'] for c in b['cues']], [50,50,50])
        self.assertEqual(b['placement']['backend'], 'apple-vision')

    def test_no_weak_asr_silently_accepted(self):
        from caption_generate import prepare_captions
        with self.assertRaisesRegex(ValueError,'strong'):
            prepare_captions({'backend':'faster-whisper','model':'base','segments':[]},duration=2)

    def test_sparse_text_cleanup_cannot_change_times(self):
        def polish(_prompt):
            return '{"fixes":[{"id":1,"before":"خليت","text":"خلّيت"}]}', 'fixture'
        b = self.build(run_text=polish)
        self.assertEqual(b['cues'][0]['text'], 'خلّيت')
        self.assertEqual(b['cues'][0]['start'],0)
        self.assertEqual(b['text_polish']['status'],'completed')


class WordlessSegmentTests(unittest.TestCase):
    def transcript(self, *extra, first=True):
        words = {'words': [{'word': 'خليت', 'start': 0, 'end': .3}, {'word': 'CV', 'start': .4, 'end': .8}],
                 'text': 'خليت CV', 'start': 0, 'end': .8}
        tail = {'words': [{'word': 'برومت', 'start': 8.0, 'end': 8.5}], 'text': 'برومت', 'start': 8.0, 'end': 8.5}
        segments = ([words] if first else []) + list(extra)
        return {'language': 'ar', 'model': 'mlx-community/whisper-large-v3-turbo', 'text': 'x',
                'segments': segments, 'tail': tail}

    def test_trailing_wordless_segment_is_dropped_with_a_warning(self):
        from caption_generate import prepare_captions
        t = self.transcript({'text': 'شكرا', 'words': [], 'start': 9.0, 'end': 9.8})
        b = prepare_captions(t, duration=10)
        self.assertEqual([c['text'] for c in b['cues']], ['خليت', 'CV'])
        self.assertTrue(any('9.00-9.80' in w for w in b['warnings']), b['warnings'])
        self.assertEqual(len(b['dropped_segments']), 1)

    def test_sound_labels_and_punctuation_are_dropped_quietly_anywhere(self):
        from caption_generate import prepare_captions
        t = self.transcript({'text': '[موسيقى]', 'words': [], 'start': 0.85, 'end': 3.0},
                            {'text': '...', 'words': [], 'start': 3.0, 'end': 3.5})
        t['segments'].append(t.pop('tail'))
        b = prepare_captions(t, duration=10)
        self.assertEqual([c['text'] for c in b['cues']][-1], 'برومبت')
        self.assertEqual([d['reason'] for d in b['dropped_segments']], ['sound label', 'punctuation'])

    def test_wordless_narration_in_the_middle_refuses(self):
        from caption_generate import prepare_captions
        t = self.transcript({'text': 'كلام مهم', 'words': [], 'start': 2.0, 'end': 3.0})
        t['segments'].append(t.pop('tail'))
        with self.assertRaisesRegex(ValueError, 'middle'):
            prepare_captions(t, duration=10)

    def test_too_much_wordless_narration_refuses(self):
        from caption_generate import prepare_captions
        t = self.transcript({'text': 'شكرا كثير', 'words': [], 'start': 5.0, 'end': 9.0})
        with self.assertRaisesRegex(ValueError, 'no word timestamps'):
            prepare_captions(t, duration=10)

    def test_all_segments_wordless_refuses(self):
        from caption_generate import prepare_captions
        t = self.transcript({'text': 'شكرا', 'words': [], 'start': 0, 'end': 1}, first=False)
        with self.assertRaisesRegex(ValueError, 'word timestamps'):
            prepare_captions(t, duration=10)


class SparsePolishTests(unittest.TestCase):
    CUES = [{'id': 1, 'text': 'انا', 'start': 0, 'end': .3}, {'id': 2, 'text': 'خليت', 'start': .3, 'end': .6},
            {'id': 3, 'text': 'برومت', 'start': .6, 'end': .9}]

    def polish(self, reply):
        from caption_engine.align import llm_polish_cues
        report = {}
        out = llm_polish_cues([dict(c) for c in self.CUES], '', run_text=lambda _p: (reply, 'fixture'), report=report)
        return out, report

    def test_one_unknown_id_does_not_discard_a_valid_fix(self):
        out, report = self.polish(json.dumps({'fixes': [{'id': 2, 'before': 'خليت', 'text': 'خلّيت'},
                                                        {'id': 99, 'before': 'x', 'text': 'y'}]}))
        self.assertEqual(out[1]['text'], 'خلّيت')
        self.assertEqual(report['status'], 'completed')
        self.assertEqual(report['rejected'], 1)
        self.assertEqual(report['changed'], 2)       # plus the built-in برومبت spelling

    def test_duplicate_id_is_rejected(self):
        out, report = self.polish(json.dumps({'fixes': [{'id': 2, 'before': 'خليت', 'text': 'خلّيت'},
                                                        {'id': 2, 'before': 'خليت', 'text': 'خليط'},
                                                        {'id': 3, 'before': 'برومت', 'text': 'برومبت'}]}))
        self.assertEqual(out[1]['text'], 'خليت')
        self.assertEqual(out[2]['text'], 'برومبت')
        self.assertEqual(report['rejected'], 2)

    def test_normalised_before_still_applies_a_typo_fix(self):
        out, report = self.polish(json.dumps({'fixes': [{'id': 1, 'before': 'أنا ', 'text': 'أنا'}]}))
        self.assertEqual(out[0]['text'], 'أنا')
        self.assertEqual(report['rejected'], 0)

    def test_stale_before_hiding_a_word_swap_is_rejected(self):
        out, report = self.polish(json.dumps({'fixes': [{'id': 2, 'before': 'خليت ', 'text': 'عملت'},
                                                        {'id': 3, 'before': 'برومت', 'text': 'برومبت'}]}))
        self.assertEqual(out[1]['text'], 'خليت')
        self.assertEqual(report['rejected'], 1)
        self.assertEqual(report['status'], 'completed')

    def test_every_fix_rejected_and_unparseable_replies_fail(self):
        out, report = self.polish(json.dumps({'fixes': [{'id': 9, 'before': 'x', 'text': 'y'}]}))
        self.assertEqual(report['status'], 'failed')
        out, report = self.polish('not json at all')
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(out[2]['text'], 'برومبت')


class OnsetSnapTests(unittest.TestCase):
    def index(self):
        from audio_index import AudioIndex
        db = [-20.0] * 30 + [-70.0] * 50 + [-20.0] * 70     # silent 0.30-0.80
        return AudioIndex(db, 0.01)

    def test_a_start_in_silence_moves_to_the_onset(self):
        from audio_index import snap_word_starts
        words = [{'word': 'CV', 'start': 0.40, 'end': 0.95}]
        self.assertEqual(snap_word_starts(self.index(), words), 1)
        self.assertAlmostEqual(words[0]['start'], 0.8 - 1 / 30, delta=0.011)
        self.assertEqual(words[0]['start_whisper'], 0.40)

    def test_loud_start_and_late_onset_do_not_move(self):
        from audio_index import snap_word_starts
        loud = [{'word': 'a', 'start': 0.10, 'end': 0.30}]
        late = [{'word': 'b', 'start': 0.40, 'end': 0.82}]
        self.assertEqual(snap_word_starts(self.index(), loud), 0)
        self.assertEqual(snap_word_starts(self.index(), late), 0)
        self.assertEqual((loud[0]['start'], late[0]['start']), (0.10, 0.40))
        self.assertNotIn('start_whisper', late[0])

    def test_prepare_captions_snaps_a_copy_and_reports_it(self):
        from caption_generate import prepare_captions
        t = {'language': 'ar', 'model': 'mlx-community/whisper-large-v3-turbo', 'text': 'خليت CV',
             'segments': [{'text': 'خليت CV', 'words': [{'word': 'خليت', 'start': 0, 'end': .3},
                                                        {'word': 'CV', 'start': .4, 'end': .95}]}]}
        b = prepare_captions(t, duration=1.5, onsets=self.index())
        self.assertEqual(b['onset_snapped'], 1)
        self.assertAlmostEqual(b['cues'][-1]['start'], 0.767, delta=0.011)
        self.assertEqual(t['segments'][0]['words'][1]['start'], .4)
        plain = prepare_captions(t, duration=1.5)
        self.assertEqual(plain['onset_snapped'], 0)
        self.assertEqual(plain['cues'][-1]['start'], .4)


class CaptionTextModelTests(unittest.TestCase):
    def test_keeps_typo_fixes_and_drops_word_swaps(self):
        from caption_text_llm import fixes_json
        reply = '```json\n' + json.dumps({'fixes': [
            {'id': 24, 'before': 'من القيسات', 'text': 'من القياسات'},
            {'id': 88, 'before': 'يقار', 'text': 'يقارن'},
            {'id': 20, 'before': 'الغشرية', 'text': 'الغسالة'},
            {'id': 87, 'before': 'بلش', 'text': 'بدأ'},
            {'id': 65, 'before': 'لا فقام', 'text': 'فقام'},
            {'id': 56, 'before': 'بلا', 'text': 'بلا'},
        ]}, ensure_ascii=False) + '\n```'
        kept = json.loads(fixes_json(reply))['fixes']
        self.assertEqual([f['id'] for f in kept], [24, 88])
        self.assertIsNone(fixes_json('no json here'))

    def test_chain_can_be_turned_off_and_rejects_unknown_backends(self):
        import os
        from unittest import mock

        import caption_text_llm
        with mock.patch.dict(os.environ, {'CAPCUTCTL_CAPTION_TEXT_CHAIN': 'off'}):
            self.assertIsNone(caption_text_llm.default_text_callback())
        with mock.patch.dict(os.environ, {'CAPCUTCTL_CAPTION_TEXT_CHAIN': 'gpt-free'}):
            self.assertRaises(ValueError, caption_text_llm.chain)


if __name__ == '__main__':
    unittest.main()
