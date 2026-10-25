import { expect, test } from 'bun:test';

async function suite(reference: string | null, filter?: string) {
  const env = { ...process.env };
  delete env.CONSENT_OUTCOME_REFERENCE;
  if (reference) env.CONSENT_OUTCOME_REFERENCE = reference;
  const child = Bun.spawn([process.execPath, 'test', `${import.meta.dir}/consent-issuance-outcomes.test.ts`,
    ...(filter ? ['--test-name-pattern', filter] : [])], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, output: stdout + stderr };
}

test('outcome specification rejects stale-scope issuance after committed floor advance', async () => {
  const wrong = await suite('stale', 'removed scope');
  expect(wrong.code).toBe(1);
  expect(wrong.output).toContain('removed scope remained usable after completed consent reduction');
  expect(wrong.output).toMatch(/2 fail/);
  const correct = await suite('correct');
  if (correct.code) console.error(correct.output);
  expect(correct.code).toBe(0);
  expect(correct.output).toMatch(/6 pass/);
  expect(correct.output).toMatch(/0 fail/);
}, 30_000);

test('positive concurrency control permits unaffected identities', async () => {
  const wrong = await suite('deny-all', 'unaffected');
  expect(wrong.code).toBe(1);
  expect(wrong.output).toMatch(/2 fail/);
  const correct = await suite('correct', 'unaffected');
  expect(correct.code).toBe(0);
  expect(correct.output).toMatch(/2 pass/);
}, 30_000);

test('evidence uses native HTTP and durable proof ordering', async () => {
  const wrong = await suite('bad-order', 'HTTP and durable');
  expect(wrong.code).toBe(1);
  expect(wrong.output).toMatch(/1 fail/);
  const correct = await suite('correct', 'HTTP and durable');
  expect(correct.code).toBe(0);
  // Unlike the synthetic controls, this executes the real PostgreSQL receipts,
  // service HTTP requests, ordinary signer, and installed Access JWT verifier.
  const native = await suite(null, 'HTTP and durable|native max=1');
  if (native.code) console.error(native.output);
  expect(native.code).toBe(0);
  expect(native.output).toMatch(/2 pass/);
}, 120_000);
