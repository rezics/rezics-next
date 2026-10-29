import { expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const success = { passed: true, output: '', timedOut: false };

test('an infrastructure-only stabilize gate failure reruns the same candidate and records each rerun', async () => {
  const h = integrationHarness();
  try {
    await h.seed('candidate');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    let calls = 0;
    const commits: string[] = [];
    const commands: string[][] = [];
    await h.promote(async (command, _cwd, logPath) => {
      calls++;
      commands.push([...command]);
      commits.push(git(_cwd, 'rev-parse', 'HEAD'));
      if (calls === 1) {
        appendFileSync(
          logPath,
          'Workspace @fixture/kernel finished in 1.00s\n$ bun run check  (services/kernel)\n' +
            'spawnSync docker run ETIMEDOUT\nFailed workspaces: services/kernel\n',
        );
        return { passed: false, output: 'spawnSync docker run ETIMEDOUT', timedOut: true };
      }
      appendFileSync(logPath, 'gate passed on retry\n');
      return success;
    });

    expect(calls).toBe(2);
    expect(commits).toEqual([candidate, candidate]);
    expect(commands[1]).toEqual(['bun', 'run', '--cwd', 'services/kernel', 'check']);
    expect(h.head('main')).toBe(candidate);
    expect(h.inbox).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test.each(['docker run failed with exit code 1', 'rsync error: unexplained error (code 255)'])(
  'a stabilize gate retries infrastructure failure: %s',
  async (failure) => {
    const h = integrationHarness();
    try {
      await h.seed('candidate');
      git(h.root, 'branch', 'stabilize', h.head());
      let calls = 0;
      await h.promote(async () => {
        calls++;
        return calls === 1 ? { passed: false, output: failure, timedOut: false } : success;
      });
      expect(calls).toBe(2);
      expect(h.head('main')).toBe(h.head('stabilize'));
    } finally {
      h.dispose();
    }
  },
);

test('each infrastructure retry is named in the blocked promotion event', async () => {
  const h = integrationHarness();
  try {
    await h.seed('candidate');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    let calls = 0;
    await h.promote(async () => {
      calls++;
      return calls === 1
        ? { passed: false, output: 'spawnSync docker run ETIMEDOUT', timedOut: true }
        : { passed: false, output: 'ssh: connect failed; exit 255', timedOut: false };
    });

    const run = h.store.promotion()!;
    expect(calls).toBe(3);
    expect(run.phase).toBe('stabilize-blocked');
    expect(run.infrastructureReruns?.map(({ attempt, commit }) => ({ attempt, commit }))).toEqual([
      { attempt: 1, commit: candidate },
      { attempt: 2, commit: candidate },
    ]);
    expect(run.infrastructureReruns?.every(({ command, result }) => command.length > 0 && !result.passed)).toBe(true);
  } finally {
    h.dispose();
  }
});

test('an assertion failure on stabilize blocks immediately without infrastructure reruns', async () => {
  const h = integrationHarness();
  try {
    await h.seed('candidate');
    const candidate = h.head();
    git(h.root, 'branch', 'stabilize', candidate);
    let calls = 0;
    await h.promote(async () => {
      calls++;
      return { passed: false, output: 'AssertionError: expected fixture result', timedOut: false };
    });

    const run = h.store.promotion()!;
    expect(calls).toBe(1);
    expect(run.phase).toBe('stabilize-blocked');
    expect(run.infrastructureReruns ?? []).toEqual([]);
    expect(h.head('main')).not.toBe(candidate);
    expect(h.head('stabilize')).toBe(candidate);
  } finally {
    h.dispose();
  }
});
