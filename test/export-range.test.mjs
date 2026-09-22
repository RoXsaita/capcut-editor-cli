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
