import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

test('a stale verifier ref thousands of commits behind cannot pin promotion or bypass the frozen candidate gate', async () => {
  const h = integrationHarness();
  try {
    await h.seed('eligible-feature');
    const originalMain = h.head('main');
    git(h.root, 'update-ref', 'refs/heads/dev-verified', originalMain);
    const previousDev = h.head('dev');
    const latestTree = join(h.settings.stateDirectory, 'latest-without-manifest');
    git(h.root, 'worktree', 'add', '--detach', latestTree, previousDev);
    git(latestTree, 'rm', 'package.json');
    git(latestTree, 'commit', '-m', 'prepare gate fixture');
    const preparedHead = git(latestTree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', 'refs/heads/dev', preparedHead, previousDev);
    git(h.root, 'worktree', 'remove', '--force', latestTree);
    const count = 1200;
    const now = Math.floor(Date.now() / 1000);
    const input: string[] = [];
    for (let index = 0; index < count; index++) {
      input.push(
        'commit refs/heads/dev',
        `mark :${index + 1}`,
        `committer Fixture <fixture@example.invalid> ${now + index} +0000`,
        'data 1',
        'x',
        `from ${index === 0 ? preparedHead : `:${index}`}`,
        '',
      );
    }
    const imported = spawnSync('git', ['fast-import', '--quiet'], {
      cwd: h.root,
      encoding: 'utf8',
      input: `${input.join('\n')}\n`,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(imported.status).toBe(0);
    const latest = h.head('dev');
    expect(Number(git(h.root, 'rev-list', '--count', 'dev-verified..dev'))).toBeGreaterThanOrEqual(count);

    h.settings.gate = ['root-gate'];
    const gated: { command: string; candidate: string }[] = [];
    await h.promote(async (command, cwd) => {
      gated.push({ command: command.join(' '), candidate: git(cwd, 'rev-parse', 'HEAD') });
      return command[0] === 'true'
        ? { passed: false, output: 'AssertionError: fresh task acceptance gate required', timedOut: false }
        : { passed: true, output: '', timedOut: false };
    });

    expect(h.head('stabilize')).toBe(latest);
    expect(h.head('main')).toBe(originalMain);
    expect(gated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'root-gate', candidate: latest }),
        expect.objectContaining({ command: 'true', candidate: latest }),
      ]),
    );
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
  } finally {
    h.dispose();
  }
});
