import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StdioAppServer, type Notification } from './app-server.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { temporaryDirectory } from './test-support.ts';

async function setup() {
  const temporary = temporaryDirectory(); const db = openDb(join(temporary.path, 'state.sqlite'));
  const log = join(temporary.path, 'rpc.jsonl');
  const client = new StdioAppServer([process.execPath, join(import.meta.dir, 'fixtures/fake-app-server.ts')],
    { ...process.env, FAKE_RPC_LOG: log });
  await client.initialize();
  const inbox = new SqliteManagerInbox(db, temporary.path);
  const windows: { manager: string; argv: string[] }[] = [];
  const removed: string[] = []; const errors: unknown[] = [];
  let connections = 0; let passing = false; let now = Date.now();
  const services = {
    connect: async () => { connections++; return client; },
    windows: { register(manager: string, argv: string[]) { windows.push({ manager, argv }); return '@1'; },
      unregister(manager: string) { removed.push(manager); } },
    checkCompletion: async () => ({ passed: passing, evidencePath: join(temporary.path, 'completion.log'), summary: 'Some tasks remain unmerged' }),
    command: ['goal'], now: () => now, onError: (error: unknown) => { errors.push(error); },
  };
  const managers = new ManagerSessions(db, inbox, services);
  const spec: ManagerSpec = { id: 'manager', goal: 'refactor', objective: 'Finish the refactor', brief: 'Manage this scope', cwd: temporary.path,
    engine: 'codex', pool: { id: 'sol', codexHome: join(temporary.path, 'codex-home') }, budget: 40000, effort: 'high', supermanager: 'supervisor',
    limits: { turns: 20, turnsWithoutDecision: 10, wallMs: 3_600_000 } };
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const notify = async (notification: Notification) => { await client.request('test/notify', notification); await managers.flush(); };
  return { ...temporary, db, client, inbox, managers, windows, removed, errors, services, spec, requests, notify,
    get connections() { return connections; }, pass() { passing = true; }, advance(ms: number) { now += ms; },
    async close() { await managers.close(); db.close(); temporary.close(); } };
}

test('manager startup follows installed protocol and two managers share one app-server per pool', async () => {
  const s = await setup();
  try {
    const first = await s.managers.start(s.spec); await s.managers.flush();
    const requests = s.requests().filter(r => r.id && r.method !== 'initialize');
    expect(requests.slice(0, 3).map(r => r.method)).toEqual(['thread/start', 'thread/goal/set', 'turn/start']);
    expect(requests[0].params).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access', cwd: s.path, model: 'gpt-6.1-sol',
      config: { model_reasoning_effort: 'high', model_auto_compact_token_limit: 300000 } });
    expect(requests[1].params.tokenBudget).toBe(40000); expect(requests[1].params.status).toBe('active');
    expect(first.threadId).toBe('thread-1'); expect(first.activeTurnId).toBe('turn-1');
    expect(s.managers.get(s.spec.id).turns).toBe(1);
    await s.managers.start({ ...s.spec, id: 'second' });
    expect(s.connections).toBe(1);
    expect(s.windows[0]?.argv).toContain('resume'); expect(s.windows[0]?.argv).toContain('--dangerously-bypass-approvals-and-sandbox'); expect(s.windows[0]?.argv).toContain('thread-1');
  } finally { await s.close(); }
});

test('delivery steers an active turn with expectedTurnId and starts an idle turn', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec); await s.managers.flush();
    s.inbox.deliver({ managerId: s.spec.id, kind: 'instruction', summary: 'Resolve the conflict' });
    await s.managers.wake(s.spec.id);
    const steer = s.requests().find(r => r.method === 'turn/steer');
    expect(steer.params.expectedTurnId).toBe(manager.activeTurnId);
    expect(steer.params.input).toEqual([{ type: 'text', text: 'Resolve the conflict', text_elements: [] }]);
    await s.notify({ method: 'turn/completed', params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } } });
    expect(s.managers.get(s.spec.id).activeTurnId).toBeNull();
    s.inbox.deliver({ managerId: s.spec.id, kind: 'spec-conflict', summary: 'Choose a contract' });
    await s.managers.wake(s.spec.id);
    expect(s.requests().filter(r => r.method === 'turn/start')).toHaveLength(2);
    expect(s.managers.get(s.spec.id).activeTurnId).toBe('turn-2');
    expect(s.inbox.notifications(s.spec.id)).toHaveLength(0);
  } finally { await s.close(); }
});

test('a steer racing a completed turn rejoins and starts a turn without losing the event', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec); await s.managers.flush();
    // The server finishes just before delivery, while the persisted manager still names that turn.
    await s.client.request('turn/interrupt', { threadId: manager.threadId, turnId: manager.activeTurnId });
    // Force an old active-turn observation, as with an event arriving before its completion notification.
    s.db.query('UPDATE manager_sessions SET state = ? WHERE id = ?').run(JSON.stringify(manager), manager.id);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake after the race' });
    await s.managers.wake(manager.id); await s.managers.flush();
    expect(s.inbox.notifications(manager.id)).toHaveLength(0);
    expect(s.managers.get(manager.id).activeTurnId).toBe('turn-2');
  } finally { await s.close(); }
});

test('recorded-only outcomes never wake a manager and notifications track goal usage', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec); await s.managers.flush();
    for (const kind of ['gate-passed', 'merged', 'environment-rerun', 'automatic-consultation']) s.inbox.record(manager.id, { kind });
    await s.managers.wake(manager.id);
    expect(s.requests().filter(r => r.method === 'turn/steer')).toHaveLength(0);
    await s.notify({ method: 'thread/goal/updated', params: { threadId: manager.threadId, goal: { status: 'active', tokensUsed: 200, timeUsedSeconds: 2, tokenBudget: 40000 } } });
    await s.notify({ method: 'thread/tokenUsage/updated', params: { threadId: manager.threadId, tokenUsage: { total: { totalTokens: 1000, cachedInputTokens: 800 } } } });
    expect(s.managers.get(manager.id).goalState?.tokensUsed).toBe(200);
    expect(s.managers.get(manager.id).usage).toEqual({ total: { totalTokens: 1000, cachedInputTokens: 800 } });
  } finally { await s.close(); }
});

test('limits count turns and decisions, pause the manager and notify the supermanager', async () => {
  for (const reason of ['turns', 'no-decision', 'wall']) {
    const s = await setup();
    try {
      const spec = { ...s.spec, limits: { turns: 1, turnsWithoutDecision: 1, wallMs: 3_600_000 } };
      if (reason === 'no-decision') spec.limits.turns = 10;
      const state = await s.managers.start(spec); await s.managers.flush();
      if (reason === 'wall') s.advance(spec.limits.wallMs + 1);
      await s.notify({ method: 'turn/completed', params: { threadId: state.threadId, turn: { id: state.activeTurnId, status: 'completed' } } });
      if (reason !== 'wall') {
        await s.notify({ method: 'turn/started', params: { threadId: state.threadId, turn: { id: 'next', status: 'inProgress' } } });
        if (reason === 'no-decision') await s.notify({ method: 'turn/completed', params: { threadId: state.threadId, turn: { id: 'next', status: 'completed' } } });
      }
      await s.managers.flush();
      expect(s.managers.get(state.id).status).toBe('paused');
      expect(s.inbox.pending('supervisor')[0]?.event.kind).toBe('round-limit');
      expect(s.requests().some(r => r.method === 'thread/goal/set' && r.params.status === 'paused')).toBe(true);
      expect(s.removed).toContain(state.id);
    } finally { await s.close(); }
  }
});

test('a control-plane decision prevents the turn from counting as empty', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec); await s.managers.noteCommand(manager.id);
    await s.notify({ method: 'turn/completed', params: { threadId: manager.threadId, turn: { id: manager.activeTurnId, status: 'completed' } } });
    expect(s.managers.get(manager.id).turnsWithoutDecision).toBe(0);
  } finally { await s.close(); }
});

test('completion is checked, unmet evidence is delivered, and only a validated goal stops', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start(s.spec); await s.managers.flush();
    await s.notify({ method: 'thread/goal/updated', params: { threadId: manager.threadId,
      goal: { status: 'complete', tokensUsed: 100, timeUsedSeconds: 1, tokenBudget: 40000 } } });
    expect(s.inbox.pending(manager.id)[0]?.event.kind).toBe('goal-unmet');
    expect(s.inbox.pending(manager.id)[0]?.event.evidencePath).toEndWith('completion.log');
    expect(s.managers.get(manager.id).status).toBe('running');
    expect(s.managers.get(manager.id).goalState?.status).toBe('active');
    s.pass(); await s.managers.complete(manager.id); await s.managers.flush();
    expect(s.managers.get(manager.id).status).toBe('complete'); expect(s.removed).toContain(manager.id);
  } finally { await s.close(); }
});

test('Claude manager opens the requested CLI and counts turns through hooks', async () => {
  const s = await setup();
  try {
    const manager = await s.managers.start({ ...s.spec, engine: 'claude' });
    const argv = s.windows[0]!.argv;
    expect(argv).toContain('claude-opus-5-5'); expect(argv).toContain('--autocompact'); expect(argv).toContain('300000');
    expect(argv.at(-1)).toContain('inbox wait manager'); expect(argv).toContain('--settings');
    expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(argv.some(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))).toBe(true);
    const defaults = await setup();
    try {
      await defaults.managers.start({ ...defaults.spec, engine: 'claude', pool: { ...defaults.spec.pool, codexHome: join(homedir(), '.claude') } });
      expect(defaults.windows[0]!.argv.some(arg => arg.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
    } finally { await defaults.close(); }
    expect(s.connections).toBe(0);
    await s.managers.claudeTurn(manager.id, true); await s.managers.noteCommand(manager.id); await s.managers.claudeTurn(manager.id, false);
    expect(s.managers.get(manager.id).turns).toBe(1); expect(s.managers.get(manager.id).turnsWithoutDecision).toBe(0);
    s.inbox.deliver({ managerId: manager.id, kind: 'instruction', summary: 'Wake Claude' }); await s.managers.wake(manager.id);
    expect(s.inbox.pending(manager.id)).toHaveLength(1); expect(s.connections).toBe(0);
  } finally { await s.close(); }
});

test('JSON-RPC errors propagate and an exiting app-server rejects pending requests', async () => {
  const s = await setup();
  try {
    await expect(s.client.request('test/fail', {})).rejects.toThrow('Fake failure');
    s.client.close(); await expect(s.client.request('thread/start', {})).rejects.toThrow('closed');
  } finally { await s.close(); }
});

test('host recovery rejoins an existing thread and dispatches committed events without starting a second thread', async () => {
  const s = await setup();
  let recovered: ManagerSessions | undefined;
  const closeTransport = s.client.close.bind(s.client);
  try {
    const state = await s.managers.start(s.spec); await s.managers.flush();
    // The managed daemon survives a host disconnect; retain that fake transport across the handoff.
    s.client.close = () => {};
    await s.managers.close();
    s.inbox.deliver({ managerId: state.id, kind: 'instruction', summary: 'Committed while the host was down' });
    recovered = new ManagerSessions(s.db, s.inbox, s.services);
    await recovered.recover(); await recovered.flush();
    expect(recovered.get(state.id).threadId).toBe(state.threadId);
    expect(recovered.get(state.id).activeTurnId).toBe(state.activeTurnId);
    expect(s.requests().filter(r => r.method === 'thread/start')).toHaveLength(1);
    expect(s.requests().find(r => r.method === 'thread/resume')?.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(s.requests().some(r => r.method === 'thread/goal/get')).toBe(true);
    expect(s.inbox.notifications(state.id)).toHaveLength(0);
  } finally { await recovered?.close(); closeTransport(); await s.close(); }
});

test('the wall-clock deadline pauses a sleeping manager without waiting for a notification', async () => {
  const s = await setup();
  try {
    s.services.now = Date.now;
    const state = await s.managers.start({ ...s.spec, limits: { ...s.spec.limits, wallMs: 80 } });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Wall deadline did not fire')), 1500);
    try {
      const events = await s.inbox.wait('supervisor', controller.signal);
      expect(events[0]?.event.summary).toContain('wall-clock limit');
      expect(s.managers.get(state.id).status).toBe('paused');
    } finally { clearTimeout(timeout); }
  } finally { await s.close(); }
});

test('a manager whose start failed before its session existed can start again', async () => {
  const s = await setup();
  try {
    let fail = true; const connect = s.services.connect;
    s.services.connect = async () => { if (fail) throw new Error('initialize timed out'); return connect(); };
    await expect(s.managers.start(s.spec)).rejects.toThrow('initialize timed out');
    expect(s.managers.get(s.spec.id)).toMatchObject({ status: 'paused' });
    expect(s.managers.get(s.spec.id).threadId ?? null).toBeNull();
    fail = false;
    expect((await s.managers.start(s.spec)).status).toBe('running');
  } finally { await s.close(); }
});
