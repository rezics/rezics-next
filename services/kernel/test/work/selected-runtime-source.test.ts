import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const patch = read('../../../../patches/@dbos-inc%252Fdbos-sdk@5.5.3-preview.patch');
const runtime = read('../../src/work/selected-runtime.ts');
const executor = read('../../src/command/operational.ts');
const history = read('../../src/history/operational-work-selected.ts');
// UNRUN. Source oracles supplement the native fixture; they do not establish native acceptance.
test('Only the actual registered SDK body site issues; completed native replay has no issuance site', () => {
  expect(patch).toContain('reg?.registeredFunction === sf && reg.selectedExecutionLifecycle');
  expect(patch).toContain('this.#runSelectedStep(reg, lctx, funcID, stepFnName, args');
  expect(patch).toContain('#selectedExecutions = new WeakMap()');
  expect(patch).toContain('selection = Object.freeze({})');
  expect(patch).toContain('lctx.ownerXid');
  expect(patch).toContain('step already completed');
  expect(patch).toContain('getFunctionRegistration)(wrapped)');
  expect(patch).toContain('finally {\n+            revoke();');
  expect(patch).toContain('await admission.close()');
  expect(patch).toContain('release_selected_execution');
});
test('Owner replacement and restore lock against the native COMMIT rather than a released preflight', () => {
  const hold = patch.slice(
    patch.indexOf('CREATE FUNCTION ${s}.hold_selected_execution'),
    patch.indexOf('CREATE FUNCTION ${s}.consume_selected_execution'),
  );
  expect(hold).toContain('workflow_writer_fence_domain d WHERE singleton FOR SHARE');
  expect(hold).toContain('workflow_status WHERE workflow_uuid=id FOR SHARE');
  expect(hold).toContain('workflow_writer_fences WHERE workflow_uuid=id FOR UPDATE');
  expect(hold).toContain('selected_step_executions WHERE workflow_uuid=id AND function_id=fid FOR SHARE');
  expect(hold).toContain('a.attempt_generation IS DISTINCT FROM attempt');
  expect(hold).toContain('domain IS DISTINCT FROM restore');
  expect(hold).not.toContain('COMMIT');
  expect(patch).toContain('pool._clients.includes(client)');
  expect(executor.indexOf('selected.hold(tx, client)')).toBeLessThan(executor.indexOf('const value = await body(tx)'));
  expect(executor.lastIndexOf('selected.hold(tx, client)')).toBeLessThan(
    executor.lastIndexOf("client.query('COMMIT')"),
  );
  expect(executor).toContain("selected?.assertLive();\n              await client.query('COMMIT')");
});
test('One finite lifecycle spans select, released Source, apply and reached failure without a remaining ledger', () => {
  expect(runtime.match(/deadline: Date.now\(\) \+ 5000/g)).toHaveLength(1);
  expect(runtime).not.toContain('remaining: balance');
  expect(runtime).not.toContain('selected-runtime-admission-exhausted');
  expect(runtime).not.toContain('function debit');
  expect(runtime).toContain("state.phase = 'selecting'");
  expect(runtime).toContain('consumeSelectedExecutionAdmission(claim, state.pool)');
  expect(runtime).toContain('selected-runtime-native-multiplicity-exhausted');
  expect(runtime).toContain('state.operations.add(operation)');
  expect(runtime).toContain('await Promise.allSettled([...state.operations])');
  expect(executor).toContain('if (selected) { selected.finish(); throw error; }');
  expect(runtime).not.toContain('reserveOperationalWorkTransfer');
  expect(runtime).not.toContain('openOperationalWorkOriginal');
});
test('Recovery reconciles a real durable outcome; rolled-back or uncertain pending spends cannot fund another body', () => {
  expect(patch).toContain('admission_spent BOOLEAN NOT NULL DEFAULT false');
  expect(patch).toContain('WHERE workflow_uuid=id AND function_id=fid AND NOT admission_spent');
  const replacement = patch.slice(
    patch.indexOf('ON CONFLICT(workflow_uuid,function_id) DO UPDATE'),
    patch.indexOf('RETURNING * INTO a'),
  );
  expect(replacement).not.toContain('admission_spent');
  expect(patch).toContain('(OLD.admission_spent AND NOT NEW.admission_spent)');
  expect(history).toContain('previous?.result ? previous.selected_tuple');
  expect(history).toContain('selected-runtime-recovery-spent-admission');
  expect(history).toContain('No heap committed flag');
});
test('Tuple observations, continuation creation and final association remain native and atomic', () => {
  expect(history).toContain('FOR SHARE OF c FOR UPDATE OF h');
  expect(history).toContain('h.reserved_generation=c.source_generation');
  expect(history).toContain('selected-runtime-observed-version-or-generation-changed');
  expect(history).toContain('assertSelectedContinuation(tx,identity,result.continuation)');
  expect(runtime).toContain("if (!created) refuse('selected-runtime-continuation-not-new')");
  expect(history).toContain(
    'WHERE partition_no=$1 AND workflow_id=$2 AND function_id=$3 AND result IS NULL RETURNING result',
  );
  expect(history).toContain('selected-runtime-final-source-physical-authority-unavailable');
  expect(runtime).toContain('selected-runtime-unknown-native-sql');
  expect(runtime).toContain('state.identity !== expected');
});
