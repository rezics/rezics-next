#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { SqliteManagerInbox, residentInboxCursor } from '../src/inbox.ts';
import { openDb } from '../src/db.ts';
import {
  CodexResidentActivity,
  ResidentWakeBridge,
  residentIdentity,
  tmuxResidentSender,
} from '../src/resident-wake.ts';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    manager: { type: 'string', default: 'supermanager' },
    cursor: { type: 'string' },
    'tmux-socket': { type: 'string' },
    pane: { type: 'string' },
    'tmux-command': { type: 'string', default: 'tmux' },
    'start-after': { type: 'string' },
    transcript: { type: 'string' },
    emit: { type: 'boolean' },
    summary: { type: 'string' },
    source: { type: 'string', default: 'operator' },
    once: { type: 'boolean' },
  },
});
if (!values.db) throw new Error('--db is required');
if (values.emit) {
  if (!values.summary?.trim()) throw new Error('--emit requires --summary');
  const db = openDb(values.db);
  try {
    residentIdentity(db, values.manager);
    new SqliteManagerInbox(db, dirname(values.db)).deliver({
      managerId: values.manager,
      kind: 'environment',
      from: `system:${values.source}`,
      summary: values.summary,
    });
  } finally {
    db.close();
  }
} else {
  if (!values['tmux-socket'] || !values.pane) throw new Error('--tmux-socket and --pane are required');
  if (!values.transcript) throw new Error('--transcript is required for explicit resident activity');
  const startAfter = values['start-after'] === undefined ? undefined : Number(values['start-after']);
  if (startAfter !== undefined && (!Number.isSafeInteger(startAfter) || startAfter < 0))
    throw new Error('--start-after must be a nonnegative event id');
  const db = new Database(values.db, { readonly: true, strict: true });
  db.exec('PRAGMA busy_timeout = 5000');
  const cursor = values.cursor ?? join(dirname(values.db), 'watch', 'supermanager-delivery.json');
  const activity = new CodexResidentActivity(values.transcript);
  const bridge = new ResidentWakeBridge(
    db,
    values.manager,
    cursor,
    tmuxResidentSender(values['tmux-socket'], values.pane, values['tmux-command'], `${cursor}.transport.json`, () =>
      residentInboxCursor(db, values.manager),
    ),
    startAfter,
    (resident) => activity.read(resident),
  );
  let stopped = false;
  process.once('SIGTERM', () => {
    stopped = true;
  });
  process.once('SIGINT', () => {
    stopped = true;
  });
  let lastError: string | undefined;
  try {
    do {
      try {
        const count = bridge.flush();
        if (count) console.log(`${new Date().toISOString()} notified resident of ${count} unread events`);
        if (lastError) console.log(`${new Date().toISOString()} resident delivery recovered`);
        lastError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) console.error(`${new Date().toISOString()} resident delivery pending: ${message}`);
        lastError = message;
        if (values.once) process.exitCode = 1;
      }
      // One token-free coalescing/retry loop; no inbox event means no model wake.
      if (!values.once && !stopped) await Bun.sleep(2000);
    } while (!values.once && !stopped);
  } finally {
    db.close();
  }
}
