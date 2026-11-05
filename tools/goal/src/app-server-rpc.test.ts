import { expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcError, StdioAppServer, connectPool, type AppServer } from './app-server.ts';
import { AppServerRpc } from './app-server-rpc.ts';
import { readControlPolicy } from './policy.ts';
import { temporaryDirectory } from './test-support.ts';

const handlers = `
let firstRequest;
let unsupportedParent;
let initializeParams;
let initialized = false;
let notificationNumber = 0;
function handle(message, send) {
  if (message.method === 'initialize') {
    initializeParams = message.params;
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') {
    initialized = true;
    return;
  }
  if (!message.method && message.id === 91) {
    send({ id: unsupportedParent, result: message.error });
    return;
  }
  if (message.method === 'parallel:first') {
    firstRequest = message;
    return;
  }
  if (message.method === 'parallel:second') {
    send({ id: message.id, result: 'second' });
    send({ id: firstRequest.id, result: 'first' });
    return;
  }
  if (message.method === 'test/notify') {
    send({ method: 'test/event', params: { number: ++notificationNumber } });
    send({ id: message.id, result: null });
    return;
  }
  if (message.method === 'test/error') {
    send({ id: message.id, error: { code: -32042, message: 'structured failure', data: { retry: false } } });
    return;
  }
  if (message.method === 'test/unsupported') {
    unsupportedParent = message.id;
    send({ id: 91, method: 'server/unsupported' });
    return;
  }
  if (message.method === 'test/late') {
    setTimeout(() => send({ id: message.id, result: 'late' }), 300);
    return;
  }
  if (message.method === 'test/never') return;
  if (message.method === 'test/exit') {
    setTimeout(() => process.exit(7), 0);
    return;
  }
  if (message.method === 'test/initialization-state') {
    send({ id: message.id, result: { params: initializeParams, initialized } });
    return;
  }
  send({ id: message.id, result: message.method });
}
`;

const stdioProgram = `
import { createInterface } from 'node:readline';
${handlers}
const send = (message) => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));
createInterface({ input: process.stdin }).on('line', (line) => handle(JSON.parse(line), send));
`;

const websocketProgram = `#!/usr/bin/env bun
${handlers}
const args = process.argv.slice(2);
const listen = new URL(args[args.indexOf('--listen') + 1]);
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(listen.port || 0), fetch(request, server) {
  if (new URL(request.url).pathname === '/readyz') return new Response('ok');
  return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
}, websocket: { message(ws, data) {
  handle(JSON.parse(String(data)), (message) => ws.send(JSON.stringify(message)));
} } });
console.error('readyz: http://127.0.0.1:' + server.port + '/readyz');
`;

const policy = readControlPolicy({
  appServer: { readinessTimeoutMs: 1000, connectTimeoutMs: 1000, requestTimeoutMs: 150, terminationGraceMs: 25 },
}).appServer;

const transports: { name: string; connect(directory: string): Promise<AppServer> }[] = [
  {
    name: 'stdio',
    async connect() {
      const client = new StdioAppServer(
        [process.execPath, '-e', stdioProgram],
        process.env,
        policy.requestTimeoutMs,
        policy.terminationGraceMs,
      );
      await client.initialize();
      return client;
    },
  },
  {
    name: 'WebSocket',
    async connect(directory) {
      const executable = join(directory, 'codex');
      writeFileSync(executable, websocketProgram);
      chmodSync(executable, 0o755);
      return connectPool(
        { id: 'rpc-test', codexHome: join(directory, 'codex-home'), executable },
        undefined,
        process.env,
        policy,
      );
    },
  },
];

for (const transport of transports) {
  test(`${transport.name} app-server preserves shared JSON-RPC behavior`, async () => {
    const temporary = temporaryDirectory();
    const client = await transport.connect(temporary.path);
    try {
      const initialized = await client.request<{ params: unknown; initialized: boolean }>('test/initialization-state', {});
      expect(initialized).toEqual({
        params: {
          clientInfo: { name: 'rezics_goal', title: 'REZICS Goal', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        initialized: true,
      });

      const completionOrder: string[] = [];
      const first = client.request('parallel:first', {}).then((value) => {
        completionOrder.push('first');
        return value;
      });
      const second = client.request('parallel:second', {}).then((value) => {
        completionOrder.push('second');
        return value;
      });
      await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
      expect(completionOrder).toEqual(['second', 'first']);

      const notifications: number[] = [];
      const unsubscribe = client.onNotification((notification) => notifications.push(notification.params.number));
      await client.request('test/notify', {});
      unsubscribe();
      await client.request('test/notify', {});
      expect(notifications).toEqual([1]);

      const rpcError = await client.request('test/error', {}).catch((error) => error);
      expect(rpcError).toBeInstanceOf(RpcError);
      expect(rpcError).toMatchObject({ code: -32042, message: 'structured failure', data: { retry: false } });
      await expect(client.request('test/unsupported', {})).resolves.toEqual({
        code: -32601,
        message: 'Unsupported server request: server/unsupported',
      });

      await expect(client.request('test/late', {})).rejects.toThrow('App-server request timed out: test/late');
      await Bun.sleep(200);
      await expect(client.request('test/after-late', {})).resolves.toBe('test/after-late');

      const pending = client.request('test/never', {});
      const pendingFailure = pending.catch((error) => error);
      await client.close();
      await expect(pendingFailure).resolves.toMatchObject({ message: 'App-server client closed' });
    } finally {
      await client.close();
      temporary.close();
    }
  });

  test(`${transport.name} app-server exit rejects outstanding requests`, async () => {
    const temporary = temporaryDirectory();
    const client = await transport.connect(temporary.path);
    try {
      const pending = client.request('test/exit', {});
      await expect(pending).rejects.toThrow(/App-server exited|App-server WebSocket closed/);
    } finally {
      await client.close();
      temporary.close();
    }
  });
}

test('shared request tracking clears failed writes and rejects malformed input', async () => {
  let failNextWrite = true;
  const writes: string[] = [];
  const rpc = new AppServerRpc((text) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('write failed');
    }
    writes.push(text);
  }, 100);

  await expect(rpc.request('write-fails', {})).rejects.toThrow('write failed');
  const next = rpc.request('works', {});
  const request = JSON.parse(writes[0]!);
  rpc.receive(JSON.stringify({ id: request.id, result: 'ok' }));
  await expect(next).resolves.toBe('ok');

  const outstanding = rpc.request('malformed', {});
  rpc.receive('{');
  await expect(outstanding).rejects.toThrow('Invalid app-server message:');
});
