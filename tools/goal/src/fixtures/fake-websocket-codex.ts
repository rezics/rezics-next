import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const append = (path: string | undefined, value: unknown) => {
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`);
};

if (args[0] === 'resume') {
  const viewer = {
    argv: args,
    codexHome: process.env.CODEX_HOME,
    pid: process.pid,
  };
  append(process.env.FAKE_VIEWER_LOG, { ...viewer, phase: 'started' });
  console.log('› Ask Codex to do anything');
  const endpointIndex = args.indexOf('--remote');
  const endpoint = endpointIndex >= 0 ? args[endpointIndex + 1] : undefined;
  const socket = endpoint ? new WebSocket(endpoint) : undefined;
  if (socket) {
    let nextId = 0;
    const pending = new Map<number, string>();
    const request = (method: string, params: Record<string, unknown>) => {
      const id = ++nextId;
      pending.set(id, method);
      socket.send(JSON.stringify({ id, method, params }));
    };
    socket.addEventListener('open', () =>
      request('initialize', {
        clientInfo: { name: 'fake_goal_viewer', title: 'Goal lifecycle fixture', version: '1' },
        capabilities: { experimentalApi: true },
      }),
    );
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
      const method = response.id === undefined ? undefined : pending.get(response.id);
      if (!method) return;
      pending.delete(response.id!);
      if (response.error) {
        append(process.env.FAKE_VIEWER_LOG, { ...viewer, phase: 'failed', method });
        return;
      }
      if (method === 'initialize') request('thread/resume', { threadId: args[1] });
      else if (method === 'thread/resume')
        append(process.env.FAKE_VIEWER_LOG, { ...viewer, phase: 'attached', endpoint });
    });
    socket.addEventListener('error', () =>
      append(process.env.FAKE_VIEWER_LOG, { ...viewer, phase: 'failed', endpoint }),
    );
  }
  setInterval(() => {}, 60_000);
} else if (args[0] === 'app-server') {
  type Thread = { turns: { id: string; status: string }[]; goal: Record<string, unknown> | null };
  const threadStatePath = process.env.FAKE_THREAD_STATE;
  const stored =
    threadStatePath && existsSync(threadStatePath)
      ? (JSON.parse(readFileSync(threadStatePath, 'utf8')) as Record<string, Thread>)
      : {};
  const threads = new Map<string, Thread>(Object.entries(stored));
  const persistThreads = () => {
    if (threadStatePath) writeFileSync(threadStatePath, JSON.stringify(Object.fromEntries(threads)));
  };
  const currentNumber = (prefix: string) => {
    const ids = [...threads.values()].flatMap((thread) => thread.turns.map((turn) => turn.id));
    return Math.max(0, ...ids.flatMap((id) => (id.startsWith(prefix) ? [Number(id.slice(prefix.length)) || 0] : [])));
  };
  let nextThread = currentNumber('thread-');
  let nextTurn = currentNumber('turn-');
  append(process.env.FAKE_SERVER_START_LOG, {
    args,
    codexHome: process.env.CODEX_HOME,
    pid: process.pid,
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request)) return undefined;
      return new Response('ready');
    },
    websocket: {
      message(socket, text) {
        const request = JSON.parse(String(text)) as {
          id?: number;
          method: string;
          params: Record<string, any>;
        };
        append(process.env.FAKE_RPC_LOG, request);
        if (request.id === undefined) return;
        const params = request.params ?? {};
        let result: Record<string, any> = {};
        switch (request.method) {
          case 'thread/start': {
            const threadId = `thread-${++nextThread}`;
            threads.set(threadId, { turns: [], goal: null });
            persistThreads();
            result = { thread: { id: threadId } };
            break;
          }
          case 'thread/resume': {
            const thread = threads.get(params.threadId as string) ?? { turns: [], goal: null };
            threads.set(params.threadId as string, thread);
            persistThreads();
            result = { thread: { id: params.threadId, turns: thread.turns } };
            break;
          }
          case 'thread/goal/set': {
            const thread = threads.get(params.threadId as string) ?? { turns: [], goal: null };
            thread.goal = { tokensUsed: 0, timeUsedSeconds: 0, ...thread.goal, ...params };
            threads.set(params.threadId as string, thread);
            persistThreads();
            result = { goal: thread.goal };
            break;
          }
          case 'thread/goal/get':
            result = { goal: threads.get(params.threadId as string)?.goal ?? null };
            break;
          case 'thread/goal/clear':
            if (threads.has(params.threadId as string)) threads.get(params.threadId as string)!.goal = null;
            persistThreads();
            result = { cleared: true };
            break;
          case 'thread/items/list':
            result = { data: [], nextCursor: null, backwardsCursor: null };
            break;
          case 'turn/start': {
            const thread = threads.get(params.threadId as string) ?? { turns: [], goal: null };
            if (thread.turns.some((turn) => turn.status === 'inProgress')) {
              socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Turn already active' } }));
              return;
            }
            const turn = { id: `turn-${++nextTurn}`, status: 'inProgress' };
            thread.turns.push(turn);
            threads.set(params.threadId as string, thread);
            persistThreads();
            result = { turn };
            break;
          }
          case 'turn/steer':
            result = { turnId: params.expectedTurnId };
            break;
          case 'turn/interrupt': {
            const thread = threads.get(params.threadId as string);
            if (thread)
              thread.turns = thread.turns.map((turn) =>
                turn.id === params.turnId ? { ...turn, status: 'interrupted' } : turn,
              );
            persistThreads();
            result = { turnId: params.turnId };
            break;
          }
        }
        socket.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
  console.error(`readyz: http://127.0.0.1:${server.port}/readyz`);
} else {
  console.error(`unsupported fake Codex command: ${args[0] ?? ''}`);
  process.exitCode = 2;
}
