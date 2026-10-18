import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('actual adapters receive the common Vinext/browser workload and retain raw observations', async () => {
  const status = await new Promise<number | null>((done, reject) => {
    const child = spawn('bun', ['scripts/qa/host-admission.ts', '--cpu', '--gib', '3', '--',
      'task', '--taskfile', 'scripts/research/frontend-hotkeys/Taskfile.yml', 'behavior'], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', done);
  });
  expect(status).toBe(0);
  const observations = JSON.parse(readFileSync('.temp/frontend-hotkeys/behavior.json', 'utf8'));
  for (const name of ['native-as-is', 'native', 'ark', 'tanstack']) {
    const candidate = observations.candidates[name];
    expect(candidate.setupError).toBeUndefined();
    expect(candidate.cases.length).toBeGreaterThan(20);
    expect(candidate.scales.map((scale: { count: number }) => scale.count)).toEqual([5, 50]);
    expect(candidate.ssr.status).toBe('pass');
  }
}, 300_000);
