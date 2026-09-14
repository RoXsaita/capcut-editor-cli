import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExport } from '../src/export.mjs';
test('native export rejects partial, wrong-duration and non-video files', () => {
  const probe = { format: { duration: '46.234' }, streams: [{ codec_type: 'video' }] };
  assert.equal(checkExport(probe, 46.233), 46.234);
  assert.throws(() => checkExport(probe, 50), /EXPORT_DURATION_MISMATCH/);
  assert.throws(() => checkExport({ format: { duration: '46.233' }, streams: [] }, 46.233));
  assert.throws(() => checkExport({ format: { duration: 'NaN' }, streams: [{ codec_type: 'video' }] }, 46.233));
});
