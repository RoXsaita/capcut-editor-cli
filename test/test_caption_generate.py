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


if __name__ == '__main__':
    unittest.main()
