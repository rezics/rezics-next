import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectPool } from './app-server.ts';
import { readControlPolicy } from './policy.ts';

// Stands in for `codex app-server --listen ws://127.0.0.1:<port>` (port 0 picks one), printing its readiness URL to
// stderr as codex-cli 0.163.0 does, and answering JSON-RPC over the WebSocket.
const fake = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== 'app-server' || !args.includes('--listen')) process.exit(2);
const listen = new URL(args[args.indexOf('--listen') + 1]);
if (listen.protocol !== 'ws:' || listen.hostname !== '127.0.0.1') process.exit(3);
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(listen.port || 0), fetch(request, server) {
  if (new URL(request.url).pathname === '/readyz') return new Response('ok');
  return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
}, websocket: { message(ws, data) {
  const message = JSON.parse(String(data));
  if (message.id === undefined) return;
  const result = message.method === 'initialize' ? { userAgent: 'fake', codexHome: process.env.CODEX_HOME } : { echo: message.method, params: message.params };
  ws.send(JSON.stringify({ id: message.id, result }));
  if (message.method === 'thread/start') ws.send(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-1' } } }));
} } });
console.error('  readyz: http://127.0.0.1:' + server.port + '/readyz');
`;

function installFake(directory: string, source: string): string {
  const executable = join(directory, 'codex');
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  return executable;
}

test('pool policy bounds readiness diagnostics and request deadlines', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-ws-policy-'));
  const policy = readControlPolicy({
    appServer: {
      readinessTimeoutMs: 1000,
      diagnosticCharacters: 32,
      requestTimeoutMs: 25,
      terminationGraceMs: 25,
    },
  }).appServer;
  const executable = installFake(
    directory,
    '#!/usr/bin/env bun\nconsole.error("x".repeat(200) + "bounded-tail"); setInterval(() => {}, 1000);',
  );
  let failure = '';
  try {
    await connectPool({ id: 'policy', codexHome: directory, executable }, undefined, undefined, policy);
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain('Timed out waiting for app-server readiness:');
  expect(failure).toContain('bounded-tail');
  expect(failure.length).toBeLessThan(100);
  installFake(
    directory,
    fake.replace(
      'if (message.id === undefined) return;',
      "if (message.id === undefined || message.method === 'no-response') return;",
    ),
  );
  const server = await connectPool({ id: 'policy', codexHome: directory, executable }, undefined, undefined, policy);
  try {
    await expect(server.request('no-response', {})).rejects.toThrow('App-server request timed out: no-response');
  } finally {
    await server.close();
  }
});

test('a pool app-server listens on a loopback WebSocket owned by the caller and serves JSON-RPC', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-ws-'));
  const executable = installFake(directory, fake);
  const server = await connectPool({ id: 'pool', codexHome: join(directory, 'home'), executable });
  const endpoint = server.endpoint;
  try {
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const notifications: string[] = [];
    server.onNotification((notification) => notifications.push(notification.method));
    expect(await server.request('thread/start', { cwd: directory })).toEqual({
      echo: 'thread/start',
      params: { cwd: directory },
    });
    await Bun.sleep(50);
    expect(notifications).toContain('thread/started');
  } finally {
    server.close();
  }
  await Bun.sleep(300);
  expect(
    await fetch(`${endpoint.replace('ws://', 'http://')}/readyz`).then(
      () => 'up',
      () => 'down',
    ),
  ).toBe('down');
});

test('a noisy app-server remains bounded after readiness and still connects when the readiness marker crosses stream chunks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-ws-split-'));
  const executable = installFake(
    directory,
    fake.replace(
      "console.error('  readyz: http://127.0.0.1:' + server.port + '/readyz');",
      `process.stderr.write('  readyz: ht');
await Bun.sleep(50);
process.stderr.write('tp://127.0.0.1:' + server.port + '/readyz\\n');
const noise = Buffer.alloc(32 * 1024, 0x78);
for (let i = 0; i < 32; i++) process.stderr.write(noise);`,
    ),
  );
  const server = await connectPool({ id: 'pool', codexHome: join(directory, 'home'), executable });
  try {
    expect(server.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(await server.request('thread/list', {})).toEqual({ echo: 'thread/list', params: {} });
  } finally {
    server.close();
  }
});

test('a startup failure still reports a readiness marker split across chunks without retaining unbounded stderr', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-ws-fail-'));
  const executable = installFake(
    directory,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== 'app-server' || !args.includes('--listen')) process.exit(2);
const write = (text) => new Promise((resolve) => process.stderr.write(text, resolve));
await write('noise-start\\n' + 'x'.repeat(300000) + '\\n');
await write('readyz: ht');
await Bun.sleep(50);
await write('tp://127.0.0.1:');
process.exit(7);
`,
  );
  let message = '';
  try {
    await connectPool({ id: 'pool', codexHome: join(directory, 'home'), executable });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('exited before readiness (7):');
  expect(message).toContain('readyz: http://127.0.0.1:');
  expect(message).not.toContain('noise-start');
  expect(message.length).toBeLessThanOrEqual(256 * 1024 + 80);
});
