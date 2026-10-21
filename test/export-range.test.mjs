import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations } from '../src/core.mjs';
test('timeline.set explicitly clears inherited export range without touching tracks', () => {
 const doc = {config:{export_range:{start:2966666,duration:33334},maintrack_adsorb:false},tracks:[]};
 applyOperations(doc,[{op:'timeline.set',exportRange:null}],{group:'root'});
 assert.equal(doc.config.export_range,null);
 assert.equal(doc.config.maintrack_adsorb,false);
 assert.deepEqual(doc.tracks,[]);
});
test('timeline.set preserves export selection unless explicitly cleared', () => {
 const doc={config:{export_range:{start:10,duration:20}}};
 applyOperations(doc,[{op:'timeline.set',fps:30}],{group:'root'});
 assert.deepEqual(doc.config.export_range,{start:10,duration:20});
});
test('timeline.set refuses unsupported export range values', () => {
 for(const v of [false,0,{},'all']) {
  const doc={config:{export_range:{start:10,duration:20}}};
  assert.throws(()=>applyOperations(doc,[{op:'timeline.set',exportRange:v}],{group:'root'}),/exportRange/);
 }
});
test('timeline.set refuses durations that fit neither seconds nor µs, and unit-slip tails', () => {
 const run = op => { const doc = { duration: 10_000_000, materials: {}, tracks: [] }; applyOperations(doc, [op], { group: 'root' }); return doc.duration; };
 for (const v of [100000, 33333, 50000]) assert.throws(() => run({ op: 'timeline.set', duration: v }), error => error.code === 'BAD_TIME');
 assert.equal(run({ op: 'timeline.set', duration: 12.5 }), 12_500_000);
 assert.equal(run({ op: 'timeline.set', duration: 12_500_000 }), 12_500_000);
 assert.equal(run({ op: 'timeline.set', durationUs: 33333 }), 33333);
 assert.throws(() => run({ op: 'timeline.set', duration: 600 }), error => error.code === 'DURATION_OUT_OF_RANGE');
 assert.equal(run({ op: 'timeline.set', duration: 600, force: true }), 600_000_000);
});
