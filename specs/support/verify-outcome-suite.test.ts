import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOutcomeTimeoutMs } from './verify-outcome-suite';

const verifier = fileURLToPath(new URL('./verify-outcome-suite.ts', import.meta.url));

test("the red run's time limit defaults to 120 seconds", () => {
  expect(getOutcomeTimeoutMs({})).toBe(120_000);
});

test("VERIFY_OUTCOME_TIMEOUT_MS sets the red run's time limit", () => {
  expect(getOutcomeTimeoutMs({ VERIFY_OUTCOME_TIMEOUT_MS: '37' })).toBe(37);
});

test('an invalid VERIFY_OUTCOME_TIMEOUT_MS is refused', async () => {
  for (const value of ['', '0', '-1', '1.5', 'later', '9007199254740992']) {
    expect(() => getOutcomeTimeoutMs({ VERIFY_OUTCOME_TIMEOUT_MS: value })).toThrow(
      `Invalid VERIFY_OUTCOME_TIMEOUT_MS value ${JSON.stringify(value)}`,
    );
  }

  const value = '0';
  const child = Bun.spawn([process.execPath, verifier], {
    env: { ...process.env, VERIFY_OUTCOME_TIMEOUT_MS: value },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = `${stdout}\n${stderr}`;
  expect(code).not.toBe(0);
  expect(output).toContain(`VERIFY_OUTCOME_TIMEOUT_MS value ${JSON.stringify(value)}`);
  expect(output).not.toContain('Expected <suite>');
});

test('a red run that outlives its limit fails naming the limit and the variable', async () => {
  await mkdir('.temp', { recursive: true });
  const temporary = await mkdtemp(resolve('.temp/verify-outcome-suite-test-'));
  try {
    const suite = resolve(temporary, 'slow.test.ts');
    await writeFile(
      suite,
      [
        "import { test } from 'bun:test';",
        "test('slow missing-driver scenario', async () => {",
        '  await Bun.sleep(2_000);',
        "  throw new Error('TEST_DRIVER is required');",
        '});',
        '',
      ].join('\n'),
    );
    const limit = 250;
    const child = Bun.spawn(
      [process.execPath, verifier, suite, 'TEST_DRIVER', 'TEST_DRIVER is required'],
      {
        env: { ...process.env, VERIFY_OUTCOME_TIMEOUT_MS: String(limit) },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain(
      `Missing-driver run timed out after ${limit} ms (VERIFY_OUTCOME_TIMEOUT_MS)`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
