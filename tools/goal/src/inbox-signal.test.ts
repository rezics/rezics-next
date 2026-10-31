import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { temporaryDirectory } from './test-support.ts';

test('a deferred inbox hint survives state teardown without recreating state or escaping the delivery caller', async () => {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    db.transaction(() => {
      inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary: 'Original audit failure' });
      expect(existsSync(inbox.signalPath('supermanager'))).toBe(false);
    }).immediate();
    expect(inbox.pending('supermanager')).toHaveLength(1);
    db.close();
    temporary.close();
    await Promise.resolve();
    expect(existsSync(temporary.path)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
    db.close();
    temporary.close();
  }
});

test('a deferred inbox hint failure preserves its actual cause and the committed event exactly once', async () => {
  const temporary = temporaryDirectory();
  const path = join(temporary.path, 'state.sqlite');
  let db = openDb(path);
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    db.transaction(() => {
      inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary: 'Original audit failure' });
    }).immediate();
    // A directory at the exact hint path makes writeFileSync fail without touching the SQLite event.
    mkdirSync(inbox.signalPath('supermanager'));
    await Promise.resolve();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBe('manager inbox wakeup hint failed:');
    const error = errors.mock.calls[0]?.[1] as NodeJS.ErrnoException;
    expect(error.code).toBe('EISDIR');
    expect(error.path).toBe(inbox.signalPath('supermanager'));
    db.close();
    db = openDb(path);
    const reopened = new SqliteManagerInbox(db, temporary.path);
    const pending = reopened.pending('supermanager');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.event.summary).toBe('Original audit failure');
  } finally {
    errors.mockRestore();
    db.close();
    temporary.close();
  }
});
