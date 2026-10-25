import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const narrowed = 'bun run --cwd services/x check';

test('a root gate that names its failing workspace is bisected with that workspace check alone', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad');
    const last = await h.seed('omega'); const dev = h.head();
    h.settings.gate = ['root-gate']; h.settings.promotionParallelism = 2;
    const commands: string[] = [];
    await h.promote(async (command, cwd, log) => {
      commands.push(command.join(' '));
      const broken = existsSync(join(cwd, 'bad'));
      const failure = 'AssertionError: incompatible feature\n';
      const output = !broken ? '' : command[0] === 'root-gate'
        ? `Workspace @fixture/x finished in 1.00s\n$ bun run check  (services/x)\n${failure}\nFailed workspaces: services/x\n` : failure;
      appendFileSync(log, output);
      return { passed: !broken, output, timedOut: false };
    });
    const probes = commands.filter(command => command === narrowed).length;
    expect(probes).toBeGreaterThan(1);
    expect(commands.filter(command => command === 'root-gate')).toHaveLength(2);
    expect(git(h.root, 'diff', '--name-only', dev, 'dev')).toBe('bad');
    expect(h.head('main')).toBe(h.head());
    expect(h.store.task(first.id).state).toBe('merged'); expect(h.store.task(last.id).state).toBe('merged');
    expect(h.store.task(culprit.id).currentAttempt).toBe(2);
  } finally { h.dispose(); }
});

test('pausing stops a bisection between rounds and leaves main and dev where they are', async () => {
  const h = integrationHarness();
  try {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await h.seed(name);
    await h.seed('bad'); const dev = h.head(), main = h.head('main');
    h.settings.gate = ['root-gate']; h.settings.promotionParallelism = 1;
    // The first call gates the head and the second classifies main; the third is the first bisection probe.
    let calls = 0;
    await h.promote(async (_command, cwd) => {
      const broken = existsSync(join(cwd, 'bad'));
      if (++calls === 3) writeFileSync(join(h.settings.stateDirectory, 'promotion.paused'), '');
      return { passed: !broken, output: broken ? 'AssertionError: incompatible feature\n' : '', timedOut: false };
    });
    expect(h.head()).toBe(dev); expect(h.head('main')).toBe(main);
    expect(calls).toBe(3);
    expect(h.store.promotion()?.phase).toBe('classify-prefixes');
  } finally { h.dispose(); }
});
