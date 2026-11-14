import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { processIdentity } from '../process.ts';

const log = process.env.FAKE_RPC_LOG!;
let nextThread = 0;
let nextTurn = 0;
let lateGoalStartSent = false;
const goals = new Map<string, any>();
const turns = new Map<string, any>();
const items = new Map<string, { turnId: string; item: any }[]>();
const delayed = new Map<number, any>();
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const subscribedThreads = new Set<string>();
const emit = (notification: { method: string; params: { threadId: string; [key: string]: unknown } }) => {
  if (process.env.FAKE_THREAD_SUBSCRIPTIONS !== '1' || subscribedThreads.has(notification.params.threadId))
    send(notification);
};

function persistItem(threadId: string, turnId: string, item: any): void {
  const entries = items.get(threadId) ?? [];
  entries.push({ turnId, item });
  items.set(threadId, entries);
}

function stalled(method: string, params: any): boolean {
  const path = process.env.FAKE_RPC_STALL_FILE;
  if (!path) return false;
  try {
    const rule = JSON.parse(readFileSync(path, 'utf8')) as { method?: string; threadId?: string; status?: string };
    return (
      rule.method === method &&
      (!rule.threadId || rule.threadId === params?.threadId) &&
      (!rule.status || rule.status === params?.status)
    );
  } catch {
    return false;
  }
}

/** FAKE_RPC_FAIL_FILE names a JSON `{ "method": ... }` rule that fails the next matching request once. */
function failOnce(method: string): boolean {
  const path = process.env.FAKE_RPC_FAIL_FILE;
  if (!path) return false;
  try {
    const rule = JSON.parse(readFileSync(path, 'utf8')) as { method?: string };
    if (rule.method !== method) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function respond(message: any): void {
  const p = message.params;
  if (failOnce(message.method)) {
    send({ id: message.id, error: { code: -32600, message: 'Thread not loaded' } });
    return;
  }
  let result: any = {};
  switch (message.method) {
    case 'thread/start': {
      const id = `thread-${++nextThread}`;
      subscribedThreads.add(id);
      result = { thread: { id } };
      break;
    }
    case 'thread/resume':
      subscribedThreads.add(p.threadId);
      result = { thread: { id: p.threadId, turns: turns.has(p.threadId) ? [turns.get(p.threadId)] : [] } };
      break;
    case 'thread/items/list': {
      const data = (items.get(p.threadId) ?? [])
        .filter((entry) => entry.turnId === p.turnId)
        .map((entry) => ({ turnId: entry.turnId, item: entry.item, startedAtMs: null, completedAtMs: null }));
      result = { data, nextCursor: null, backwardsCursor: null };
      break;
    }
    case 'thread/goal/set': {
      const previous = goals.get(p.threadId);
      const goal = { tokensUsed: 0, timeUsedSeconds: 0, ...goals.get(p.threadId), ...p };
      goals.set(p.threadId, goal);
      result = { goal };
      emit({ method: 'thread/goal/updated', params: { threadId: p.threadId, goal } });
      if (process.env.FAKE_GOAL_AUTO_START_ON_ACTIVE === '1' && previous?.status === 'paused' && p.status === 'active') {
        const turn = { id: `turn-${++nextTurn}`, status: 'inProgress', source: 'goal' };
        turns.set(p.threadId, turn);
        emit({ method: 'turn/started', params: { threadId: p.threadId, turn } });
      }
      if (
        process.env.FAKE_GOAL_LATE_START_ON_PAUSE === '1' &&
        !lateGoalStartSent &&
        previous?.status === 'active' &&
        p.status === 'paused'
      ) {
        lateGoalStartSent = true;
        setTimeout(() => {
          const turn = { id: `turn-${++nextTurn}`, status: 'inProgress', source: 'goal' };
          turns.set(p.threadId, turn);
          emit({ method: 'turn/started', params: { threadId: p.threadId, turn } });
        }, 0);
      }
      break;
    }
    case 'thread/goal/get':
      result = { goal: goals.get(p.threadId) ?? null };
      break;
    case 'thread/goal/clear':
      goals.delete(p.threadId);
      result = { cleared: true };
      break;
    case 'turn/start': {
      if (turns.get(p.threadId)?.status === 'inProgress') {
        if (process.env.FAKE_THREAD_SUBSCRIPTIONS === '1') {
          // Codex can accept turn/start by steering the existing native turn, without subscribing the caller.
          result = { turn: turns.get(p.threadId) };
          break;
        }
        send({ id: message.id, error: { code: -32600, message: 'Turn already active' } });
        return;
      }
      const turn = { id: `turn-${++nextTurn}`, status: 'inProgress' };
      turns.set(p.threadId, turn);
      emit({ method: 'turn/started', params: { threadId: p.threadId, turn } });
      result = { turn };
      break;
    }
    case 'turn/steer':
      if (turns.get(p.threadId)?.id !== p.expectedTurnId) {
        send({ id: message.id, error: { code: -32600, message: 'Turn mismatch' } });
        return;
      }
      result = { turnId: p.expectedTurnId };
      break;
    case 'turn/interrupt': {
      const turn = { id: p.turnId, status: 'interrupted' };
      turns.delete(p.threadId);
      emit({ method: 'turn/completed', params: { threadId: p.threadId, turn } });
      break;
    }
    case 'test/notify':
      if (p.method === 'turn/completed') turns.delete(p.params.threadId);
      if (p.method === 'turn/started') turns.set(p.params.threadId, p.params.turn);
      if (p.method === 'item/started' || p.method === 'item/completed')
        persistItem(p.params.threadId, p.params.turnId, p.params.item);
      emit(p);
      break;
    case 'test/drop-thread-subscriptions':
      subscribedThreads.clear();
      break;
    case 'test/persist-item':
      persistItem(p.threadId, p.turnId, p.item);
      result = { persisted: true };
      break;
    case 'test/fail':
      send({ id: message.id, error: { code: -32000, message: 'Fake failure' } });
      return;
  }
  send({ id: message.id, result });
}

function accept(message: any): void {
  const requiredStoppedPid = Number(process.env.FAKE_APP_SERVER_MUST_STOP_PID);
  const oldProcessAlive =
    Number.isSafeInteger(requiredStoppedPid) && requiredStoppedPid > 0
      ? processIdentity(requiredStoppedPid) !== null
      : undefined;
  appendFileSync(
    log,
    `${JSON.stringify({
      ...message,
      ...(message.method === 'thread/resume' && oldProcessAlive !== undefined ? { oldProcessAlive } : {}),
    })}\n`,
  );
  if (message.id === undefined) return;
  if (stalled(message.method, message.params)) {
    delayed.set(message.id, message);
    return;
  }
  respond(message);
}

if (process.env.FAKE_APP_SERVER_PERSIST === '1') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 60_000);
}
setInterval(() => {
  for (const [id, message] of delayed) {
    if (!stalled(message.method, message.params)) {
      delayed.delete(id);
      respond(message);
    }
  }
}, 10).unref();

createInterface({ input: process.stdin }).on('line', (line) => accept(JSON.parse(line)));
