import { expect, test } from 'bun:test';
import { runPlacedTests } from '../scripts/placed-tests.ts';

// Spec verifier. Synthetic reference drivers prove that each outcome assertion
// rejects a demonstrably wrong behaviour and admits a correct one; they are not
// production proof. The native runs bind the same outcomes to the product.
// References always run every case as a plain test (SPEC_STRICT=1). Native runs
// inherit this verifier's switch: without it the product-red cases are expected
// failures; SPEC_STRICT=1 runs them as plain tests and shows their native reasons.
const strict = process.env.SPEC_STRICT === '1';
const suiteFile = `${import.meta.dir}/consent-issuance-outcomes.test.ts`;
async function suite(reference: string | null, filter: string) {
  const env = { ...process.env };
  delete env.CONSENT_OUTCOME_REFERENCE;
  delete env.SPEC_STRICT;
  if (reference) env.CONSENT_OUTCOME_REFERENCE = reference;
  if (reference || strict) env.SPEC_STRICT = '1';
  const command = [process.execPath, 'test', suiteFile, '--test-name-pattern', filter];
  // Reference drivers have no native fixture; keep their execution synthetic.
  if (!reference) return runPlacedTests(command, { env, timeout: 240_000 });
  const child = Bun.spawn(command, { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}
function counts(output: string, pass: number, fail: number) {
  expect(output).toMatch(new RegExp(`\\b${pass} pass\\b`));
  expect(output).toMatch(new RegExp(`\\b${fail} fail\\b`));
}
async function native(filter: string, pass: number, reason: string) {
  const run = await suite(null, filter);
  if (run.code) console.error(run.output);
  expect(run.code, reason).toBe(0);
  counts(run.output, pass, 0);
}

test('outcome specification rejects stale-scope issuance after committed floor advance', async () => {
  const wrong = await suite('stale', 'removed scope');
  expect(wrong.code).toBe(1);
  expect(wrong.output).toContain('removed scope remained usable after completed consent reduction');
  counts(wrong.output, 0, 2);
  const correct = await suite('correct', '.');
  if (correct.code) console.error(correct.output);
  expect(correct.code).toBe(0);
  counts(correct.output, 6, 0);
  await native(
    'removed scope',
    2,
    'a native establishment in the consent gap kept the removed scope usable after the reduction completed',
  );
}, 240_000);

test('positive concurrency control permits unaffected identities', async () => {
  const wrong = await suite('deny-all', 'unaffected');
  expect(wrong.code).toBe(1);
  counts(wrong.output, 0, 2);
  const correct = await suite('correct', 'unaffected');
  expect(correct.code).toBe(0);
  counts(correct.output, 2, 0);
  await native('unaffected', 2, 'an unaffected native identity did not progress during the consent gap');
}, 240_000);

test('evidence uses native HTTP and durable proof ordering', async () => {
  const wrong = await suite('bad-order', 'HTTP and durable');
  expect(wrong.code).toBe(1);
  counts(wrong.output, 0, 1);
  const correct = await suite('correct', 'HTTP and durable');
  expect(correct.code).toBe(0);
  counts(correct.output, 1, 0);
  const stalled = await suite('deny-all', 'native max=1');
  expect(stalled.code).toBe(1);
  counts(stalled.output, 0, 1);
  const progressing = await suite('correct', 'native max=1');
  expect(progressing.code).toBe(0);
  counts(progressing.output, 1, 0);
  // Real PostgreSQL receipts, service HTTP, the ordinary signer and installed Access.
  await native('HTTP and durable', 1, 'native HTTP and durable evidence did not follow the exact receipt order');
  await native(
    'native max=1',
    1,
    'a one-connection Auth pool, shared with the evidence verifier Access calls, did not complete a consent reduction',
  );
}, 240_000);
