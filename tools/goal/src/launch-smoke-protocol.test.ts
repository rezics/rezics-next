import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { parseProviderObject, runLaunchSmoke } from '../scripts/launch-smoke.ts';
import { parseWorkerResult } from './lifecycle-fixture.ts';

const root = resolve(import.meta.dir, '../../..');

test('fake-agent smoke wakes from an actual detached worker-check result and rejects a failed check', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/launch-smoke-protocol-'));
  const agent = join(directory, 'agent');
  writeFileSync(
    agent,
    `#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
const step = process.argv[2];
const id = process.env.REZICS_SMOKE_CHECK_ID;
const record = JSON.parse(readFileSync(process.env.REZICS_SMOKE_RESULT, 'utf8'));
if (record.id !== id || !record.runnerHost || !record.argv || !record.log) process.exit(9);
if (step === 'start') console.log(JSON.stringify({status:'waiting',session:process.env.REZICS_SMOKE_SESSION,checks:[id]}));
else if (step === 'wake') {
  if (record.status !== 'finished' || record.exitCode !== 0) process.exit(8);
  console.log('result passed');
} else console.log(JSON.stringify({status:'success'}));
`,
  );
  chmodSync(agent, 0o755);
  try {
    const lines: string[] = [];
    await runLaunchSmoke(agent, { root, report: (line) => lines.push(line) });
    expect(lines).toEqual(['start: passed', 'wake: passed', 'success: passed']);
    await expect(
      runLaunchSmoke(agent, { root, env: { REZICS_SMOKE_CHECK_EXIT: '7' }, report: () => {} }),
    ).rejects.toThrow('wake: worker-check result did not pass');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict result parsing keeps the Codex session in provider events and rejects undeclared exit fields', () => {
  const checkId = '0e6b5080-1b17-4acf-9fd6-2b5181d3f7c8';
  const waiting = {
    status: 'waiting',
    summary: 'check started',
    blocker: null,
    checks: [checkId],
    approaches: [],
  };
  expect(parseWorkerResult(waiting, 'waiting', checkId)).toEqual(waiting);
  expect(() => parseWorkerResult({ ...waiting, session: 'provider-thread' }, 'waiting', checkId)).toThrow(
    'strict worker result schema',
  );
  expect(() => parseWorkerResult({ status: 'success' }, 'success')).toThrow('strict worker result schema');
});

test('provider result extraction reads the strict JSON from a Codex agent_message event', () => {
  const checkId = '0e6b5080-1b17-4acf-9fd6-2b5181d3f7c8';
  const waiting = {
    status: 'waiting',
    summary: 'check started',
    blocker: null,
    checks: [checkId],
    approaches: [],
  };
  const events = [
    { type: 'thread.started', thread_id: 'provider-thread' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'checking the task' } },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(waiting) } },
    { type: 'turn.completed' },
  ].map((event) => JSON.stringify(event));

  expect(parseWorkerResult(parseProviderObject(events.join('\n'), 'waiting'), 'waiting', checkId)).toEqual(
    waiting,
  );
});
