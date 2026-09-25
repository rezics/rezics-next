import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('SEARCH12: pinned Node HTTP response send and abort lifecycle', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/node-http-response-probe.mjs', import.meta.url));
  const child = spawn('node', ['--test', fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 15_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  }).finally(() => clearTimeout(timeout));
  expect(code, output).toBe(0);
  expect(output).toMatch(/(?:^|\n)[#ℹ]\s*tests 4(?:\n|$)/);
  expect(output).toMatch(/(?:^|\n)[#ℹ]\s*fail 0(?:\n|$)/);
}, 20_000);
