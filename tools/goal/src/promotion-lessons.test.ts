import { expect, test } from 'bun:test';
import { git } from './merge.ts';
import { promote } from './promotion.ts';
import { integrationHarness } from './test-support.ts';

const success = { passed: true, output: '', timedOut: false };
const failure = { passed: false, output: 'typecheck failed', timedOut: false };

test('does not cut stabilize from dev until both quick gates pass', async () => {
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

    await h.promote(async () => {
      gates++;
      return success;
    });
    expect(gates).toBe(2); // candidate gate, then the next candidate gate
    expect(h.head('stabilize')).toBe(h.head('dev'));
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
  } finally {
    h.dispose();
  }
}, 60_000);
