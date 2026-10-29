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
      runGate: async () => {
        gates++;
        return failure;
      },
    });
    await h.job.drain();
    expect(gates).toBe(2); // tip, then its first-parent fallback
    expect(git(h.root, 'branch', '--list', 'stabilize')).toBe('');

    await h.promote(async () => {
      gates++;
      return success;
    });
    expect(gates).toBe(3); // the candidate root, task acceptance and boundary gate
    expect(h.head('stabilize')).toBe(h.head('dev'));
  } finally {
    h.dispose();
  }
}, 60_000);

test('when dev tip fails its quick gate, cuts the newest earlier dev commit that passes', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const green = h.advanceDev('green');
    const broken = h.advanceDev('broken');
    const checked: string[] = [];
    await promote({
      settings: h.settings,
      job: h.job,
      runGate: async (command, cwd) => {
        const commit = git(cwd, 'rev-parse', 'HEAD');
        checked.push(`${command[0]}:${commit}`);
        return command[0] === 'bun' && commit === broken
          ? failure
          : success;
      },
    });
    expect(h.head('stabilize')).toBe(green);
    expect(checked).toContain(`bun:${broken}`);
    expect(checked).toContain(`bun:${green}`);
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
