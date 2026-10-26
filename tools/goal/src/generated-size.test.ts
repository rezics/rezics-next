import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import type { GateOutcome } from './contracts.ts';
import { git } from './merge.ts';
import { repository } from './test-support.ts';
import { classifyFailure } from './failures.ts';

function setup() {
  const repo = repository();
  writeFileSync(join(repo.main, '.gitattributes'), 'generated*.txt linguist-generated=true\n');
  git(repo.main, 'add', '.gitattributes'); git(repo.main, 'commit', '-m', 'Mark generated files');
  const outcomes: GateOutcome[] = [];
  const db = openDb(join(repo.path, 'state.sqlite'));
  const fence = { assertCurrent() {}, commitMerge(_ref: unknown, merge: () => string) { return db.transaction(merge).immediate(); } };
  const queue = new SqliteLandingQueue(db, fence);
  return { ...repo, queue, outcomes, options: { mainCheckout: repo.main, stateDirectory: join(repo.path, 'state'),
    worktreeRoot: join(repo.path, 'trees'), queue, fence, sink: { onGateOutcome(outcome: GateOutcome) { outcomes.push(outcome); } } },
    close() { db.close(); repo.close(); } };
}

describe('generated file size accounting', () => {
  test('files marked linguist-generated do not count toward the estimate', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'source.txt', 'one\n');
      writeFileSync(join(request.worktree, 'generated.txt'), 'one\ntwo\nthree\n');
      writeFileSync(join(request.worktree, 'generated-extra.txt'), 'one\ntwo\nthree\n');
      git(request.worktree, 'add', '.'); git(request.worktree, 'commit', '-m', 'Add source and generated output');
      request.declaredPaths = ['source.txt', 'generated*.txt'];
      s.queue.enqueue(request);
      await new MergeTrain({ ...s.options, runGate: async () => ({ passed: true, output: '', timedOut: false }) }).run();
      const outcome = s.outcomes[0] as GateOutcome & { nonGeneratedChangedFiles?: string[]; nonGeneratedDiffLines?: number };
      expect(outcome.nonGeneratedChangedFiles).toEqual(['source.txt']);
      expect(outcome.nonGeneratedDiffLines).toBe(1);
      expect(outcome.changedFiles).toContain('generated.txt');
      expect(classifyFailure({ ...outcome, passed: false },
        { brief: { paths: ['source.txt', 'generated*.txt'], estimate: { lines: 1, files: 1 } } } as never,
        { failureKind: null, exitCode: 0, fixRound: 0, consulted: false, previousFailure: null, blocker: 'working', result: '' } as never,
        {} as never, { maxSteps: 100, maxMs: 60_000 } as never, true)).toBe('new-failure');
    } finally { s.close(); }
  });

  test('files marked linguist-generated still count toward the declared paths', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'source.txt');
      writeFileSync(join(request.worktree, 'generated.txt'), 'generated\n');
      git(request.worktree, 'add', '.'); git(request.worktree, 'commit', '-m', 'Add undeclared generated output');
      request.declaredPaths = ['source.txt'];
      (request as typeof request & { protectedPaths?: string[] }).protectedPaths = ['generated.txt'];
      s.queue.enqueue(request);
      await new MergeTrain({ ...s.options, runGate: async () => ({ passed: true, output: '', timedOut: false }) }).run();
      expect(s.outcomes[0]?.stage).toBe('scope');
      expect(s.outcomes[0]?.changedFiles).toContain('generated.txt');
    } finally { s.close(); }
  });
});
