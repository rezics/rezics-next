import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { repository } from './test-support.ts';

function setup() {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  const fence: AttemptFence = {
    assertCurrent() {},
    commitMerge(_ref, merge) {
      return db.transaction(() => merge()).immediate();
    },
  };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  const options = {
    mainCheckout: repo.main,
    stateDirectory: join(repo.path, 'state'),
    worktreeRoot: join(repo.path, 'trees'),
    queue,
    fence,
    sink: {
      onGateOutcome(outcome: GateOutcome) {
        outcomes.push(outcome);
      },
    },
    runGate: async () => ({ passed: true, output: '', timedOut: false }),
  };
  return {
    repo,
    db,
    queue,
    outcomes,
    options,
    close() {
      db.close();
      repo.close();
    },
  };
}

test('a process running stale control-plane code hands the train to a fresh process instead of driving it', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.repo.branch('alpha', 'a'));
    const before = git(s.repo.main, 'rev-parse', 'main');
    let handedOff = 0;
    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => false,
      handOff: () => {
        handedOff++;
      },
    }).run();
    expect(handedOff).toBe(1);
    expect(s.outcomes).toEqual([]);
    expect(git(s.repo.main, 'rev-parse', 'main')).toBe(before);
    expect(s.queue.next()?.request.taskId).toBe('alpha');
    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => true,
      handOff: () => {
        handedOff++;
      },
    }).run();
    expect(handedOff).toBe(1);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([['alpha', true]]);
  } finally {
    s.close();
  }
});

test('code currency compares the running code with the control plane on main', async () => {
  const { captureLoadedCodeVersion, codeVersion } = await import('./runtime-version.ts');
  const repo = repository();
  try {
    const started = codeVersion(repo.main, 'base');
    expect(codeVersion(repo.main, 'base')).toBe(started);
    repo.commit('base', 'changed');
    expect(codeVersion(repo.main, 'base')).not.toBe(started);

    mkdirSync(join(repo.main, 'tools/goal'), { recursive: true });
    writeFileSync(join(repo.main, 'tools/goal/STAMP'), 'v1\n');
    git(repo.main, 'add', '--', 'tools/goal/STAMP');
    git(repo.main, 'commit', '-m', 'Add tools/goal');
    const loaded = captureLoadedCodeVersion(repo.main);
    expect(loaded).toBe(codeVersion(repo.main, 'tools/goal'));
    const mainBefore = git(repo.main, 'rev-parse', 'main');
    repo.commit('base', 'unrelated');
    expect(git(repo.main, 'rev-parse', 'main')).not.toBe(mainBefore);
    expect(captureLoadedCodeVersion(repo.main)).toBe(loaded);
  } finally {
    repo.close();
  }
});
