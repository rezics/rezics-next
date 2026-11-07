import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ResidentWakeBridge, tmuxResidentSender } from './resident-wake.ts';

function fixture() {
  mkdirSync('.temp', { recursive: true });
  const dir = mkdtempSync(resolve('.temp/resident-wake-'));
  const db = openDb(join(dir, 'store.sqlite'));
  db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
    'supermanager',
    JSON.stringify({
      id: 'supermanager',
      kind: 'resident-supermanager',
      status: 'running',
      provider: 'codex',
      threadId: 'fixture-thread',
    }),
  );
  const inbox = new SqliteManagerInbox(db, dir);
  return {
    dir,
    db,
    inbox,
    cursor: join(dir, 'cursor.json'),
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('delivers acknowledged events once, coalesces alarms and excludes routine chatter without consuming inbox', () => {
  const f = fixture();
  try {
    for (const summary of [
      'Flow alarm: stage dispatch',
      'no allowed pool available',
      'hourly product output 193 lines',
    ])
      f.inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary });
    f.inbox.deliver({ managerId: 'supermanager', kind: 'info', from: 'worker:a/1', summary: 'Quiet progress' });
    f.inbox.deliver({
      managerId: 'supermanager',
      kind: 'environment',
      summary: 'Manager web renewed after using 240 tokens; new thread abc.',
    });
    f.inbox.read('supermanager');
    f.inbox.acknowledge('supermanager');
    const before = f.db.query('SELECT read_at, acknowledged_at, notified FROM manager_inbox').all();
    const prompts: string[] = [];
    const send = (_resident: unknown, prompt: string) => {
      prompts.push(prompt);
    };
    const bridge = new ResidentWakeBridge(f.db, 'supermanager', f.cursor, send);
    expect(bridge.flush()).toBe(3);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('3 new events (environment)');
    expect(prompts[0]).not.toContain('Quiet progress');
    expect(prompts[0]).not.toContain('renewed after');
    expect(bridge.flush()).toBe(0);
    expect(new ResidentWakeBridge(f.db, 'supermanager', f.cursor, send).flush()).toBe(0);
    expect(f.db.query('SELECT read_at, acknowledged_at, notified FROM manager_inbox').all()).toEqual(before);
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'New incident after acknowledgement' });
    expect(bridge.flush()).toBe(1);
    expect(prompts).toHaveLength(2);
  } finally {
    f.close();
  }
});

test('large batches produce a short wake and failed display checks never paste again, including after restart', () => {
  const f = fixture();
  try {
    const command = join(f.dir, 'tmux');
    const display = join(f.dir, 'display');
    const calls = join(f.dir, 'calls');
    const journal = join(f.dir, 'transport.json');
    writeFileSync(display, '');
    writeFileSync(command, `#!/usr/bin/env bash
base="\${0%/*}"
case "$3" in
  display-message) echo codex ;;
  capture-pane) cat "$base/display" ;;
  send-keys) printf '%s\\n' "$*" >> "$base/calls" ;;
esac
`, { mode: 0o700 });
    for (let index = 0; index < 30; index++)
      f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: `${index}: ${'long incident '.repeat(200)}` });
    const sender = () => tmuxResidentSender('fixture', 'fixture:0', command, journal);
    const bridge = () => new ResidentWakeBridge(f.db, 'supermanager', f.cursor, sender());
    const first = bridge();
    expect(() => first.flush()).toThrow('did not display delivery marker');
    expect(() => first.flush()).toThrow('did not display delivery marker');
    // A new event does not change the identity of the already staged batch.
    f.inbox.deliver({ managerId: 'supermanager', kind: 'question', summary: 'New decision' });
    const restarted = bridge();
    expect(() => restarted.flush()).toThrow('did not display delivery marker');
    const pasted = readFileSync(calls, 'utf8').trim().split('\n');
    expect(pasted).toHaveLength(1);
    expect(pasted[0]!.length).toBeLessThan(500);
    expect(pasted[0]).toContain('30 new events');
    writeFileSync(display, '[resident inbox 1]');
    expect(restarted.flush()).toBe(31);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(calls, 'utf8')).toContain('fixture:0 Enter');
    // A bridge checkpoint failure must not cause another Enter after restart either.
    sender()({ id: 'supermanager', provider: 'codex', threadId: 'fixture-thread' }, '[resident inbox 1] retry');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    f.close();
  }
});

test('failed transport retains pending IDs and retries after restart', () => {
  const f = fixture();
  try {
    f.inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary: 'hourly report' });
    const bridge = new ResidentWakeBridge(f.db, 'supermanager', f.cursor, () => {
      throw new Error('missing pane');
    });
    expect(() => bridge.flush()).toThrow('missing pane');
    expect(f.inbox.pending('supermanager')).toHaveLength(1);
    let delivered = 0;
    expect(
      new ResidentWakeBridge(f.db, 'supermanager', f.cursor, () => {
        delivered++;
      }).flush(),
    ).toBe(1);
    expect(delivered).toBe(1);
    expect(JSON.parse(readFileSync(f.cursor, 'utf8')).after).toBe(1);
    expect(f.inbox.pending('supermanager')).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('real tmux transport verifies and submits to an isolated resident fixture', () => {
  const f = fixture();
  // A private server and pane: never attach to the production resident socket.
  const socket = join(f.dir, 'tmux.sock');
  const tmux = (...args: string[]) => spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
  try {
    const executable = join(f.dir, 'codex');
    copyFileSync('/bin/cat', executable);
    expect(tmux('new-session', '-d', '-s', 'fixture', executable).status).toBe(0);
    Bun.sleepSync(100);
    f.inbox.deliver({
      managerId: 'supermanager',
      kind: 'environment',
      summary: 'Isolated transport proof: 193 product lines',
    });
    const bridge = new ResidentWakeBridge(f.db, 'supermanager', f.cursor, tmuxResidentSender(socket, 'fixture:0'));
    expect(bridge.flush()).toBe(1);
    Bun.sleepSync(100);
    const capture = tmux('capture-pane', '-p', '-t', 'fixture:0', '-S', '-100');
    expect(capture.status).toBe(0);
    expect(capture.stdout).toContain('[resident inbox 1]');
    expect(bridge.flush()).toBe(0);
    // A wrong/missing pane must fail without moving the persisted cursor.
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'Retain after missing pane' });
    const missing = new ResidentWakeBridge(f.db, 'supermanager', f.cursor, tmuxResidentSender(socket, 'absent:0'));
    expect(() => missing.flush()).toThrow('Resident pane absent:0');
    expect(JSON.parse(readFileSync(f.cursor, 'utf8')).after).toBe(1);
  } finally {
    tmux('kill-server');
    f.close();
  }
});
