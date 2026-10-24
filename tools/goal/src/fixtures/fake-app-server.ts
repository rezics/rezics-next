import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.env.FAKE_RPC_LOG!;
let nextThread = 0; let nextTurn = 0;
const goals = new Map<string, any>();
const turns = new Map<string, any>();
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(log, `${JSON.stringify(message)}\n`);
  if (message.id === undefined) return;
  const p = message.params;
  let result: any = {};
  switch (message.method) {
    case 'thread/start': result = { thread: { id: `thread-${++nextThread}` } }; break;
    case 'thread/resume': result = { thread: { id: p.threadId, turns: turns.has(p.threadId) ? [turns.get(p.threadId)] : [] } }; break;
    case 'thread/goal/set': {
      const goal = { tokensUsed: 0, timeUsedSeconds: 0, ...goals.get(p.threadId), ...p };
      goals.set(p.threadId, goal); result = { goal }; send({ method: 'thread/goal/updated', params: { threadId: p.threadId, goal } }); break;
    }
    case 'thread/goal/get': result = { goal: goals.get(p.threadId) ?? null }; break;
    case 'thread/goal/clear': goals.delete(p.threadId); result = { cleared: true }; break;
    case 'turn/start': {
      const turn = { id: `turn-${++nextTurn}`, status: 'inProgress' }; turns.set(p.threadId, turn);
      send({ method: 'turn/started', params: { threadId: p.threadId, turn } }); result = { turn }; break;
    }
    case 'turn/steer': {
      if (turns.get(p.threadId)?.id !== p.expectedTurnId) {
        send({ id: message.id, error: { code: -32600, message: 'Turn mismatch' } }); return;
      }
      result = { turnId: p.expectedTurnId }; break;
    }
    case 'turn/interrupt': {
      const turn = { id: p.turnId, status: 'interrupted' }; turns.delete(p.threadId);
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn } }); break;
    }
    case 'test/notify': {
      if (p.method === 'turn/completed') turns.delete(p.params.threadId);
      send(p); break;
    }
    case 'test/fail': send({ id: message.id, error: { code: -32000, message: 'Fake failure' } }); return;
  }
  send({ id: message.id, result });
});
