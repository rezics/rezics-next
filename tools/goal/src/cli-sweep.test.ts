import { expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './cli.ts';
import type { IntegrationRuntime } from './integration-cli.ts';
import type { AttemptFence } from './contracts.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SqliteLandingQueue } from './land.ts';
import { openDb } from './db.ts';
import { temporaryDirectory } from './test-support.ts';
import { WorkerStore } from './store.ts';
import type { Runtime } from './config.ts';

test('the train and inbox commands do not sweep orphans before they run', async () => {
  // Every settle spawns a train; each swept the whole store before finding the lease held (load 146, 2026-10-28).
  // run() marks non-train commands detached in process.env; restore it so later tests in this process see a clean environment.
  const previousTrain = process.env.GOAL_TRAIN_MODE;
  try {
    for (const argv of [['train'], ['inbox', 'read', 'nobody']]) {
      const temporary = temporaryDirectory();
      const stateDirectory = join(temporary.path, 'state');
      mkdirSync(stateDirectory, { recursive: true });
      const db = openDb(join(stateDirectory, 'goal.sqlite'));
      let swept = 0;
      let trains = 0;
      const fence: AttemptFence = {
        assertCurrent() {},
        commitMerge(_ref, merge) {
          return merge();
        },
      };
      const runtime = {
        db,
        stateDirectory,
        mainCheckout: temporary.path,
        worktreeRoot: join(temporary.path, 'worktrees'),
        managerSocket: join(stateDirectory, 'manager.sock'),
        fence,
        sink: { onGateOutcome() {} },
        landing() {
          throw new Error('landing is not used by this test');
        },
        manager() {
          throw new Error('manager is not used by this test');
        },
        managerServices: {
          windows: { register: () => 'window', unregister() {} },
          checkCompletion: async () => ({ passed: true, evidencePath: '', summary: '' }),
          command: ['true'],
        },
        queue: new SqliteLandingQueue(db, fence),
        inbox: new SqliteManagerInbox(db, stateDirectory),
        train: {
          async runWaiting() {
            trains++;
          },
        },
        recoverOrphans: async () => {
          swept++;
        },
      } satisfies IntegrationRuntime;
      try {
        expect(await run(argv, () => runtime)).toBe(0);
        expect(swept).toBe(0);
        expect(trains).toBe(argv[0] === 'train' ? 1 : 0);
      } finally {
        temporary.close();
      }
    }
  } finally {
    if (previousTrain === undefined) delete process.env.GOAL_TRAIN_MODE;
    else process.env.GOAL_TRAIN_MODE = previousTrain;
  }
});

test('task attempt inspection skips recovery and unrelated histories through the CLI', async () => {
  const temporary = temporaryDirectory();
  const db = openDb(':memory:');
  const print = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const store = new WorkerStore(db);
    db.query('INSERT INTO worker_tasks VALUES (?, ?, ?, ?)').run('other', 1, 1, '{"id":"other","state":"running"}');
    db.query('INSERT INTO worker_records VALUES (?, ?, ?)').run('other', 1, 'not json');
    const runtime = {
      db,
      store,
      settings: { stateDirectory: temporary.path },
      tasks: {},
      job: { drain: async () => {} },
      recoverOrphans: async () => {
        throw new Error('attempt inspection must not recover other tasks');
      },
    } as unknown as Runtime;
    expect(await run(['attempts', '--task', 'missing', '--json', '--limit', '1'], () => runtime)).toBe(0);
    expect(JSON.parse(print.mock.calls[0]![0] as string)).toEqual({ records: [], hasMore: false });
    expect(store.decodedRows()).toEqual({ tasks: 0, attempts: 0 });
  } finally {
    print.mockRestore();
    db.close();
    temporary.close();
  }
});
