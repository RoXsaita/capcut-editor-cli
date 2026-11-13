import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonForTool } from '../src/python.mjs';

// gate --xray needs the export's transcript (speech, first-word, last-word). --no-text used to
// return before --speech ran, so a scan with both flags had no transcript and the gate failed
// "speech: no transcript of the export".
test('xray --no-text still transcribes when --speech is set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcutctl-xray-speech-'));
  try {
    const tools = fileURLToPath(new URL('../tools', import.meta.url));
    const out = execFileSync(pythonForTool('xray.py').executable, ['-c', [
      'import sys,json,types',
      'from pathlib import Path',
      'sys.path.insert(0,sys.argv[1])',
      'import xray, xray_text',
      'xray_text.transcribe_export=lambda video,cache,lang=None:{"words":[{"word":"hi","start":0.1,"end":0.4}],"lang":lang}',
      'out=Path(sys.argv[2])',
      'res=[]',
      'for speech in (True,False):',
      '  args=types.SimpleNamespace(no_text=True,speech=speech,lang="ar")',
      '  r=xray.text_pass(args,"export.mp4",None,None,out,None)',
      '  res.append({"speech":r["_speech"],"verdict":r["verdicts"][0]["verdict"],"file":(out/"speech.json").exists()})',
      'print(json.dumps(res))',
    ].join('\n'), tools, dir], { encoding: 'utf8' });
    const [withSpeech, without] = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(withSpeech.speech, { words: [{ word: 'hi', start: 0.1, end: 0.4 }], lang: 'ar' });
    assert.equal(withSpeech.file, true, 'speech.json is written for the gate');
    assert.equal(withSpeech.verdict, 'NOT CHECKED', 'captions stay not checked under --no-text');
    assert.equal(without.speech, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
