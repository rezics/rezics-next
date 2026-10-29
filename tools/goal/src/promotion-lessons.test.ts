import { expect, test } from 'bun:test';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const success = { passed: true, output: '', timedOut: false };
const failure = { passed: false, output: 'typecheck failed', timedOut: false };

test('does not cut stabilize from dev until both quick gates pass', async () => {
  const h = integrationHarness();
  try {
    await h.seed('feature');
    let gates = 0;
    await h.promote(async () => (++gates === 1 ? failure : success));
    expect(gates).toBe(1);
    expect(git(h.root, 'branch', '--list', 'stabilize')).toBe('');

    await h.promote(async () => {
      gates++;
      return success;
    });
    expect(gates).toBe(6); // preflight, candidate gate, then preflight for the next window
    expect(h.head('stabilize')).toBe(h.head('dev'));
  } finally {
    h.dispose();
  }
});

test('a passing candidate finishes its gate across control-plane main commits and reconciles before publish', async () => {
  const h = integrationHarness();
  try {
    const task = await h.seed('stable');
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
    expect(h.store.task(task.id).state).toBe('merged');
  } finally {
    h.dispose();
  }
});

test('a passed stabilize candidate promotes when main moved only by control-plane commits', async () => {
  const h = integrationHarness();
  try {
    const task = await h.seed('stable');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    const path = 'tools/goal/src/main-fix.ts';
    await Bun.write(`${h.root}/${path}`, 'export {}\n');
    git(h.root, 'add', path);
    git(h.root, 'commit', '-m', 'control plane hotfix');
    const mainFix = h.head('main');
    let gates = 0;
    await h.promote(async () => {
      gates++;
      return success;
    });
    expect(gates).toBe(3); // one candidate gate; two quick gates cut the following window
    expect(git(h.root, 'merge-base', '--is-ancestor', mainFix, h.head('main'))).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', candidate, h.head('main'))).toBe('');
    expect(h.store.task(task.id).state).toBe('merged');
  } finally {
    h.dispose();
  }
});
