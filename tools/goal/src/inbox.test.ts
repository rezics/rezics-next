import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { temporaryDirectory } from './test-support.ts';

function setup() {
  const temporary = temporaryDirectory(); const db = openDb(join(temporary.path, 'state.sqlite'));
  return { ...temporary, db, inbox: new SqliteManagerInbox(db, temporary.path), close() { db.close(); temporary.close(); } };
}

test('wait blocks until a delivery, ignores other managers and records, then reads and acknowledges', async () => {
  const s = setup();
  try {
    let returned = false;
    const waiting = s.inbox.wait('manager').then(events => { returned = true; return events; });
    s.inbox.record('manager', { kind: 'merged' });
    s.inbox.deliver({ managerId: 'other', kind: 'instruction', summary: 'Other manager' });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(returned).toBe(false);
    const before = Date.now(); s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Make a decision' });
    const events = await Promise.race([waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Wait did not wake')), 1000))]);
    expect(Date.now() - before).toBeLessThan(500); expect(events).toHaveLength(1);
    expect(events[0]?.event.summary).toBe('Make a decision'); expect(s.inbox.pending('manager')).toHaveLength(0);
    expect(s.inbox.read('manager')).toHaveLength(1);
    s.inbox.acknowledge('other', [events[0]!.id]); expect(s.inbox.read('manager')).toHaveLength(1);
    s.inbox.acknowledge('manager', [events[0]!.id]); expect(s.inbox.read('manager')).toHaveLength(0);
  } finally { s.close(); }
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
    } finally { secondDb.close(); }
  } finally { s.close(); }
});

test('wait cancellation closes the watcher and never consumes future events', async () => {
  const s = setup();
  try {
    const controller = new AbortController(); const waiting = s.inbox.wait('manager', controller.signal);
    controller.abort(new Error('Stopped')); await expect(waiting).rejects.toThrow('Stopped');
    s.inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Later event' });
    expect(s.inbox.pending('manager')).toHaveLength(1);
  } finally { s.close(); }
});
