import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('all eight complete-source generator paths pass a synthetic anchor smoke test',()=>{
 const process=spawnSync('python',[resolve('scripts/selftest-generator.py')],{encoding:'utf8'});
 assert.equal(process.status,0,process.stderr||process.stdout);
 assert.match(process.stdout,/8\/8 complete files/);
});
