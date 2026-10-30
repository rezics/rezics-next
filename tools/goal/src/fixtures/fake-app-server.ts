import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { processIdentity } from '../process.ts';

const log = process.env.FAKE_RPC_LOG!;
let nextThread = 0;
let nextTurn = 0;
const goals = new Map<string, any>();
const turns = new Map<string, any>();
const delayed = new Map<number, any>();
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

function stalled(method: string, params: any): boolean {
  const path = process.env.FAKE_RPC_STALL_FILE;
  if (!path) return false;
  try {
    const rule = JSON.parse(readFileSync(path, 'utf8')) as { method?: string; threadId?: string };
    return rule.method === method && (!rule.threadId || rule.threadId === params?.threadId);
  } catch {
    return false;
  }
}

function respond(message: any): void {
  const p = message.params;
  let result: any = {};
  switch (message.method) {
    case 'thread/start':
      result = { thread: { id: `thread-${++nextThread}` } };
      break;
    case 'thread/resume':
      result = { thread: { id: p.threadId, turns: turns.has(p.threadId) ? [turns.get(p.threadId)] : [] } };
      break;
    case 'thread/goal/set': {
      const goal = { tokensUsed: 0, timeUsedSeconds: 0, ...goals.get(p.threadId), ...p };
      goals.set(p.threadId, goal);
      result = { goal };
      send({ method: 'thread/goal/updated', params: { threadId: p.threadId, goal } });
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
      const turn = { id: `turn-${++nextTurn}`, status: 'inProgress' };
      turns.set(p.threadId, turn);
      send({ method: 'turn/started', params: { threadId: p.threadId, turn } });
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
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn } });
      break;
    }
    case 'test/notify':
      if (p.method === 'turn/completed') turns.delete(p.params.threadId);
      send(p);
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
