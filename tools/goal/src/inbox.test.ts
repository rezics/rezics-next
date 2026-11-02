import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox, quietDelivery } from './inbox.ts';
import { temporaryDirectory } from './test-support.ts';

function setup() {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  return {
    ...temporary,
    db,
    inbox: new SqliteManagerInbox(db, temporary.path),
    close() {
      db.close();
      temporary.close();
    },
  };
}

test('wait blocks until a delivery, ignores other managers and records, then reads and acknowledges', async () => {
  const s = setup();
  try {
    let returned = false;
    const waiting = s.inbox.wait('manager').then((events) => {
      returned = true;
      return events;
    });
    s.inbox.record('manager', { kind: 'merged' });
    s.inbox.deliver({ managerId: 'other', kind: 'instruction', summary: 'Other manager' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(returned).toBe(false);
    const before = Date.now();
    s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Make a decision' });
    const events = await Promise.race([
      waiting,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Wait did not wake')), 1000)),
    ]);
    expect(Date.now() - before).toBeLessThan(500);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.summary).toBe('Make a decision');
    expect(s.inbox.pending('manager')).toHaveLength(0);
    expect(s.inbox.read('manager')).toHaveLength(1);
    s.inbox.acknowledge('other', [events[0]!.id]);
    expect(s.inbox.read('manager')).toHaveLength(1);
    s.inbox.acknowledge('manager', [events[0]!.id]);
    expect(s.inbox.read('manager')).toHaveLength(0);
  } finally {
    s.close();
  }
});

test('a delivery committed before subscribing is returned immediately and remains durable across connections', async () => {
  const s = setup();
  try {
    s.inbox.deliver({ managerId: 'manager', kind: 'goal-unmet', summary: 'Check evidence' });
    const secondDb = openDb(join(s.path, 'state.sqlite'));
    try {
      const second = new SqliteManagerInbox(secondDb, s.path);
      expect((await second.wait('manager'))[0]?.event.kind).toBe('goal-unmet');
      expect(s.inbox.pending('manager')).toHaveLength(0);
    } finally {
      secondDb.close();
    }
  } finally {
    s.close();
  }
});

test('wait cancellation closes the watcher and never consumes future events', async () => {
  const s = setup();
  try {
    const controller = new AbortController();
    const waiting = s.inbox.wait('manager', controller.signal);
    controller.abort(new Error('Stopped'));
    await expect(waiting).rejects.toThrow('Stopped');
    s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Later event' });
    expect(s.inbox.pending('manager')).toHaveLength(1);
  } finally {
    s.close();
  }
});

test('delivery inside a shared write transaction signals only after commit', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  try {
    const { existsSync } = await import('node:fs');
    db.transaction(() => {
      inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'A committed decision' });
      expect(existsSync(inbox.signalPath('manager'))).toBe(false);
    }).immediate();
    await Promise.resolve();
    expect(existsSync(inbox.signalPath('manager'))).toBe(true);
    expect(inbox.pending('manager')).toHaveLength(1);
  } finally {
    db.close();
    t.close();
  }
});

test('wait with a settle window returns a burst of events at once, after the window', async () => {
  const s = setup();
  try {
    const waiting = s.inbox.wait('manager', undefined, 150);
    const before = Date.now();
    s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Second' });
    const events = await waiting;
    expect(Date.now() - before).toBeGreaterThanOrEqual(140);
    expect(events.map((event) => event.event.summary)).toEqual(['First', 'Second']);
  } finally {
    s.close();
  }
});

test('width is a durable wakeable system event that is delivered only to its manager', async () => {
  const s = setup();
  try {
    s.inbox.deliver({
      managerId: 'goal-manager',
      kind: 'width',
      summary: 'Width is low; recover, reshape, or dispatch real work.',
    });
    expect(s.inbox.pending('goal-manager')).toHaveLength(1);
    expect(s.inbox.pending('other-manager')).toHaveLength(0);

    const reopenedDb = openDb(join(s.path, 'state.sqlite'));
    try {
      const reopened = new SqliteManagerInbox(reopenedDb, s.path);
      const events = await reopened.wait('goal-manager');
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toMatchObject({ managerId: 'goal-manager', kind: 'width' });
      expect(reopened.pending('goal-manager')).toHaveLength(0);
      expect(reopened.read('goal-manager')).toHaveLength(1);
    } finally {
      reopenedDb.close();
    }
  } finally {
    s.close();
  }
});

test('identical deliveries to one recipient within an hour fold into one row with a count and wake once', () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  let now = Date.UTC(2026, 10, 2, 12);
  const inbox = new SqliteManagerInbox(db, t.path, () => now);
  try {
    const alarm = { managerId: 'control-plane', kind: 'environment' as const, summary: 'x is not a working tree' };
    inbox.deliver(alarm);
    for (const entry of inbox.notifications('control-plane')) inbox.notified(entry.id);
    for (let minute = 1; minute <= 59; minute++) {
      now += 60_000 - 1;
      inbox.deliver(alarm);
    }
    expect(inbox.notifications('control-plane')).toHaveLength(0);
    expect(inbox.pending('control-plane')).toMatchObject([{ event: alarm, deliveries: 60 }]);
    // Another recipient, another task or another first line is a different delivery.
    inbox.deliver({ ...alarm, managerId: 'supermanager' });
    inbox.deliver({ ...alarm, taskId: 'task-1' });
    inbox.deliver({ ...alarm, summary: 'y is not a working tree' });
    expect(inbox.pending('control-plane')).toHaveLength(3);
    expect(inbox.pending('supermanager')).toHaveLength(1);
    // A record is never folded; after the hour the same line is delivered again.
    inbox.record('control-plane', { kind: 'merged' });
    inbox.record('control-plane', { kind: 'merged' });
    expect((db.query('SELECT count(*) AS n FROM manager_inbox WHERE wakeable = 0').get() as { n: number }).n).toBe(2);
    now = Date.UTC(2026, 10, 2, 13, 0, 0, 1);
    inbox.deliver(alarm);
    expect(inbox.pending('control-plane')).toHaveLength(4);
    expect(inbox.notifications('control-plane').map((entry) => entry.event.summary)).toContain(alarm.summary);
  } finally {
    db.close();
    t.close();
  }
});

test('manager sends are capped at six an hour and 600 characters, except the continuation handshake', () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  let now = Date.UTC(2026, 10, 2, 12);
  const inbox = new SqliteManagerInbox(db, t.path, () => now);
  try {
    const send = (summary: string) => {
      inbox.assertManagerSend('web', summary);
      inbox.deliver({ managerId: 'search', kind: 'decision', summary, from: 'web' });
    };
    expect(() => inbox.assertManagerSend('web', 'x'.repeat(601))).toThrow(/601 characters.*at most 600/);
    for (let index = 1; index <= 6; index++) {
      send(`Decision ${index}`);
      now += 60_000;
    }
    expect(() => send('Decision 7')).toThrow(/web has sent 6 messages in the last hour and the limit is 6/);
    expect(() => send('continuation written')).not.toThrow();
    // System alarms carry no sender and are never capped.
    for (let index = 0; index < 10; index++)
      inbox.deliver({ managerId: 'web', kind: 'environment', summary: `Alarm ${index}` });
    expect(inbox.pending('web')).toHaveLength(10);
    now = Date.UTC(2026, 10, 2, 13, 0, 0, 1);
    expect(() => send('Decision 8')).not.toThrow();
  } finally {
    db.close();
    t.close();
  }
});

test('a worker info message is read at the next wake but never wakes the manager; worker questions still wake', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const { existsSync } = await import('node:fs');
  try {
    const from = 'worker:task-1/2';
    expect(quietDelivery({ kind: 'info', from })).toBe(true);
    expect(quietDelivery({ kind: 'info', from: 'search' })).toBe(false);
    expect(quietDelivery({ kind: 'question', from })).toBe(false);
    inbox.deliver({ managerId: 'web', kind: 'info', from, taskId: 'task-1', summary: 'Chose cursor pagination' });
    expect(existsSync(inbox.signalPath('web'))).toBe(false);
    expect(inbox.pending('web')).toHaveLength(0);
    expect(inbox.notifications('web')).toHaveLength(0);
    let woken = false;
    const waiting = inbox.wait('web').then((events) => {
      woken = true;
      return events;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(woken).toBe(false);
    inbox.deliver({ managerId: 'web', kind: 'question', from, taskId: 'task-1', summary: 'Which owner decides?' });
    expect(existsSync(inbox.signalPath('web'))).toBe(true);
    expect(inbox.notifications('web').map((entry) => entry.event.kind)).toEqual(['question']);
    // The wake reads both: the quiet decision travels with the next real event.
    expect((await waiting).map((entry) => entry.event.summary)).toEqual([
      'Chose cursor pagination',
      'Which owner decides?',
    ]);
  } finally {
    db.close();
    t.close();
  }
});

test('inbox read pages unacknowledged events, marks only the page read, and continues without dropping later work', () => {
  const s = setup();
  try {
    for (let n = 1; n <= 5; n++)
      s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: `Event ${n}` });
    expect(() => s.inbox.readPage('manager', { limit: 0 })).toThrow(/between 1 and 100/);
    expect(() => s.inbox.readPage('manager', { limit: 101 })).toThrow(/between 1 and 100/);
    const first = s.inbox.readPage('manager', { limit: 2 });
    expect(first.entries.map((entry) => entry.event.summary)).toEqual(['Event 1', 'Event 2']);
    expect(first).toMatchObject({ limit: 2, hasMore: true });
    expect(first.nextCursor).toBe(first.entries[1]!.id);
    expect(s.inbox.pending('manager').map((entry) => entry.event.summary)).toEqual(['Event 3', 'Event 4', 'Event 5']);
    expect(s.inbox.readPage('manager', { limit: 2 }).entries.map((entry) => entry.event.summary)).toEqual([
      'Event 1',
      'Event 2',
    ]);
    s.inbox.deliver({ managerId: 'manager', kind: 'decision', summary: 'Late' });
    const second = s.inbox.readPage('manager', { limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((entry) => entry.event.summary)).toEqual(['Event 3', 'Event 4']);
    s.inbox.acknowledge('manager', first.entries.map((entry) => entry.id));
    expect(s.inbox.read('manager', { limit: 2 }).map((entry) => entry.event.summary)).toEqual(['Event 3', 'Event 4']);
    s.inbox.acknowledge('manager');
    const rest = s.inbox.readPage('manager');
    expect(rest.entries.map((entry) => entry.event.summary)).toEqual(['Event 5', 'Late']);
    expect(rest).toMatchObject({ limit: 50, hasMore: false, nextCursor: null });
    expect(s.inbox.pending('manager')).toHaveLength(0);
  } finally {
    s.close();
  }
});

test('wait returns one bounded page and a later wait still exposes remaining unread events', async () => {
  const s = setup();
  try {
    for (let n = 1; n <= 51; n++)
      s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: `Event ${n}` });
    const first = await s.inbox.wait('manager');
    expect(first.map((entry) => entry.event.summary)).toEqual(
      Array.from({ length: 50 }, (_, index) => `Event ${index + 1}`),
    );
    expect(s.inbox.pending('manager').map((entry) => entry.event.summary)).toEqual(['Event 51']);
    const second = await s.inbox.wait('manager');
    expect(second.map((entry) => entry.event.summary)).toEqual(['Event 51']);
    expect(s.inbox.pending('manager')).toHaveLength(0);
  } finally {
    s.close();
  }
});

test('a multi-line summary is delivered folded onto one line', () => {
  const s = setup();
  try {
    s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Worker result:\n  first part\r\nsecond part' });
    expect(s.inbox.pending('manager')).toMatchObject([
      { event: { summary: 'Worker result: first part second part' } },
    ]);
  } finally {
    s.close();
  }
});
