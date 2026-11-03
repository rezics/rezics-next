import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkSettings } from './config.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SharedInboxQueries } from './inbox-shared.ts';
import { captureLaunchContext, renderLaunchContext } from './launch-context.ts';
import { assertCandidateIntegrity, type CandidateGitRunner } from './merge-train.ts';
import { readControlPolicy } from './policy.ts';
import {
  beginPromotionGroupWindow,
  readPromotionGroupWindows,
  recordPromotionCustodyUnavailable,
} from './promotion-observation.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

function fixture(overrides: unknown) {
  const temporary = temporaryDirectory();
  const localFile = join(temporary.path, 'local.json');
  writeFileSync(localFile, JSON.stringify({ version: 1, pools: [], policy: overrides }));
  const root = resolve(import.meta.dir, '../../..');
  const policy = checkSettings({ cwd: root, localFile, env: { GOAL_MAIN_CHECKOUT: root } }).policy!;
  const db = openDb(join(temporary.path, 'state.sqlite'), policy.storage);
  return {
    ...temporary,
    policy,
    db,
    close() {
      db.close();
      temporary.close();
    },
  };
}

test('local inbox limits preserve paging, folding, send windows and overdue observations', () => {
  const f = fixture({
    inbox: {
      defaultPageSize: 1,
      maxPageSize: 2,
      dedupeWindowMs: 10,
      managerSends: 1,
      managerMessageCharacters: 8,
      sendWindowMs: 20,
      questionAgeMs: 10,
    },
  });
  let now = 1000;
  try {
    const inbox = new SqliteManagerInbox(f.db, f.path, () => now, f.policy.inbox);
    const shared = new SharedInboxQueries(f.db, f.policy.inbox);
    const decision = { managerId: 'owner', from: 'manager', kind: 'decision' as const, summary: 'one' };
    inbox.deliver(decision);
    inbox.deliver(decision);
    inbox.deliver({ ...decision, kind: 'question', summary: 'question', from: 'worker:fixture' });
    expect(inbox.readPage('owner')).toMatchObject({ limit: 1, hasMore: true, entries: [{ deliveries: 2 }] });
    expect(shared.log({ limit: 2 }).entries).toHaveLength(2);
    expect(() => shared.thread('1', { limit: 3 })).toThrow('between 1 and 2');
    expect(() => inbox.readPage('owner', { limit: 3 })).toThrow('between 1 and 2');
    expect(() => inbox.assertManagerSend('manager', 'two')).toThrow('limit is 1');
    expect(() => inbox.assertManagerSend('another', 'x'.repeat(9))).toThrow('at most 8');
    now += 21;
    expect(() => inbox.assertManagerSend('manager', 'two')).not.toThrow();
    expect(shared.digest(0, { now }).totals.overdueQuestions).toBe(1);
    inbox.deliver(decision);
    expect(shared.log({ limit: 2 })).toMatchObject({ hasMore: true });
    expect(shared.log().entries[0]!.id).toBeGreaterThan(2);
    expect(f.policy.inbox.blockerAgeMs).toBe(3600000);
    expect(() => readControlPolicy({ inbox: { maxPageSize: 1 } })).toThrow('defaultPageSize');
  } finally {
    f.close();
  }
});

test('startup history, proof admission and context limits retain exact generation guards', () => {
  const f = fixture({
    history: { attemptPageSize: 1 },
    proof: { concurrency: 1 },
    launchContext: { dependencies: 1, textCharacters: 4, stateCharacters: 3, renderedBytes: 1 },
  });
  try {
    const store = new WorkerStore(f.db, f.policy);
    const task = {
      id: 'proof-task',
      currentAttempt: 1,
      state: 'running',
      worktree: '',
      branch: '',
      base: '',
      brief: { goal: 'fixture', kind: 'verification', markdown: 'contract', after: ['first-id', 'second-id'] },
      proofAuthorization: { fingerprint: 'registered' },
    };
    f.db.query('INSERT INTO worker_tasks VALUES (?,1,1,?)').run(task.id, JSON.stringify(task));
    for (const attempt of [1, 2]) {
      const body = JSON.stringify({ taskId: task.id, attempt, state: 'waiting', checks: [] });
      f.db.query('INSERT INTO worker_attempts VALUES (?,?,?)').run(task.id, attempt, body);
      f.db.query('INSERT INTO worker_records VALUES (?,?,?)').run(task.id, attempt, body);
    }
    expect(store.attemptsPage(task.id, { limit: 1 })).toMatchObject({ hasMore: true, nextAfter: 1 });
    expect(store.recordsPage(task.id, { limit: 1, afterAttempt: 1 }).items[0]!.attempt).toBe(2);
    expect(() => store.recordsPage(task.id, { limit: 2 })).toThrow('between 1 and 1');
    expect(store.proofCapacityAvailable('fixture', 'next')).toBe(false);
    expect(new WorkerStore(f.db).proofCapacityAvailable('fixture', 'next')).toBe(true);
    const context = captureLaunchContext(store, { taskId: task.id, attempt: 1 }, 'fresh');
    expect(context.task).toMatchObject({ id: 'proo', state: 'run', sourceProof: 'unknown' });
    expect(context.dependencies).toMatchObject({
      included: 1,
      omitted: 1,
      completeness: 'truncated',
      receipts: [{ id: 'firs', precondition: 'unknown' }],
    });
    expect(renderLaunchContext(context, f.policy.launchContext)).toContain('2 more: not listed');
    expect(() => captureLaunchContext(store, { taskId: task.id, attempt: 2 }, 'fresh')).toThrow();
    expect(f.policy.verifier.gateTimeoutMs).toBe(14400000);
    expect(f.policy.verifier.standaloneGateTimeoutMs).toBe(7200000);
    expect(() => readControlPolicy({ proof: { concurrency: 0 } })).toThrow('policy.proof.concurrency');
  } finally {
    f.close();
  }
});

test('promotion observation bounds keep boundary values and omit oversized UTF-8 data with identity', () => {
  const commands = [['bun', 'test']];
  const f = fixture({ promotion: { commandRecordBytes: Buffer.byteLength(JSON.stringify(commands)), reasonBytes: 2 } });
  try {
    const first = beginPromotionGroupWindow(
      f.db,
      { promotionId: 'promotion', group: 'head', commit: 'source', commands },
      f.policy.promotion,
    );
    recordPromotionCustodyUnavailable(f.db, first, 'é', f.policy.promotion);
    const second = beginPromotionGroupWindow(
      f.db,
      { promotionId: 'promotion', group: 'next', commit: 'source', commands: [...commands, ['secret']] },
      f.policy.promotion,
    );
    recordPromotionCustodyUnavailable(f.db, second, 'éx', f.policy.promotion);
    const rows = readPromotionGroupWindows(f.db);
    expect(rows.find((row) => row.id === first)).toMatchObject({ commands, physicalReason: 'é' });
    expect(rows.find((row) => row.id === second)).toMatchObject({
      commands: { omitted: true },
      physicalStatus: 'unavailable',
    });
    expect(rows.find((row) => row.id === second)!.physicalReason).toMatch(/^reason omitted \(3 bytes; sha256 /);
  } finally {
    f.close();
  }
});

test('candidate diagnostics obey local bounds without changing rejection or injected Git precedence', () => {
  const f = fixture({ integration: { candidatePaths: 1, candidateDetailCharacters: 4, candidateStatCharacters: 5 } });
  try {
    const log = join(f.path, 'candidate.log');
    const run: CandidateGitRunner = (_cwd, args) => ({
      status: args.includes('--quiet') ? 1 : 0,
      signal: null,
      stdout: args[0] === 'rev-parse' ? 'source' : args.includes('--name-only') ? 'first.ts\0second.ts\0' : 'stat-text',
      stderr: args.includes('--quiet') ? 'diagnostic-private' : '',
    });
    expect(() => assertCandidateIntegrity(f.path, 'source', 'check', log, run, f.policy.integration)).toThrow(
      'tracked working-tree changes',
    );
    const output = readFileSync(log, 'utf8');
    expect(output).toContain('["first.ts"] (1 more omitted)');
    expect(output).toContain('safe diff stat: stat-');
    expect(output).toContain('safe patch omitted: path bound exceeded');
    expect(output).toContain('stderr="diag"');
    expect(output).not.toContain('second.ts');
    expect(output).not.toContain('diagnostic-private');
  } finally {
    f.close();
  }
});
