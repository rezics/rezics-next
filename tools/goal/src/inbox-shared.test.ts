import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SharedInboxQueries } from './inbox-shared.ts';
import { temporaryDirectory } from './test-support.ts';

function setup(now = 1_800_000_000_000) {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  let clock = now;
  const inbox = new SqliteManagerInbox(db, temporary.path, () => clock);
  const shared = new SharedInboxQueries(db);
  return {
    ...temporary,
    db,
    inbox,
    shared,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    close() {
      db.close();
      temporary.close();
    },
  };
}

test('shared log applies every filter, returns bounded newest-first cursor pages, and leaves delivery state untouched', () => {
  const s = setup();
  try {
    const insert = (summary: string, overrides: Record<string, unknown> = {}) =>
      s.inbox.deliver({
        managerId: 'recipient-a',
        kind: 'info',
        summary,
        from: 'manager-a',
        goalId: 'goal-a',
        taskId: 'task-a',
        ...overrides,
      } as never);
    insert('First Alpha detail');
    s.advance(1_000);
    insert('Second Alpha detail');
    s.advance(1_000);
    insert('Other Goal detail', { goalId: 'goal-b', taskId: 'task-b' });
    s.advance(1_000);
    insert('Foreign recipient detail', { managerId: 'recipient-b', from: 'manager-b' });
    s.advance(1_000);
    insert('Newest Alpha detail');

    const rows = s.db
      .query('SELECT id, manager, read_at, acknowledged_at, notified FROM manager_inbox ORDER BY id')
      .all() as {
      id: number;
      manager: string;
      read_at: number | null;
      acknowledged_at: number | null;
      notified: number;
    }[];
    s.db
      .query('UPDATE manager_inbox SET read_at = 15, acknowledged_at = 16, notified = 1 WHERE manager = ?')
      .run('recipient-a');
    const before = s.db
      .query('SELECT id, manager, read_at, acknowledged_at, notified FROM manager_inbox ORDER BY id')
      .all();

    const selected = s.shared.log({
      from: 'manager-a',
      to: 'recipient-a',
      goal: 'goal-a',
      task: 'task-a',
      since: s.now() - 3_000,
      grep: 'ALPHA',
      limit: 1,
    });
    expect(selected.entries.map((entry) => entry.summary)).toEqual(['Newest Alpha detail']);
    expect(selected.hasMore).toBe(true);
    const next = s.shared.log({
      from: 'manager-a',
      to: 'recipient-a',
      goal: 'goal-a',
      task: 'task-a',
      since: s.now() - 3_000,
      grep: 'ALPHA',
      limit: 1,
      cursor: selected.nextCursor!,
    });
    expect(next.entries.map((entry) => entry.summary)).toEqual(['Second Alpha detail']);
    expect(next.hasMore).toBe(false);
    expect(
      s.db.query('SELECT id, manager, read_at, acknowledged_at, notified FROM manager_inbox ORDER BY id').all(),
    ).toEqual(before);
    expect(rows.length).toBe(5);
    expect(() => s.shared.log({ limit: 101 })).toThrow('between 1 and 100');
  } finally {
    s.close();
  }
});

test('question closure requires a direct info or decision link; digest groups actual decisions, documents, blockers, escalations and overdue questions', () => {
  const s = setup();
  try {
    s.inbox.deliver({
      managerId: 'owner',
      from: 'consumer',
      kind: 'question',
      summary: 'Which contract?',
      goalId: 'accounts',
      taskId: 'task-1',
    });
    const original = s.shared.log({ grep: 'Which contract?' }).entries[0]!;
    s.advance(31 * 60_000);
    s.inbox.deliver({
      managerId: 'consumer',
      from: 'owner',
      kind: 'question',
      summary: 'Do you mean v2?',
      replyToId: original.id,
    });
    const clarification = s.shared.log({ grep: 'Do you mean v2?' }).entries[0]!;
    s.inbox.deliver({
      managerId: 'other',
      from: 'consumer',
      kind: 'decision',
      summary: 'Use signed IDs',
      goalId: 'accounts',
      taskId: 'task-2',
      documentRefs: [{ path: 'docs/identity.md', change: 'Added signed ID format' }],
    });
    s.inbox.deliver({
      managerId: 'owner',
      from: 'consumer',
      kind: 'blocker',
      summary: 'Migration host is unavailable',
      goalId: 'accounts',
      taskId: 'task-2',
    });
    s.inbox.deliver({
      managerId: 'owner',
      from: 'consumer',
      kind: 'info',
      summary: 'Escalated the owner deadlock',
      goalId: 'accounts',
      taskId: 'task-1',
      escalation: { target: 'supermanager', reason: 'One owner exchange did not settle the contract' },
    });

    // Recipient acknowledgement changes delivery state only; the open question remains a digest candidate.
    s.inbox.read('owner');
    s.inbox.acknowledge('owner');
    const since = s.now() - 5 * 60_000;
    const digest = s.shared.digest(since, { now: s.now(), limit: 20 });
    expect(digest.groups).toEqual([
      {
        goal: 'accounts',
        counts: {
          decisions: 1,
          blockers: 1,
          escalations: 1,
          overdueQuestions: 1,
          blockersOverOneHour: 0,
        },
      },
    ]);
    const decision = digest.details.entries.find((entry) => entry.category === 'decision')!;
    expect(decision.documentRefs).toEqual([{ path: 'docs/identity.md', change: 'Added signed ID format' }]);
    expect(
      digest.details.entries.some((entry) => entry.category === 'overdue-question' && entry.id === original.id),
    ).toBe(true);
    const bounded = s.shared.digest(since, { now: s.now(), limit: 1 });
    expect(bounded.details.hasMore).toBe(true);
    expect(bounded.details.nextCursor).not.toBeNull();
    expect(bounded.totals).toEqual(digest.totals);

    s.advance(61 * 60_000);
    const aged = s.shared.digest(s.now() - 5 * 60_000, { now: s.now(), limit: 20 });
    expect(aged.totals.blockersOverOneHour).toBe(1);
    expect(aged.details.entries.some((entry) => entry.category === 'blocker-intervention')).toBe(true);

    s.inbox.deliver({
      managerId: 'owner',
      from: 'consumer',
      kind: 'info',
      summary: 'The clarification is answered',
      goalId: 'accounts',
      taskId: 'task-1',
      replyToId: clarification.id,
    });
    s.inbox.deliver({
      managerId: 'owner',
      from: 'consumer',
      kind: 'decision',
      summary: 'The original question is answered',
      goalId: 'accounts',
      taskId: 'task-1',
      replyToId: original.id,
    });
    const answered = s.shared.digest(s.now(), { now: s.now() });
    expect(answered.totals.overdueQuestions).toBe(0);
    expect(answered.totals.decisions).toBe(1);
  } finally {
    s.close();
  }
});

test('malformed optional metadata stays unavailable while shared inbox views retain messages and counts', () => {
  const s = setup();
  try {
    const decision = { managerId: 'owner', from: 'worker', kind: 'decision' as const, summary: 'Decision', goalId: 'g',
      taskId: 't', documentRefs: [{ path: 'docs/decision.md' }], escalation: { reason: 'Explicit context' } };
    s.inbox.deliver(decision);
    s.inbox.deliver({ managerId: 'owner', from: 'worker', kind: 'blocker', summary: 'Blocked', goalId: 'g', taskId: 't', replyToId: 1 });
    const malformed = { ...decision, documentRefs: { path: 'wrong shape' }, escalation: [] };
    s.db.query('UPDATE manager_inbox SET event = ?, document_refs = ?, escalation = ? WHERE id = 1').run(
      JSON.stringify(malformed), JSON.stringify({ path: 'wrong shape' }), JSON.stringify([]),
    );

    const page = s.shared.log({ goal: 'g', limit: 1 });
    expect([page.entries[0]?.summary, page.hasMore, page.nextCursor]).toEqual(['Blocked', true, 2]);
    const decisionRow = s.shared.log({ goal: 'g', limit: 1, cursor: 2 }).entries[0]!;
    expect(decisionRow).toMatchObject({ id: 1, from: 'worker', to: 'owner', goal: 'g', task: 't', kind: 'decision',
      summary: 'Decision', replyToId: null, threadRootId: 1, event: malformed, documentRefs: null, escalation: null });
    expect(s.shared.thread(1).entries.map(({ id, replyToId, threadRootId, documentRefs, escalation }) =>
      [id, replyToId, threadRootId, documentRefs, escalation])).toEqual([[1, null, 1, null, null], [2, 1, 1, null, null]]);

    const digest = s.shared.digest(s.now() - 1, { now: s.now(), limit: 1 });
    expect(digest.totals).toEqual({ decisions: 1, blockers: 1, escalations: 0, overdueQuestions: 0, blockersOverOneHour: 0 });
    expect([digest.details.entries[0]?.category, digest.details.entries[0]?.documentRefs,
      digest.details.entries[0]?.escalation, digest.details.hasMore, digest.details.nextCursor]).toEqual([
      'decision', null, null, true, 1,
    ]);
  } finally {
    s.close();
  }
});

test('legacy migration preserves instruction and system rows, leaves arrival time unknown, and thread reads survive restart with concurrent replies', () => {
  const t = temporaryDirectory();
  const path = join(t.path, 'state.sqlite');
  const db = openDb(path);
  migrate(db, [
    {
      module: 'inbox',
      version: 1,
      sql: `CREATE TABLE manager_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, manager TEXT NOT NULL, event TEXT NOT NULL,
    wakeable INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0, read_at INTEGER, acknowledged_at INTEGER
  ); CREATE INDEX manager_inbox_pending ON manager_inbox(manager, wakeable, read_at);`,
    },
  ]);
  db.query(
    'INSERT INTO manager_inbox(manager,event,wakeable,notified,read_at,acknowledged_at) VALUES(?,?,?,?,?,?)',
  ).run(
    'legacy-recipient',
    JSON.stringify({
      managerId: 'legacy-recipient',
      from: 'legacy-sender',
      kind: 'instruction',
      summary: 'Old instruction',
    }),
    1,
    1,
    10,
    20,
  );
  db.query('INSERT INTO manager_inbox(manager,event,wakeable) VALUES(?,?,?)').run(
    'legacy-recipient',
    JSON.stringify({ managerId: 'legacy-recipient', kind: 'goal-idle', summary: 'Old system event' }),
    1,
  );
  const first = new SqliteManagerInbox(db, t.path, () => 1_800_000_000_000);
  const shared = new SharedInboxQueries(db);
  try {
    const legacyPage = shared.log({ to: 'legacy-recipient' });
    const legacy = legacyPage.entries.find((entry) => entry.summary === 'Old instruction')!;
    expect(legacy.kind).toBe('instruction');
    expect(legacy.createdAt).toBeNull();
    expect(legacy.from).toBe('legacy-sender');
    expect(legacyPage.entries.find((entry) => entry.summary === 'Old system event')?.kind).toBe('goal-idle');
    expect(shared.log({ to: 'legacy-recipient', since: 1_700_000_000_000 }).entries).toEqual([]);

    first.deliver({
      managerId: 'manager-a',
      from: 'manager-b',
      kind: 'question',
      summary: 'Root question',
      goalId: 'goal-x',
      taskId: 'task-x',
    });
    const root = shared.log({ grep: 'Root question' }).entries[0]!;
    const secondDb = openDb(path);
    try {
      const one = new SqliteManagerInbox(db, t.path, () => 1_800_000_000_100);
      const two = new SqliteManagerInbox(secondDb, t.path, () => 1_800_000_000_101);
      one.deliver({
        managerId: 'manager-b',
        from: 'manager-a',
        kind: 'question',
        summary: 'Clarify root',
        replyToId: root.id,
      });
      two.deliver({
        managerId: 'manager-a',
        from: 'manager-b',
        kind: 'decision',
        summary: 'Decision reply',
        replyToId: root.id,
        documentRefs: [{ path: 'docs/root.md' }],
      });
      const thread = new SharedInboxQueries(secondDb).thread(root.id, { limit: 10 });
      expect(thread.entries.map((entry) => entry.summary)).toEqual(['Root question', 'Clarify root', 'Decision reply']);
      expect(thread.entries.map((entry) => entry.from)).toEqual(['manager-b', 'manager-a', 'manager-b']);
      expect(thread.entries.every((entry) => entry.threadRootId === root.id)).toBe(true);
      const firstPage = new SharedInboxQueries(secondDb).thread(root.id, { limit: 1 });
      expect(firstPage.entries.map((entry) => entry.summary)).toEqual(['Root question']);
      expect(firstPage.hasMore).toBe(true);
      const secondPage = new SharedInboxQueries(secondDb).thread(root.id, { limit: 1, cursor: firstPage.nextCursor! });
      expect(secondPage.entries.map((entry) => entry.summary)).toEqual(['Clarify root']);
      expect(new SharedInboxQueries(secondDb).thread('task-x').entries).toHaveLength(3);
      expect(
        db
          .query('SELECT read_at, acknowledged_at, notified FROM manager_inbox WHERE id = ? AND manager = ?')
          .get(legacy.id, 'legacy-recipient'),
      ).toEqual({ read_at: 10, acknowledged_at: 20, notified: 1 });
    } finally {
      secondDb.close();
    }
  } finally {
    db.close();
    t.close();
  }
});

test('reply insertion refuses a corrupt cyclic ancestry without adding a message', () => {
  const s = setup();
  try {
    s.inbox.deliver({ managerId: 'a', from: 'b', kind: 'instruction', summary: 'First' });
    s.inbox.deliver({ managerId: 'b', from: 'a', kind: 'goal-idle', summary: 'Second' });
    const ids = s.db.query('SELECT id FROM manager_inbox ORDER BY id').all() as { id: number }[];
    s.db.query('UPDATE manager_inbox SET reply_to_id = ? WHERE id = ?').run(ids[1]!.id, ids[0]!.id);
    s.db.query('UPDATE manager_inbox SET reply_to_id = ? WHERE id = ?').run(ids[0]!.id, ids[1]!.id);
    expect(() =>
      s.inbox.deliver({ managerId: 'a', from: 'b', kind: 'info', summary: 'Cannot link cycle', replyToId: ids[0]!.id }),
    ).toThrow('invalid or cyclic thread');
    expect(s.shared.log().entries).toHaveLength(2);
  } finally {
    s.close();
  }
});
