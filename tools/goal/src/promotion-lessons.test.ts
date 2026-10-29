import { expect, test } from 'bun:test';
import { git } from './merge.ts';
import { promote } from './promotion.ts';
import { integrationHarness } from './test-support.ts';

const success = { passed: true, output: '', timedOut: false };
const failure = { passed: false, output: 'typecheck failed', timedOut: false };

test('waits for a passing quick gate, then cuts from the newest passing dev head', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('feature');
    let gates = 0;
    await promote({
      settings: h.settings,
      job: h.job,
      runGate: async () => (++gates === 1 ? failure : success),
    });
    await h.job.drain();
    expect(gates).toBe(1);
    expect(git(h.root, 'branch', '--list', 'stabilize')).toBe('');

    const newestGreen = h.advanceDev('newest-green');
    const commands: string[][] = [];
    await promote({
      settings: h.settings,
      job: h.job,
      runGate: async (command) => {
        commands.push([...command]);
        return success;
      },
    });
    expect(commands.slice(0, 2)).toEqual([
      ['bun', 'scripts/typecheck.ts'],
      ['bun', 'run', '--cwd', 'packages/definitions', 'release'],
    ]);
    expect(h.head('stabilize')).toBe(newestGreen);
  } finally {
    h.dispose();
  }
}, 60_000);

test('a passing candidate finishes its gate across control-plane main commits and reconciles before publish', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('stable');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    let mainFix = '';
    const gated: string[] = [];

    await h.promote(async (_command, cwd) => {
      if (_command[0] === 'true') gated.push(git(cwd, 'rev-parse', 'HEAD'));
      if (!mainFix) {
        const path = 'tools/goal/src/hotfix.ts';
        await Bun.write(`${h.root}/${path}`, 'export {}\n');
        git(h.root, 'add', path);
        git(h.root, 'commit', '-m', 'control plane hotfix');
        mainFix = h.head('main');
      }
      return success;
    });

    expect(gated).toEqual([candidate]);
    expect(git(h.root, 'merge-base', '--is-ancestor', mainFix, h.head('main'))).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', candidate, h.head('main'))).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', mainFix, h.head('stabilize'))).toBe('');
  } finally {
    h.dispose();
  }
}, 60_000);
