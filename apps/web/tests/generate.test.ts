import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const generator = join(app, 'scripts/generate.ts');

async function runGeneration(failures: number, message: string, code?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'web-generate-'));
  const attempts = join(directory, 'attempts');
  const output = join(directory, 'output');
  const preload = join(directory, 'preload.ts');
  writeFileSync(
    preload,
    `import { mock } from 'bun:test';\n` +
      `import { appendFileSync, writeFileSync } from 'node:fs';\n` +
      `mock.module('@inlang/paraglide-js', () => ({ compile: async () => {\n` +
      `  appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n');\n` +
      `  const count = readFileSync(${JSON.stringify(attempts)}, 'utf8').trim().split('\\n').length;\n` +
      `  if (count <= ${failures}) { const error = new Error(${JSON.stringify(message)}); ${code ? `error.code = ${JSON.stringify(code)};` : ''} throw error; }\n` +
      `  writeFileSync(${JSON.stringify(output)}, 'generated');\n` +
      `} }));\n` +
      `import { readFileSync } from 'node:fs';\n`,
  );

  const child = Bun.spawn(['bun', '--preload', preload, generator], {
    cwd: app,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const [codeResult, stdout, stderr] = await Promise.all([child.exited, stdoutPromise, stderrPromise]);
  const attemptsMade = existsSync(attempts) ? readFileSync(attempts, 'utf8').trim().split('\n').length : 0;
  return {
    code: codeResult,
    stdout,
    stderr,
    attemptsMade,
    generated: existsSync(output),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('retries Lix timeouts in new processes and succeeds on a later compilation', async () => {
  const result = await runGeneration(1, 'Lix open did not settle within 30000ms');
  try {
    expect(result.code).toBe(0);
    expect(result.attemptsMade).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'Retrying Paraglide compilation (attempt 2/3): Lix open did not settle within 30000ms',
    );
    expect(result.generated).toBe(true);
  } finally {
    result.cleanup();
  }
}, 120_000);

test('retries Lix worker errors identified by code and reports the first error line', async () => {
  const result = await runGeneration(
    1,
    'Lix worker did not acknowledge request receipt within 30000ms\nextra details',
    'LIX_WORKER_TIMEOUT',
  );
  try {
    expect(result.code).toBe(0);
    expect(result.attemptsMade).toBe(2);
    expect(result.stderr).toContain(
      'Retrying Paraglide compilation (attempt 2/3): Lix worker did not acknowledge request receipt within 30000ms',
    );
    expect(result.stderr).not.toContain('extra details');
  } finally {
    result.cleanup();
  }
}, 120_000);

test('retries twice and exits with the last Lix error after the third failure', async () => {
  const result = await runGeneration(3, 'LixError: Lix worker is closed\nadditional context', 'LIX_WORKER_CLOSED');
  try {
    expect(result.code).not.toBe(0);
    expect(result.attemptsMade).toBe(3);
    expect(result.stderr.match(/Retrying Paraglide compilation/gu)).toHaveLength(2);
    expect(result.stderr).toContain('LixError: Lix worker is closed');
    expect(result.stderr).toContain('additional context');
    expect(result.generated).toBe(false);
  } finally {
    result.cleanup();
  }
}, 120_000);

test('does not retry compilation errors outside the Lix failure signatures', async () => {
  const result = await runGeneration(1, 'Invalid message syntax');
  try {
    expect(result.code).not.toBe(0);
    expect(result.attemptsMade).toBe(1);
    expect(result.stderr).not.toContain('Retrying Paraglide compilation');
    expect(result.stderr).toContain('Invalid message syntax');
  } finally {
    result.cleanup();
  }
}, 120_000);

test('a successful first compilation prints no retry message and writes generated output', async () => {
  const result = await runGeneration(0, 'unused');
  try {
    expect(result.code).toBe(0);
    expect(result.attemptsMade).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.generated).toBe(true);
  } finally {
    result.cleanup();
  }
}, 120_000);
