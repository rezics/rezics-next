import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, copyFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from './db.ts';
import { SqliteManagerInbox, residentInboxCursor } from './inbox.ts';
import { SharedInboxQueries } from './inbox-shared.ts';
import { runInboxCommand } from './inbox-cli.ts';
import {
  CodexResidentActivity,
  ResidentWakeBridge,
  tmuxResidentSender,
  type ResidentIdentity,
} from './resident-wake.ts';

const resident: ResidentIdentity = { id: 'supermanager', provider: 'codex', threadId: 'fixture-thread' };
function fixture() {
  mkdirSync('.temp', { recursive: true });
  const dir = mkdtempSync(resolve('.temp/rw-'));
  const db = openDb(join(dir, 'store.sqlite'));
  db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
    'supermanager',
    JSON.stringify({
      ...resident,
      kind: 'resident-supermanager',
      status: 'running',
    }),
  );
  let now = 100_000;
  const inbox = new SqliteManagerInbox(db, dir, () => now);
  const prompts: string[] = [];
  const cursor = join(dir, 'cursor.json');
  const idle = () => ({ state: 'idle' as const, since: 0 });
  const bridge = (
    send = (_resident: ResidentIdentity, prompt: string) => {
      prompts.push(prompt);
    },
    activity = idle,
    canStartTurn = () => true,
  ) => new ResidentWakeBridge(db, 'supermanager', cursor, send, 0, activity, () => now, canStartTurn);
  return {
    dir,
    db,
    inbox,
    cursor,
    prompts,
    bridge,
    age(ms = 60_000) {
      now += ms;
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('foreign reads and acknowledgements preserve full owner mail; one wake coalesces until personal consumption', () => {
  const f = fixture();
  try {
    const longBody = 'Full incident detail '.repeat(2000);
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: longBody });
    f.inbox.deliver({ managerId: 'supermanager', kind: 'question', summary: 'Choose ownership' });
    f.inbox.deliver({ managerId: 'supermanager', kind: 'info', from: 'worker:a/1', summary: 'Quiet progress' });
    f.inbox.deliver({
      managerId: 'supermanager',
      kind: 'environment',
      summary: 'Manager web renewed after using 240 tokens; new thread abc.',
    });
    f.inbox.read('supermanager');
    f.inbox.acknowledge('supermanager');
    new SharedInboxQueries(f.db).log({ to: 'supermanager' });
    expect(residentInboxCursor(f.db, 'supermanager')).toBeUndefined();
    expect(f.bridge().flush()).toBe(0);
    f.age();
    expect(f.bridge().flush()).toBe(2);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.length).toBeLessThan(200);
    expect(f.prompts[0]).not.toContain('incident detail');
    expect(residentInboxCursor(f.db, 'supermanager')).toBeUndefined();
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'New while unread' });
    f.age();
    expect(f.bridge().flush()).toBe(0);
    const page = f.inbox.readResidentPage('supermanager', 'fixture-thread', { limit: 1 });
    expect(page.entries[0]!.event.summary).toBe(longBody);
    expect(page.hasMore).toBe(true);
    expect(residentInboxCursor(f.db, 'supermanager')).toBe(1);
    // Cursor arguments after bootstrap cannot skip the owner's remaining page.
    const next = f.inbox.readResidentPage('supermanager', 'fixture-thread', { limit: 1, cursor: 999 });
    expect(next.entries[0]!.id).toBe(2);
    expect(f.bridge().flush()).toBe(1);
    f.inbox.readResidentPage('supermanager', 'fixture-thread');
    expect(f.bridge().flush()).toBe(0);
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'Next unread period' });
    f.age();
    expect(f.bridge().flush()).toBe(1);
    expect(f.prompts).toHaveLength(3);
    expect(f.db.query('SELECT provider, session_id FROM manager_inbox_resident_cursor').get()).toEqual({
      provider: 'codex',
      session_id: 'fixture-thread',
    });
  } finally {
    f.close();
  }
});

test('an allowance hold keeps all mail unread and coalesces one wake when admission resumes', () => {
  const f = fixture();
  try {
    let allowed = false;
    const bridge = f.bridge(undefined, undefined, () => allowed);
    for (const summary of ['First question', 'Second question'])
      f.inbox.deliver({ managerId: 'supermanager', kind: 'question', summary });
    f.age();
    expect(bridge.flush()).toBe(0);
    expect(f.prompts).toHaveLength(0);
    expect(residentInboxCursor(f.db, 'supermanager')).toBeUndefined();
    allowed = true;
    expect(bridge.flush()).toBe(2);
    expect(bridge.flush()).toBe(0);
    expect(f.prompts).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('owner page progress rearms one idle notification for the remaining unread page across restart', () => {
  const f = fixture();
  try {
    for (const summary of ['First page', 'Second page'])
      f.inbox.deliver({ managerId: 'supermanager', kind: 'question', summary });
    f.age();
    expect(f.bridge().flush()).toBe(2);
    expect(f.prompts).toHaveLength(1);
    expect(f.inbox.readResidentPage('supermanager', 'fixture-thread', { limit: 1 }).entries[0]!.id).toBe(1);
    expect(f.bridge().flush()).toBe(1);
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain('[resident inbox 2]');
    expect(f.bridge().flush()).toBe(0);
    expect(f.prompts).toHaveLength(2);
  } finally {
    f.close();
  }
});

test('a bounded owner read suppresses exactly its consumed mail and bootstrap is explicit', () => {
  const f = fixture();
  try {
    for (const summary of ['Already consumed', 'Read this page', 'Still unread'])
      f.inbox.deliver({ managerId: 'supermanager', kind: 'question', summary });
    const page = f.inbox.readResidentPage('supermanager', 'fixture-thread', { cursor: 1, limit: 1 });
    expect(page.entries.map((entry) => entry.id)).toEqual([2]);
    expect(page.nextCursor).toBe(2);
    f.age();
    expect(f.bridge().flush()).toBe(1);
    expect(f.prompts[0]).toContain('[resident inbox 3]');
    f.inbox.readResidentPage('supermanager', 'fixture-thread', { cursor: 999 });
    expect(f.bridge().flush()).toBe(0);
    expect(f.inbox.readResidentPage('supermanager', 'fixture-thread').entries).toEqual([]);
  } finally {
    f.close();
  }
});

test('public CLI authenticates personal consumption; a foreign read and shared log never advance it', async () => {
  const f = fixture();
  const oldEnv = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    GOAL_MANAGER: process.env.GOAL_MANAGER,
    GOAL_TASK_ID: process.env.GOAL_TASK_ID,
    GOAL_ATTEMPT: process.env.GOAL_ATTEMPT,
  };
  const oldLog = console.log;
  const pages: unknown[] = [];
  try {
    f.db
      .query('INSERT INTO manager_sessions VALUES (?, ?)')
      .run('peer', JSON.stringify({ id: 'peer', kind: 'managed', status: 'running', threadId: 'peer-thread' }));
    for (const summary of ['First full event', 'Second full event'])
      f.inbox.deliver({ managerId: 'supermanager', kind: 'question', summary });
    for (const key of Object.keys(oldEnv)) delete process.env[key];
    process.env.CODEX_THREAD_ID = 'peer-thread';
    console.log = (value: string) => pages.push(JSON.parse(value));
    const runtime = {
      db: f.db,
      inbox: f.inbox,
      stateDirectory: f.dir,
      fence: {
        assertCurrent() {},
        commitMerge(_ref: unknown, merge: () => string) {
          return merge();
        },
      },
      managerServices: {},
    };
    const host = { async requestHost() {}, async ensureHost() {} };
    await runInboxCommand(['inbox', 'read', 'supermanager'], runtime, host);
    await runInboxCommand(['inbox', 'ack', 'supermanager'], runtime, host);
    expect(residentInboxCursor(f.db, 'supermanager')).toBeUndefined();
    process.env.CODEX_THREAD_ID = 'fixture-thread';
    await runInboxCommand(['inbox', 'log', '--to', 'supermanager', '--json'], runtime, host);
    expect(residentInboxCursor(f.db, 'supermanager')).toBeUndefined();
    await runInboxCommand(['inbox', 'read', 'supermanager', '--limit', '1'], runtime, host);
    expect((pages.at(-1) as { entries: { id: number }[] }).entries.map((entry) => entry.id)).toEqual([1]);
    expect(residentInboxCursor(f.db, 'supermanager')).toBe(1);
  } finally {
    console.log = oldLog;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    f.close();
  }
});

function transcriptEvent(type: string, turn: string, at: number) {
  return (
    JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, turn_id: turn } }) +
    '\n'
  );
}

test('actual turn lifecycle survives long silent tools and ignores late old-turn completions', () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'transcript.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-thread' } }) +
        '\n' +
        transcriptEvent('task_started', 'old', 10),
    );
    const activity = new CodexResidentActivity(path);
    const bridge = () =>
      new ResidentWakeBridge(
        f.db,
        'supermanager',
        f.cursor,
        (_r, prompt) => {
          f.prompts.push(prompt);
        },
        0,
        (r) => activity.read(r),
        () => 1_000_000,
      );
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'Aged mail' });
    expect(activity.read(resident).state).toBe('busy');
    expect(bridge().flush()).toBe(0); // many quiet minutes do not imply idle
    appendFileSync(
      path,
      transcriptEvent('task_complete', 'old', 20) +
        transcriptEvent('task_started', 'new', 30) +
        transcriptEvent('item_completed', 'old', 40) +
        transcriptEvent('task_complete', 'old', 50),
    );
    expect(activity.read(resident)).toEqual({ state: 'busy', since: 30 });
    expect(bridge().flush()).toBe(0);
    appendFileSync(path, transcriptEvent('task_complete', 'new', 995_000));
    expect(bridge().flush()).toBe(0); // idle grace
    appendFileSync(path, transcriptEvent('task_started', 'third', 60) + transcriptEvent('turn_aborted', 'third', 70));
    expect(bridge().flush()).toBe(1);
    expect(bridge().flush()).toBe(0);
    expect(f.prompts).toHaveLength(1);
    const nextStart = transcriptEvent('task_started', 'next', 80);
    appendFileSync(path, nextStart.slice(0, -4));
    expect(activity.read(resident).state).toBe('unknown');
    appendFileSync(path, nextStart.slice(-4));
    expect(activity.read(resident)).toEqual({ state: 'busy', since: 80 });
    expect(activity.read({ ...resident, provider: 'claude' }).state).toBe('unknown');
    expect(() => activity.read({ ...resident, threadId: 'another-thread' })).toThrow('does not match');
    // A replacement/truncated file must not inherit an earlier idle state.
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-thread' } }) + '\n');
    expect(activity.read(resident).state).toBe('unknown');
  } finally {
    f.close();
  }
});

test('failed display retries and watcher restarts never paste the staged short wake again', () => {
  const f = fixture();
  try {
    const command = join(f.dir, 'tmux');
    const display = join(f.dir, 'display');
    const calls = join(f.dir, 'calls');
    const journal = join(f.dir, 'transport.json');
    writeFileSync(display, '');
    writeFileSync(
      command,
      `#!/usr/bin/env bash
base="\${0%/*}"
case "$3" in
  display-message) echo codex ;;
  capture-pane) cat "$base/display" ;;
  send-keys) printf '%s\\n' "$*" >> "$base/calls" ;;
esac
`,
      { mode: 0o700 },
    );
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'Long body '.repeat(4000) });
    f.age();
    const sender = () => tmuxResidentSender('fixture', 'fixture:0', command, journal);
    expect(() => f.bridge(sender()).flush()).toThrow('did not display delivery marker');
    expect(() => f.bridge(sender()).flush()).toThrow('did not display delivery marker');
    f.inbox.deliver({ managerId: 'supermanager', kind: 'question', summary: 'New decision' });
    expect(() => f.bridge(sender()).flush()).toThrow('did not display delivery marker');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    writeFileSync(display, '[resident inbox 1]');
    expect(f.bridge(sender()).flush()).toBe(2);
    expect(f.bridge(sender()).flush()).toBe(0);
    sender()(resident, '[resident inbox 1] retry');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(calls, 'utf8').length).toBeLessThan(400);
    // A pre-upgrade staged draft may have been cleared by the operator. Only a genuine owner read retires it.
    writeFileSync(
      journal,
      JSON.stringify({ threadId: 'fixture-thread', marker: '[resident inbox 1]', submitted: false }),
    );
    const migratedSender = () =>
      tmuxResidentSender('fixture', 'fixture:0', command, journal, () => residentInboxCursor(f.db, 'supermanager'));
    expect(() => migratedSender()(resident, '[resident inbox 3] next')).toThrow('still has an unconfirmed delivery');
    f.inbox.readResidentPage('supermanager', 'fixture-thread');
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'Next generation after real consumption' });
    f.age();
    writeFileSync(display, '[resident inbox 3]');
    expect(f.bridge(migratedSender()).flush()).toBe(1);
    expect(f.bridge(migratedSender()).flush()).toBe(0);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(4);
  } finally {
    f.close();
  }
});

test('real tmux transport verifies and submits to a private resident fixture', () => {
  const f = fixture();
  const socket = join(f.dir, 'tmux.sock');
  const tmux = (...args: string[]) => spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
  try {
    const executable = join(f.dir, 'codex');
    copyFileSync('/bin/cat', executable);
    expect(tmux('new-session', '-d', '-s', 'fixture', executable).status).toBe(0);
    Bun.sleepSync(100);
    f.inbox.deliver({ managerId: 'supermanager', kind: 'environment', summary: 'Full body stays native '.repeat(200) });
    f.age();
    const send = tmuxResidentSender(socket, 'fixture:0', 'tmux', join(f.dir, 'transport.json'));
    expect(f.bridge(send).flush()).toBe(1);
    Bun.sleepSync(100);
    const capture = tmux('capture-pane', '-p', '-t', 'fixture:0', '-S', '-100');
    expect(capture.status).toBe(0);
    expect(capture.stdout).toContain('[resident inbox 1]');
    expect(capture.stdout).not.toContain('Full body');
    expect(f.bridge(send).flush()).toBe(0);
    f.inbox.readResidentPage('supermanager', 'fixture-thread');
    f.inbox.deliver({ managerId: 'supermanager', kind: 'blocker', summary: 'Retain after missing pane' });
    f.age();
    expect(() => f.bridge(tmuxResidentSender(socket, 'absent:0')).flush()).toThrow('Resident pane absent:0');
    expect(residentInboxCursor(f.db, 'supermanager')).toBe(1);
  } finally {
    tmux('kill-server');
    f.close();
  }
});
