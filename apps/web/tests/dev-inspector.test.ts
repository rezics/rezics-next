import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const timeout = 180_000;
const children: ChildProcess[] = [];
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

// The documented command, in its own process group so that Vite and workerd stop with it.
function start(env: Record<string, string>) {
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  const ready = (async () => {
    const port = await freePort();
    const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...inherited, ...env },
    });
    children.push(child);
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) return { origin: null, code: await exited };
      try {
        const response = await fetch(`${origin}/en`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status < 500) return { origin, code: null };
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return { ready, output: () => output };
}

afterAll(() => {
  for (const child of children)
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
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
