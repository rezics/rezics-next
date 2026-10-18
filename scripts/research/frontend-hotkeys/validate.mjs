import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const path='docs/goals/product-completion-20261019/keyboard-comparison.json';
const report=JSON.parse(readFileSync(path,'utf8'));
assert.equal(report.schema_version,1);
assert.equal(report.production_changes,false);
assert.equal(report.decision.can_adopt_this_task,false);
for(const id of ['keys-priority','keys-ime','keys-inputs','keys-customization','keys-access','keys-platform','keys-lifecycle','keys-cost','focus-return']) {
  assert(report.acceptance[id],`Missing ${id}`);
  for(const candidate of ['native-as-is','native','ark','tanstack']) assert(report.acceptance[id].candidates[candidate],`${id}: ${candidate}`);
}
assert.equal(report.budgets.gzipDeltaBytes,8192);
assert.equal(report.budgets.brotliDeltaBytes,6144);
for(const [candidate,data] of Object.entries(report.candidates)) {
  assert(data.vectors.length>20,candidate);
  assert(data.scales.length===2,candidate);
  assert(data.observed_status);
}
for(const path of report.fixture.sources)assert(existsSync(path),path);
assert(report.research_refresh_policy.triggers.length>=4);
assert(report.follow_ups.every(item=>item.owner&&item.smallest_question&&item.decision_changed_by));
let captures=0;
if(process.argv.includes('--captures')) {
  for(const row of [...report.evidence.artifacts,...Object.values(report.evidence.sources)]) {
    assert(existsSync(row.path),row.path);
    const body=readFileSync(row.path);
    assert.equal(body.length,row.bytes,row.path);
    assert.equal(createHash('sha256').update(body).digest('hex'),row.sha256,row.path);
    captures++;
  }
}
console.log(`Valid report: 9 acceptance groups, 4 adapters, ${captures} checked capture/source hashes`);
