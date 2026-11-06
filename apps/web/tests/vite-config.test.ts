import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { createServer as createViteServer, type Plugin, type ViteDevServer } from 'vite';
import { resolveWebViteConfig } from './support/vite-config';
import {
  bindViteDepCacheAlign,
  viteEnvironmentDepHashes,
  webViteWarmSsrEnvName,
  webViteWorkerSsrOptimizeDeps,
  webViteWorkerSsrResolve,
} from './support/vite-dep-cache.ts';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(appRoot, '../..');

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

test('the dep-cache align hook is a Vite Plugin configureServer', () => {
  const plugin: Plugin = {
    name: 'web-vite-dep-cache-align',
    enforce: 'pre',
    configureServer(server: ViteDevServer) {
      return bindViteDepCacheAlign('/cache', server.environments);
    },
  };
  expect(plugin.enforce).toBe('pre');
});

test('WEB_VITE_CACHE_DIR selects the host-local optimizeDeps cache and allows reading it', async () => {
  const previous = process.env.WEB_VITE_CACHE_DIR;
  const cacheDir = await mkdtemp(join(tmpdir(), 'rezics-web-vite-cache-config-'));
  process.env.WEB_VITE_CACHE_DIR = cacheDir;
  try {
    const config = await resolveWebViteConfig({ command: 'build', mode: 'test' }, appRoot);
    expect(config.cacheDir).toBe(cacheDir);
    expect(config.server?.fs?.allow).toContain(cacheDir);
    expect(config.optimizeDeps?.holdUntilCrawlEnd).toBe(true);
    expect(config.optimizeDeps?.entries).toEqual(['src/routes/**/*.tsx']);
    expect(config.ssr?.optimizeDeps).toBeUndefined();
    const plugins = (config.plugins ?? []).flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin]));
    const worker = plugins.find(
      (plugin) =>
        plugin !== null &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'web-worker-explicit-dependencies',
    );
    expect(worker).toBeTruthy();
    expect(worker && 'enforce' in worker ? worker.enforce : undefined).toBe('post');
    const align = plugins.find(
      (plugin) =>
        plugin !== null && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'web-vite-dep-cache-align',
    );
    expect(align).toBeTruthy();
    expect(align && 'enforce' in align ? align.enforce : undefined).toBe('pre');
    const denied = plugins.find(
      (plugin) =>
        plugin !== null &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'worker-denied-dependencies',
    );
    expect(denied).toBeTruthy();
    expect(denied && 'enforce' in denied ? denied.enforce : undefined).toBe('pre');
    mkdirSync(join(cacheDir, 'deps_ssr'), { recursive: true });
    const metadataPath = join(cacheDir, 'deps_ssr', '_metadata.json');
    writeFileSync(
      metadataPath,
      `${JSON.stringify({
        hash: 'old',
        lockfileHash: 'old-lock',
        configHash: 'middleware',
        browserHash: 'browser',
        optimized: { react: { file: 'react.js', fileHash: 'x' } },
        chunks: {},
      })}\n`,
    );
    const configure =
      align && 'configureServer' in align
        ? typeof align.configureServer === 'function'
          ? align.configureServer
          : align.configureServer && 'handler' in align.configureServer
            ? align.configureServer.handler
            : undefined
        : undefined;
    expect(typeof configure).toBe('function');
    const ssr = {
      name: 'ssr',
      config: {
        root: appRoot,
        plugins: [{ name: 'serve-plugin' }],
        optimizeDeps: { include: ['react'] },
        resolve: { conditions: ['ssr'] },
        mode: 'test',
      },
    };
    if (typeof configure === 'function') {
      const after = configure.call(undefined, { environments: { ssr } }) as undefined | (() => void);
      expect(typeof after).toBe('function');
      after?.();
    }
    const rewritten = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      hash: string;
      lockfileHash: string;
      configHash: string;
      browserHash: string;
    };
    expect(rewritten).toMatchObject({
      ...viteEnvironmentDepHashes(ssr),
      browserHash: 'browser',
    });
    const environmentFor = (name: string) => {
      if (!worker || !('configEnvironment' in worker)) return undefined;
      const hook = worker.configEnvironment;
      const handler = typeof hook === 'function' ? hook : hook && 'handler' in hook ? hook.handler : undefined;
      return typeof handler === 'function' ? handler.call(undefined, name) : undefined;
    };
    const environment = environmentFor('ssr') as
      | {
          optimizeDeps?: { noDiscovery?: boolean; holdUntilCrawlEnd?: boolean; include?: string[]; entries?: string[] };
        }
      | undefined;
    expect(environment?.optimizeDeps?.noDiscovery).toBe(true);
    expect(environment?.optimizeDeps?.holdUntilCrawlEnd).toBe(true);
    expect(environment?.optimizeDeps?.entries).toEqual([]);
    expect(environment?.optimizeDeps?.include).toEqual([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/server',
      '@tanstack/react-router > @tanstack/react-store',
      '@inlang/paraglide-js/urlpattern-polyfill',
    ]);
    expect(environmentFor('client')).toBeUndefined();
    const resolved = worker && 'configResolved' in worker ? worker.configResolved : undefined;
    const pin =
      typeof resolved === 'function' ? resolved : resolved && 'handler' in resolved ? resolved.handler : undefined;
    const environments = {
      ssr: {
        optimizeDeps: { noDiscovery: false, entries: ['src/server.ts'], include: ['cloudflare-discovered'] },
      },
    };
    if (typeof pin === 'function') pin.call(undefined, { environments });
    expect(environments.ssr.optimizeDeps.noDiscovery).toBe(true);
    expect(environments.ssr.optimizeDeps.entries).toEqual([]);
    expect(environments.ssr.optimizeDeps.include).toEqual(environment?.optimizeDeps?.include);
  } finally {
    if (previous === undefined) delete process.env.WEB_VITE_CACHE_DIR;
    else process.env.WEB_VITE_CACHE_DIR = previous;
    await rm(cacheDir, { recursive: true, force: true });
  }
}, 30_000);

test('SSR warm pre-bundles Worker includes without the Cloudflare plugin or worktree source', async () => {
  const previous = process.env[webViteWarmSsrEnvName];
  process.env[webViteWarmSsrEnvName] = '1';
  try {
    const config = await resolveWebViteConfig({ command: 'serve', mode: 'development' }, appRoot);
    expect(config.environments?.ssr?.optimizeDeps?.noDiscovery).toBe(true);
    expect(config.environments?.ssr?.optimizeDeps?.include).toEqual([...webViteWorkerSsrOptimizeDeps.include]);
    expect(config.environments?.ssr?.resolve?.conditions).toEqual([...webViteWorkerSsrResolve.conditions]);
    expect(config.ssr).toMatchObject({ target: 'webworker', noExternal: true });
    const plugins = (config.plugins ?? []).flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin]));
    expect(
      plugins.filter(
        (plugin) =>
          plugin !== null &&
          typeof plugin === 'object' &&
          'name' in plugin &&
          String(plugin.name).includes('cloudflare'),
      ),
    ).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env[webViteWarmSsrEnvName];
    else process.env[webViteWarmSsrEnvName] = previous;
  }
}, 30_000);

function bunInstallRoot(resolved: string): string | undefined {
  const marker = `${sep}node_modules${sep}.bun${sep}`;
  const index = resolved.indexOf(marker);
  if (index === -1) return undefined;
  return resolved.slice(0, index + `${sep}node_modules`.length);
}

function resolveInstalledFile(name: string, specifier = `${name}/package.json`): string {
  const require = createRequire(join(appRoot, 'package.json'));
  try {
    return realpathSync(require.resolve(specifier));
  } catch {
    return realpathSync(require.resolve(name));
  }
}

function allocateExternalDirectory(allow: readonly string[]): string {
  // Host TMPDIR can live inside the checkout, so it is not an external fixture.
  for (const base of ['/var/tmp', '/tmp']) {
    if (!existsSync(base)) continue;
    const directory = mkdtempSync(join(base, 'web-vite-deny-'));
    const real = realpathSync(directory);
    if (!allow.some((root) => isWithin(root, real))) return directory;
    rmSync(directory, { recursive: true, force: true });
  }
  throw new Error('Could not allocate a directory outside Vite fs.allow roots');
}

test('Vite serves resolved workspace dependencies while keeping files outside its roots denied', async () => {
  // Configuration assertions below are not serving proof; the HTTP responses are.
  const config = await resolveWebViteConfig({ command: 'build', mode: 'test' }, appRoot);
  const dependencyFile = resolveInstalledFile('@tanstack/react-start');
  const viteRuntime = resolveInstalledFile('vite');
  const allow = config.server?.fs?.allow ?? [];
  expect(allow).toContain(workspaceRoot);
  expect(allow.some((root) => isWithin(root, dependencyFile))).toBe(true);
  expect(allow.some((root) => isWithin(root, viteRuntime))).toBe(true);
  const store = bunInstallRoot(dependencyFile);
  if (store) expect(allow.some((root) => isWithin(root, store) || root === store)).toBe(true);
  const covering = allow.filter((root) => root !== workspaceRoot && !isWithin(workspaceRoot, root));
  for (const root of covering) expect(covering.filter((other) => other !== root && isWithin(other, root))).toEqual([]);

  const denyRoot = allocateExternalDirectory(allow);
  const cacheRoot = await mkdtemp(join('/var/tmp', 'web-vite-cache-'));
  const outsideFile = join(denyRoot, 'outside.js');
  expect(allow.some((root) => isWithin(root, realpathSync(denyRoot)))).toBe(false);
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let http: ReturnType<typeof createHttpServer> | undefined;
  try {
    await writeFile(outsideFile, 'export const outside = true;\n');
    vite = await createViteServer({
      configFile: false,
      root: appRoot,
      cacheDir: join(cacheRoot, 'vite-cache'),
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, fs: { allow, strict: true } },
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
    const dependencyBody = await dependencyResponse.text();
    console.info(
      `[vite-fs-allow] roots=${JSON.stringify(allow)} dependency=${dependencyFile} status=${dependencyResponse.status} bytes=${dependencyBody.length}`,
    );
    expect(dependencyResponse.status).toBe(200);
    expect(dependencyBody).not.toBe('');

    const outsideResponse = await fetch(toFsUrl(outsideFile));
    const outsideBody = await outsideResponse.text();
    console.info(`[vite-fs-allow] outside=${realpathSync(outsideFile)} status=${outsideResponse.status}`);
    expect(outsideResponse.status, outsideBody).toBe(403);
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
        await Promise.all([
          rm(denyRoot, { recursive: true, force: true }),
          rm(cacheRoot, { recursive: true, force: true }),
        ]);
      }
    }
  }
});

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
}, 30_000);
