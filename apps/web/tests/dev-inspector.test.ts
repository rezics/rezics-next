import { afterAll, expect, test } from 'bun:test';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { startDevServer } from './support/dev-server.ts';

const app = join(import.meta.dir, '..');
const timeout = 180_000;
const servers: Awaited<ReturnType<typeof startDevServer>>[] = [];
// A developer's own setting must not leak into what these tests start.
const { WORKER_INSPECTOR_PORT: _, ...inherited } = process.env;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function hold(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Resolves true when something accepts a TCP connection on the port.
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function start(env: Record<string, string>) {
  let output = '';
  const ready = (async () => {
    try {
      const running = await startDevServer({
        exclusive: true,
        cwd: app,
        env: { ...inherited, ...env },
        warmUpPaths: [],
      });
      servers.push(running);
      output = running.diagnostics();
      return { origin: running.origin, code: null as number | null };
    } catch (error) {
      output = String(error);
      const codeMatch = output.match(/exited with (\d+)/);
      return { origin: null as string | null, code: codeMatch ? Number(codeMatch[1]) : 1 };
    }
  })();
  return { ready, output: () => output };
}

afterAll(async () => {
  await Promise.all(servers.map((running) => running.stop()));
});

test(
  'the dev server opens no Worker inspector unless asked, so concurrent servers never race for its port',
  async () => {
    // Holding the plugin's default port makes a probing inspector move to the next one, where it can be seen.
    const held = await hold(9229);
    try {
      const site = start({});
      const { origin } = await site.ready;
      expect(origin, site.output()).not.toBeNull();
      for (let port = 9230; port < 9240; port++) expect(await listening(port), `port ${port}`).toBe(false);
      expect(site.output()).not.toMatch(/inspector port/i);
      expect(site.output()).not.toContain('/__debug');
    } finally {
      held.close();
    }
  },
  timeout,
);

test(
  'WORKER_INSPECTOR_PORT opens the Worker inspector on exactly that port',
  async () => {
    const port = await freePort();
    const site = start({ WORKER_INSPECTOR_PORT: String(port) });
    const { origin } = await site.ready;
    expect(origin, site.output()).not.toBeNull();
    expect(await listening(port)).toBe(true);
  },
  timeout,
);

test(
  'a WORKER_INSPECTOR_PORT that is not a port stops the dev server and names the variable',
  async () => {
    for (const value of ['abc', '0', '65536', '9229.5']) {
      const site = start({ WORKER_INSPECTOR_PORT: value });
      const { origin, code } = await site.ready;
      expect(origin, `${value}: ${site.output()}`).toBeNull();
      expect(code).not.toBe(0);
      expect(site.output()).toContain('WORKER_INSPECTOR_PORT');
    }
  },
  timeout,
);
