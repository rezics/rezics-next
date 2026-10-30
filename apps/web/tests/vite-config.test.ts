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

test('Vite serves resolved workspace dependencies while keeping files outside its roots denied', async () => {
  // This is a build-time config inspection, not a fixture runtime, so it does not allocate Worker persistence.
  const config = await resolveWebViteConfig({ command: 'build', mode: 'test' }, appRoot);
  const dependencyRoot = realpathSync(join(workspaceRoot, 'node_modules'));
  const dependencyFile = realpathSync(join(appRoot, 'node_modules/@tanstack/react-start/dist/esm/index.js'));
  const allow = config.server?.fs?.allow ?? [];
  expect(allow).toContain(workspaceRoot);
  expect(allow).toContain(dependencyRoot);
  expect(isWithin(dependencyRoot, dependencyFile)).toBe(true);

  const privateDirectory = await mkdtemp(join(tmpdir(), 'web-vite-fs-'));
  const outsideFile = join(privateDirectory, 'outside.js');
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let http: ReturnType<typeof createHttpServer> | undefined;
  try {
    await writeFile(outsideFile, 'export const outside = true;\n');
    vite = await createViteServer({
      configFile: false,
      root: appRoot,
      cacheDir: join(privateDirectory, 'vite-cache'),
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, fs: { allow } },
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
        await rm(privateDirectory, { recursive: true, force: true });
      }
    }
  }
});

test('Workers resolve both share-card public Wasm exports through the installed dependency links', async () => {
  const [{ resolveConfig }, { default: webConfig }] = await Promise.all([import('vite'), import('../vite.config')]);
  const context = { command: 'build', mode: 'development' } as const;
  const config = await resolveConfig(
    { ...webConfig(context), root: appRoot, configFile: false, logLevel: 'silent' },
    context.command,
    context.mode,
  );
  expect(config.environments.ssr?.resolve.noExternal).toBe(true);
  const resolveId = config.createResolver();
  const importer = join(appRoot, 'src/media/share-card.worker.ts');
  for (const exported of ['satori/yoga.wasm', '@resvg/resvg-wasm/index_bg.wasm']) {
    const local = realpathSync(join(appRoot, 'node_modules', exported));
    for (const query of ['', '?module'])
      expect(await resolveId(`${exported}${query}`, importer, false, true)).toBe(`${local}${query}`);
    expect(WebAssembly.validate(await Bun.file(local).arrayBuffer())).toBe(true);
  }
});
