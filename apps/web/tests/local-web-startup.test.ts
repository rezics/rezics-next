import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { ownBunProcess } from './support/server-custody.ts';

test('ordinary Web starts the real listener with an empty Vite cache and settles its owned process tree', async () => {
  const app = resolve(import.meta.dir, '..');
  const temporary = resolve(app, '../../.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(resolve(temporary, 'web-listener-'));
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing reserved loopback port');
  const port = address.port;
  await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
  const child = Bun.spawn([process.execPath, 'scripts/storybook-dev.ts', '--app', '--port', String(port)], {
    cwd: app,
    env: {
      ...process.env,
      PATH: [resolve(app, 'node_modules/.bin'), resolve(app, '../../node_modules/.bin'), process.env.PATH]
        .filter(Boolean)
        .join(':'),
      NODE_ENV: 'development',
      REZICS_TEST_RUNTIME: undefined,
      REZICS_WALK_STACK_SLOT: undefined,
      WEB_VITE_CACHE_DIR: resolve(directory, 'vite'),
      WEB_TEST_STATE_INSTANCE_DIR: resolve(directory, 'worker'),
      CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
      CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    },
    detached: true,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const owner = ownBunProcess(child, { label: 'cold ordinary Web', outputLimit: 64_000 });
  const started = performance.now();
  try {
    const deadline = started + 180_000;
    let listening = false;
    while (performance.now() < deadline && child.exitCode === null) {
      listening = /stage=listen outcome=ready/.test(owner.diagnostics());
      if (listening) break;
      await Bun.sleep(250);
    }
    expect(listening, owner.diagnostics()).toBe(true);
    expect(owner.diagnostics()).toContain('stage=live-cache exit=0');
    expect(owner.diagnostics()).toContain('stage=dependencies-preparation-complete exit=0');
    expect(owner.diagnostics()).toContain('Compilation skipped');
    const response = await fetch(`http://127.0.0.1:${port}/@vite/client`, { signal: AbortSignal.timeout(10_000) });
    expect(response.status, owner.diagnostics()).toBe(200);
    expect(await response.text()).toContain('WebSocket');
    console.error(`web: cold listener ready elapsedMs=${Math.round(performance.now() - started)}`);
  } finally {
    await owner.close();
    expect(owner.settled).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 210_000);
