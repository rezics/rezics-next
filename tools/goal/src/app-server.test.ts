import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectPool } from './app-server.ts';
import { temporaryDirectory } from './test-support.ts';

const coloredFake = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'app-server' || !args.includes('--listen')) process.exit(2);
const listen = new URL(args[args.indexOf('--listen') + 1]);
if (listen.protocol !== 'ws:' || listen.hostname !== '127.0.0.1') process.exit(3);
mkdirSync(process.env.CODEX_HOME, { recursive: true });
writeFileSync(
  join(process.env.CODEX_HOME, 'spawn-env.json'),
  JSON.stringify({ NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM, FORCE_COLOR: process.env.FORCE_COLOR }),
);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(listen.port || 0),
  fetch(request, server) {
    if (new URL(request.url).pathname === '/readyz') return new Response('ok');
    return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
  },
  websocket: {
    message(ws, data) {
      const message = JSON.parse(String(data));
      if (message.id === undefined) return;
      const result =
        message.method === 'initialize'
          ? { userAgent: 'fake', codexHome: process.env.CODEX_HOME }
          : { echo: message.method, params: message.params };
      ws.send(JSON.stringify({ id: message.id, result }));
    },
  },
});
process.stderr.write('\\x1b[32mreadyz:\\x1b[0m http://127.0.0.1:' + server.port + '/readyz\\n');
`;

test('connectPool reads ANSI-colored 0.164.0 readiness and starts the app-server without color', async () => {
  const temporary = temporaryDirectory();
  try {
    const executable = join(temporary.path, 'codex');
    writeFileSync(executable, coloredFake);
    chmodSync(executable, 0o755);
    const codexHome = join(temporary.path, 'home');
    mkdirSync(codexHome);
    const server = await connectPool({ id: 'pool', codexHome, executable }, undefined, {
      ...process.env,
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    });
    try {
      expect(server.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(JSON.parse(readFileSync(join(codexHome, 'spawn-env.json'), 'utf8'))).toEqual({
        NO_COLOR: '1',
        TERM: 'dumb',
      });
      expect(await server.request('thread/list', {})).toEqual({ echo: 'thread/list', params: {} });
    } finally {
      await server.close();
    }
  } finally {
    temporary.close();
  }
});
