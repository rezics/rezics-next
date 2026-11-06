import { createServer as createHttpServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { createServer as createViteServer } from 'vite';
import { resolveWebViteConfig } from './support/vite-config';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(appRoot, '../..');

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function makeDirectoryOutsideAllow(allow: readonly string[]): Promise<string> {
  const candidates = [tmpdir(), '/tmp', '/var/tmp', '/dev/shm'];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const candidate of candidates) {
    let root: string;
    try {
      root = realpathSync(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${String(error)}`);
      continue;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      const directory = await mkdtemp(join(root, 'web-vite-outside-'));
      if (allow.some((allowed) => isWithin(allowed, directory))) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      return directory;
    } catch (error) {
      errors.push(`${root}: ${String(error)}`);
    }
  }
  throw new Error(`no directory outside Vite fs.allow (${allow.join(', ')}): ${errors.join('; ')}`);
}

test('Vite serves resolved workspace dependencies while keeping files outside its roots denied', async () => {
  // This is a build-time config inspection, not a fixture runtime, so it does not allocate Worker persistence.
  const config = await resolveWebViteConfig({ command: 'build', mode: 'test' }, appRoot);
  const dependencyRoot = realpathSync(join(workspaceRoot, 'node_modules'));
  const dependencyFile = realpathSync(join(appRoot, 'node_modules/@tanstack/react-start/dist/esm/index.js'));
  const allow = config.server?.fs?.allow ?? [];
  expect(allow).toContain(workspaceRoot);
  expect(allow).toContain(dependencyRoot);
  expect(allow.some((root) => isWithin(root, dependencyFile))).toBe(true);

  const cacheDirectory = await mkdtemp(join(tmpdir(), 'web-vite-cache-'));
  const outsideDirectory = await makeDirectoryOutsideAllow(allow);
  const outsideFile = join(outsideDirectory, 'outside.js');
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let http: ReturnType<typeof createHttpServer> | undefined;
  try {
    await writeFile(outsideFile, 'export const outside = true;\n');
    vite = await createViteServer({
      configFile: false,
      root: appRoot,
      cacheDir: join(cacheDirectory, 'vite-cache'),
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, fs: { strict: true, allow } },
    });
    http = createHttpServer((request, response) => {
      vite!.middlewares(request, response, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      http!.once('error', rejectListen);
      http!.listen(0, '127.0.0.1', resolveListen);
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Vite middleware did not bind a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    const toFsUrl = (path: string) => `${origin}/@fs/${path.replace(/^[/\\]+/, '')}`;

    const dependencyResponse = await fetch(toFsUrl(dependencyFile));
    expect(dependencyResponse.status).toBe(200);
    expect(await dependencyResponse.text()).not.toBe('');

    const outsideResponse = await fetch(toFsUrl(outsideFile));
    expect(outsideResponse.status).toBe(403);
  } finally {
    try {
      if (http?.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          http!.close((error) => (error ? rejectClose(error) : resolveClose()));
        });
      }
    } finally {
      try {
        await vite?.close();
      } finally {
        await rm(cacheDirectory, { recursive: true, force: true });
        await rm(outsideDirectory, { recursive: true, force: true });
      }
    }
  }
});

test('SSR optimizeDeps keeps discovery off after the Cloudflare Worker environment merge', async () => {
  // Cloudflare's TypeScript config loader requires Node, as used by the real Vite CLI.
  // Serve is the Copies/signed-in ready path; build previously passed while serve still discovered.
  const result = Bun.spawnSync({
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { resolveConfig } from 'vite';
        for (const command of ['serve', 'build']) {
          const config = await resolveConfig({ logLevel: 'silent' }, command, 'development');
          for (const [name, environment] of Object.entries(config.environments)) {
            if (name === 'client') continue;
            const optimizeDeps = environment.optimizeDeps;
            assert.equal(optimizeDeps.noDiscovery, true, command + ':' + name);
            for (const pkg of ['react-day-picker', 'date-fns', '@date-fns/tz'])
              assert.ok(optimizeDeps.exclude.includes(pkg), command + ':' + name + ':' + pkg);
          }
        }
      `,
    ],
    cwd: appRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 55_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stdout.toString() + result.stderr.toString());
  expect(result.exitCode).toBe(0);
}, 60_000);

test('Workers resolve both share-card public Wasm exports through the installed dependency links', async () => {
  // Cloudflare's TypeScript config loader requires Node, as used by the real Vite CLI.
  const result = Bun.spawnSync({
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { readFileSync, realpathSync } from 'node:fs';
        import { resolve } from 'node:path';
        import { resolveConfig } from 'vite';
        const config = await resolveConfig({ logLevel: 'silent' }, 'build', 'development');
        assert.equal(config.environments.ssr.resolve.noExternal, true);
        const resolveId = config.createResolver();
        const importer = resolve('src/media/share-card.worker.ts');
        for (const exported of ['satori/layout.wasm', '@resvg/resvg-wasm/index_bg.wasm']) {
          const local = realpathSync(resolve('node_modules', exported));
          for (const query of ['', '?module'])
            assert.equal(await resolveId(exported + query, importer, false, true), local + query);
          assert.equal(WebAssembly.validate(readFileSync(local)), true);
        }
      `,
    ],
    cwd: appRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stdout.toString() + result.stderr.toString());
  expect(result.exitCode).toBe(0);
});
