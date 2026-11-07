import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { createServer as createViteServer, type Plugin, type ViteDevServer } from 'vite';
import { resolveWebViteConfig } from './support/vite-config';
import { shouldGenerateLocalization } from '../vite.config.ts';
import {
  bindViteDepCacheAlign,
  elysiaTypeboxLiveModuleCode,
  viteEnvironmentDepHashes,
  webViteClientOptimizeDepsFor,
  webViteTypeboxWorkerGraph,
  webViteWalkClientOptimizeDeps,
  webViteWarmSsrEnvName,
  webViteWorkerSsrOptimizeDeps,
  webViteWorkerSsrResolve,
} from './support/vite-dep-cache.ts';
import { createSettingsViteRuntime, settingsClientModuleGraph } from './support/settings-vite-runtime';
import {
  elysiaWorkerdTypebox,
  resolveElysiaFamilyImport,
  transformElysiaTypeboxLoader,
} from '../vite-elysia-typebox.ts';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(appRoot, '../..');
const workerInclude = [...webViteWorkerSsrOptimizeDeps.include];
const workerSelectorImport = 'use-sync-external-store/shim/with-selector';
const typeboxGraph = webViteTypeboxWorkerGraph;

function pluginNames(config: Awaited<ReturnType<typeof resolveWebViteConfig>>): string[] {
  return (config.plugins ?? [])
    .flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin]))
    .flatMap((plugin) =>
      plugin !== null && typeof plugin === 'object' && 'name' in plugin ? [String(plugin.name)] : [],
    );
}

function installedElysiaTypeFile(name: string): string {
  const require = createRequire(join(workspaceRoot, 'packages/client/package.json'));
  return realpathSync(join(dirname(require.resolve('elysia/package.json')), 'dist', 'type', name));
}

test('Worker Vite loads Elysia and Eden ESM and replaces TypeBox loaders with live re-exports', () => {
  const clientPackage = join(workspaceRoot, 'packages/client/package.json');
  const typeFile = installedElysiaTypeFile('typebox-type.mjs');
  const valueFile = installedElysiaTypeFile('typebox-value.mjs');
  const requireFile = installedElysiaTypeFile('typebox-value-require.mjs');
  const typeJs = installedElysiaTypeFile('typebox-type.js');
  const type = transformElysiaTypeboxLoader(readFileSync(typeFile, 'utf8'), typeFile);
  const value = transformElysiaTypeboxLoader(readFileSync(valueFile, 'utf8'), valueFile);
  const required = transformElysiaTypeboxLoader(readFileSync(requireFile, 'utf8'), requireFile);
  if (!type || !value || !required) throw new Error('Elysia TypeBox loaders were not rewritten');
  expect(type).toBe("export * from './typebox-type-live.mjs';\n");
  expect(value).toBe("export * from './typebox-value-live.mjs';\n");
  expect(required).toContain('requireTypebox = () => undefined');
  expect(required).not.toContain('require("./typebox-value-ops.mjs")');
  expect(transformElysiaTypeboxLoader(readFileSync(typeJs, 'utf8'), typeJs)).toBe(
    "export * from './typebox-type-live.mjs';\n",
  );
  expect(resolveElysiaFamilyImport('elysia', clientPackage)).toMatch(/\/elysia\/dist\/index\.mjs$/);
  expect(resolveElysiaFamilyImport('@elysia/eden', clientPackage)).toMatch(/\/@elysia\/eden\/dist\/index\.mjs$/);
  expect(resolveElysiaFamilyImport('elysia/type', clientPackage)).toMatch(/\/elysia\/dist\/type\/exports\.mjs$/);
  expect(resolveElysiaFamilyImport('react', clientPackage)).toBeNull();
  const plugin = elysiaWorkerdTypebox();
  expect(plugin.name).toBe('elysia-workerd-typebox');
  const resolveId = plugin.resolveId;
  const handler =
    typeof resolveId === 'function' ? resolveId : resolveId && 'handler' in resolveId ? resolveId.handler : undefined;
  if (typeof handler !== 'function') throw new Error('elysia-workerd-typebox is missing resolveId');
  expect(handler.call(undefined, 'elysia')).toMatch(/\/elysia\/dist\/index\.mjs$/);
});

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

test('test Worker bindings are startup-only and production has no fixture header path', async () => {
  const serverSource = readFileSync(join(appRoot, 'src/server.ts'), 'utf8');
  const bindingsSource = readFileSync(join(appRoot, 'src/test-runtime-bindings.ts'), 'utf8');
  const viteSource = readFileSync(join(appRoot, 'vite.config.ts'), 'utf8');
  expect(serverSource).not.toContain('x-rezics-test-env');
  expect(serverSource).not.toContain('readTestFixtureOverlay');
  expect(serverSource).not.toContain('./test-runtime-bindings.ts');
  expect(bindingsSource).toContain('__REZICS_TEST_WORKER_BINDINGS__');
  expect(bindingsSource).not.toContain('process.env');
  expect(bindingsSource).not.toContain('active');
  expect(bindingsSource).not.toContain('depth');
  expect(bindingsSource).not.toContain('request.headers');
  expect(viteSource).toContain('testWorkerBindingsEnvName');

  const previous = process.env.REZICS_TEST_RUNTIME;
  const previousBindings = process.env.WEB_TEST_WORKER_BINDINGS;
  try {
    delete process.env.REZICS_TEST_RUNTIME;
    const production = await resolveWebViteConfig({ command: 'build', mode: 'production' }, appRoot);
    expect(pluginNames(production)).not.toContain('rezics-test-env-bindings');
    expect(production.define).not.toHaveProperty('__REZICS_TEST_WORKER_BINDINGS__');

    process.env.REZICS_TEST_RUNTIME = '1';
    process.env.WEB_TEST_WORKER_BINDINGS = '{"KERNEL_ORIGIN":"https://test.example"}';
    const testRuntime = await resolveWebViteConfig({ command: 'serve', mode: 'test' }, appRoot);
    expect(testRuntime.optimizeDeps?.holdUntilCrawlEnd).toBe(false);
    expect(testRuntime.optimizeDeps?.entries).toEqual(['src/server.ts', 'src/session/routes.ts']);
    expect(pluginNames(testRuntime)).toContain('rezics-test-env-bindings');
    expect(testRuntime.define).not.toHaveProperty('__REZICS_TEST_WORKER_BINDINGS__');
    const plugins = (testRuntime.plugins ?? []).flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin]));
    const bindingsPlugin = plugins.find(
      (plugin) =>
        plugin !== null && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'rezics-test-env-bindings',
    );
    const bindingHooks = bindingsPlugin as
      | {
          applyToEnvironment?: (environment: { name: string }) => boolean;
          transform?:
            | ((this: unknown, code: string, id: string) => { code?: string } | undefined)
            | { handler: (this: unknown, code: string, id: string) => { code?: string } | undefined };
        }
      | undefined;
    const transformHook = bindingHooks?.transform;
    const applyToEnvironment = bindingHooks?.applyToEnvironment;
    const transform =
      typeof transformHook === 'function'
        ? transformHook
        : transformHook && 'handler' in transformHook
          ? transformHook.handler
          : undefined;
    expect(applyToEnvironment).toBeTypeOf('function');
    expect(applyToEnvironment?.({ name: 'ssr' })).toBe(true);
    expect(applyToEnvironment?.({ name: 'client' })).toBe(false);
    expect(typeof transform).toBe('function');
    const transformed = transform?.call(undefined, bindingsSource, join(appRoot, 'src/test-runtime-bindings.ts'));
    expect(transformed).toHaveProperty('code', expect.stringContaining('= {"KERNEL_ORIGIN":"https://test.example"};'));
  } finally {
    if (previous === undefined) delete process.env.REZICS_TEST_RUNTIME;
    else process.env.REZICS_TEST_RUNTIME = previous;
    if (previousBindings === undefined) delete process.env.WEB_TEST_WORKER_BINDINGS;
    else process.env.WEB_TEST_WORKER_BINDINGS = previousBindings;
  }
});

test('the real Settings browser graph transforms without loading the Worker fixture module', async () => {
  const runtime = await createSettingsViteRuntime(
    { KERNEL_ORIGIN: 'https://settings-browser.test' },
    [],
    { omitCloudflarePlugins: true },
  );
  try {
    const graph = await settingsClientModuleGraph(runtime, '/src/routes/settings.tsx');
    expect(graph.get('/src/routes/settings.tsx')?.status).toBe(200);
    expect([...graph.values()].every((module) => module.status === 200)).toBe(true);
    expect(graph.has('/src/settings/profile-model.ts')).toBe(true);
    expect(graph.has('/src/settings/adapters/accounts-browser.tsx')).toBe(true);
    expect(graph.has('/src/test-runtime-bindings.ts')).toBe(false);
  } finally {
    await runtime.close();
  }
}, 60_000);

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

test('WEB_VITE_CACHE_DIR selects the host-local optimizeDeps cache and allows reading it', async () => {
  const previous = process.env.WEB_VITE_CACHE_DIR;
  const previousRuntime = process.env.REZICS_TEST_RUNTIME;
  const previousSlot = process.env.REZICS_WALK_STACK_SLOT;
  const cacheDir = await mkdtemp(join(tmpdir(), 'rezics-web-vite-cache-config-'));
  process.env.WEB_VITE_CACHE_DIR = cacheDir;
  delete process.env.REZICS_TEST_RUNTIME;
  delete process.env.REZICS_WALK_STACK_SLOT;
  try {
    const config = await resolveWebViteConfig({ command: 'build', mode: 'test' }, appRoot);
    expect(config.cacheDir).toBe(cacheDir);
    expect(config.server?.fs?.allow).toContain(cacheDir);
    expect(config.optimizeDeps?.holdUntilCrawlEnd).toBe(true);
    expect(config.optimizeDeps?.entries).toEqual(['src/routes/**/*.tsx', 'src/server.ts', 'src/session/routes.ts']);
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
    const denied = plugins.find(
      (plugin) =>
        plugin !== null &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'worker-denied-dependencies',
    );
    expect(denied).toBeTruthy();
    expect(denied && 'enforce' in denied ? denied.enforce : undefined).toBe('pre');
    const align = plugins.find(
      (plugin) =>
        plugin !== null && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'web-vite-dep-cache-align',
    );
    expect(align).toBeTruthy();
    expect(align && 'enforce' in align ? align.enforce : undefined).toBe('pre');
    expect(pluginNames(config).at(0)).toBe('web-vite-dep-cache-align');
    const typebox = plugins.find(
      (plugin) =>
        plugin !== null && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'elysia-workerd-typebox',
    );
    expect(typebox).toBeTruthy();
    expect(typebox && 'enforce' in typebox ? typebox.enforce : undefined).toBe('pre');
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
    expect(environment?.optimizeDeps?.include).toEqual(workerInclude);
    expect(environmentFor('client')).toBeUndefined();
    const resolved = worker && 'configResolved' in worker ? worker.configResolved : undefined;
    const pin =
      typeof resolved === 'function' ? resolved : resolved && 'handler' in resolved ? resolved.handler : undefined;
    const environments = {
      ssr: {
        resolve: { alias: [] as unknown[] },
        optimizeDeps: { noDiscovery: false, entries: ['src/server.ts'], include: ['cloudflare-discovered'] },
      },
    };
    if (typeof pin === 'function')
      pin.call(undefined, { resolve: { alias: [] }, ssr: { resolve: { alias: [] } }, environments });
    expect(environments.ssr.optimizeDeps.noDiscovery).toBe(true);
    expect(environments.ssr.optimizeDeps.entries).toEqual([]);
    expect(environments.ssr.optimizeDeps.include).toEqual(environment?.optimizeDeps?.include);
  } finally {
    if (previous === undefined) delete process.env.WEB_VITE_CACHE_DIR;
    else process.env.WEB_VITE_CACHE_DIR = previous;
    if (previousRuntime === undefined) delete process.env.REZICS_TEST_RUNTIME;
    else process.env.REZICS_TEST_RUNTIME = previousRuntime;
    if (previousSlot === undefined) delete process.env.REZICS_WALK_STACK_SLOT;
    else process.env.REZICS_WALK_STACK_SLOT = previousSlot;
    await rm(cacheDir, { recursive: true, force: true });
  }
}, 30_000);

test('native interactive serve does not hold listening on a full route dependency crawl', async () => {
  const previousRuntime = process.env.REZICS_TEST_RUNTIME;
  const previousSlot = process.env.REZICS_WALK_STACK_SLOT;
  const previousCache = process.env.WEB_VITE_CACHE_DIR;
  delete process.env.REZICS_TEST_RUNTIME;
  delete process.env.REZICS_WALK_STACK_SLOT;
  delete process.env.WEB_VITE_CACHE_DIR;
  try {
    const config = await resolveWebViteConfig({ command: 'serve', mode: 'development' }, appRoot);
    expect(webViteClientOptimizeDepsFor({}, 'serve')).toEqual(webViteWalkClientOptimizeDeps);
    expect(config.optimizeDeps?.entries).toEqual([]);
    expect(config.optimizeDeps?.holdUntilCrawlEnd).toBe(false);
    expect(pluginNames(config).some((name) => name.includes('paraglide'))).toBe(true);
    expect(pluginNames(config)).not.toContain('rezics-test-env-bindings');
    expect(pluginNames(config)).toContain('web-startup-evidence');
  } finally {
    if (previousRuntime === undefined) delete process.env.REZICS_TEST_RUNTIME;
    else process.env.REZICS_TEST_RUNTIME = previousRuntime;
    if (previousSlot === undefined) delete process.env.REZICS_WALK_STACK_SLOT;
    else process.env.REZICS_WALK_STACK_SLOT = previousSlot;
    if (previousCache === undefined) delete process.env.WEB_VITE_CACHE_DIR;
    else process.env.WEB_VITE_CACHE_DIR = previousCache;
  }
});

test('a walk stack compiles the visited client page on demand instead of crawling every route', async () => {
  const previousSlot = process.env.REZICS_WALK_STACK_SLOT;
  const previousCache = process.env.WEB_VITE_CACHE_DIR;
  const previousRuntime = process.env.REZICS_TEST_RUNTIME;
  process.env.REZICS_WALK_STACK_SLOT = '2';
  delete process.env.WEB_VITE_CACHE_DIR;
  delete process.env.REZICS_TEST_RUNTIME;
  try {
    expect(webViteClientOptimizeDepsFor({ REZICS_WALK_STACK_SLOT: '2' })).toEqual(webViteWalkClientOptimizeDeps);
    expect(webViteWalkClientOptimizeDeps.holdUntilCrawlEnd).toBe(false);
    expect(webViteWalkClientOptimizeDeps.entries).toEqual([]);
    const config = await resolveWebViteConfig({ command: 'serve', mode: 'development' }, appRoot);
    expect(config.optimizeDeps?.holdUntilCrawlEnd).toBe(false);
    expect(config.optimizeDeps?.entries).toEqual([]);
    expect(config.cacheDir).toBe(resolve(workspaceRoot, '.temp/web-vite', '2'));
  } finally {
    if (previousSlot === undefined) delete process.env.REZICS_WALK_STACK_SLOT;
    else process.env.REZICS_WALK_STACK_SLOT = previousSlot;
    if (previousCache === undefined) delete process.env.WEB_VITE_CACHE_DIR;
    else process.env.WEB_VITE_CACHE_DIR = previousCache;
    if (previousRuntime === undefined) delete process.env.REZICS_TEST_RUNTIME;
    else process.env.REZICS_TEST_RUNTIME = previousRuntime;
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
    const aliases = config.environments?.ssr?.resolve?.alias;
    const typeboxAlias = Array.isArray(aliases)
      ? aliases.find(
          (entry) =>
            entry && typeof entry === 'object' && 'find' in entry && entry.find === typeboxGraph.first.specifier,
        )
      : undefined;
    expect(typeboxAlias && 'replacement' in typeboxAlias ? typeboxAlias.replacement : undefined).toBe(
      typeboxGraph.first.resolved,
    );
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

test('Vite serves resolved workspace dependencies while keeping files outside its roots denied', async () => {
  // This is a build-time config inspection, not a fixture runtime, so it does not allocate Worker persistence.
  const config = await resolveWebViteConfig({ command: 'build', mode: 'test' }, appRoot);
  const dependencyFile = realpathSync(join(appRoot, 'node_modules/@tanstack/react-start/dist/esm/index.js'));
  const allow = config.server?.fs?.allow ?? [];
  expect(allow).toContain(workspaceRoot);
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

test('the Worker TypeBox stubs load live ESM from the installed Elysia files', async () => {
  const config = await resolveWebViteConfig({ command: 'serve', mode: 'test' }, appRoot);
  const plugins = (config.plugins ?? []).flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin]));
  const typebox = plugins.find(
    (plugin) =>
      plugin !== null && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'web-worker-typebox-esm',
  ) as
    | {
        applyToEnvironment?: (environment: { name: string }) => boolean;
        load?: ((id: string) => unknown) | { handler: (id: string) => unknown };
      }
    | undefined;
  const load = typeof typebox?.load === 'function' ? typebox.load : typebox?.load?.handler;
  expect(typebox).toBeDefined();
  expect(typebox?.applyToEnvironment?.({ name: 'ssr' })).toBe(true);
  expect(typebox?.applyToEnvironment?.({ name: 'client' })).toBe(false);
  const rewritten = load?.(typeboxGraph.first.importer) as { code?: string } | string | undefined;
  const code = typeof rewritten === 'string' ? rewritten : rewritten?.code;
  expect(code).toBe(elysiaTypeboxLiveModuleCode(typeboxGraph.first.importer));
  expect(code).toContain('typebox-type-live.mjs');
});

test('the Worker selector dependency resolves to ESM while the client keeps the package implementation', async () => {
  const config = await resolveWebViteConfig({ command: 'serve', mode: 'test' }, appRoot);
  const plugins = (config.plugins ?? []).flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin]));
  const selector = plugins.find(
    (plugin) =>
      plugin !== null && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'web-worker-selector-esm',
  ) as
    | {
        applyToEnvironment?: (environment: { name: string }) => boolean;
        resolveId?: ((id: string) => unknown) | { handler: (id: string) => unknown };
      }
    | undefined;
  const resolveId = typeof selector?.resolveId === 'function' ? selector.resolveId : selector?.resolveId?.handler;

  expect(selector).toBeDefined();
  expect(selector?.applyToEnvironment?.({ name: 'ssr' })).toBe(true);
  expect(selector?.applyToEnvironment?.({ name: 'client' })).toBe(false);
  expect(resolveId?.(workerSelectorImport)).toBe(join(appRoot, 'src/kernel/use-sync-external-store-with-selector.ts'));
});

test('SSR optimizeDeps keeps explicit Worker include, noDiscovery, calendar excludes and ESM polyfill alias', async () => {
  // Cloudflare's TypeScript config loader requires Node, as used by the real Vite CLI.
  const result = Bun.spawnSync({
    cmd: [
      'node',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { resolve } from 'node:path';
        import { resolveConfig } from 'vite';
        const workerInclude = ${JSON.stringify(workerInclude)};
        const calendar = ['react-day-picker', 'date-fns', '@date-fns/tz'];
        const typebox = ${JSON.stringify({
          specifier: typeboxGraph.first.specifier,
          importer: typeboxGraph.first.importer,
          resolved: typeboxGraph.first.resolved,
        })};
        for (const command of ['serve', 'build']) {
          const config = await resolveConfig({ logLevel: 'silent' }, command, 'development');
          const targets = [['ssr', config.ssr.optimizeDeps]];
          for (const [name, environment] of Object.entries(config.environments)) {
            if (name === 'client') continue;
            targets.push([name, environment.optimizeDeps]);
          }
          for (const [name, optimizeDeps] of targets) {
            assert.equal(optimizeDeps.noDiscovery, true, command + ':' + name + ':no-discovery');
            assert.deepEqual(
              optimizeDeps.include ?? [],
              workerInclude,
              command + ':' + name + ':explicit-include',
            );
            for (const pkg of ['urlpattern-polyfill', 'react-day-picker', 'date-fns'])
              assert.equal(
                (optimizeDeps.include ?? []).includes(pkg),
                false,
                command + ':' + name + ':without:' + pkg,
              );
            assert.ok(
              (optimizeDeps.include ?? []).includes('react-dom/server.edge'),
              command + ':' + name + ':worker-server-entry',
            );
            assert.ok(
              (optimizeDeps.include ?? []).includes('react-dom/server'),
              command + ':' + name + ':server-entry',
            );
            assert.ok(
              (optimizeDeps.include ?? []).includes(typebox.specifier),
              command + ':' + name + ':typebox-export',
            );
            for (const pkg of ['react', 'react-dom', 'react-dom/server'])
              assert.equal(
                (optimizeDeps.exclude ?? []).includes(pkg),
                false,
                command + ':' + name + ':not-excluded:' + pkg,
              );
            for (const pkg of calendar)
              assert.ok((optimizeDeps.exclude ?? []).includes(pkg), command + ':' + name + ':' + pkg);
          }
          const resolvers = [['root', config.resolve]];
          if (config.ssr.resolve) resolvers.push(['ssr', config.ssr.resolve]);
          for (const [name, environment] of Object.entries(config.environments)) {
            if (name === 'client') continue;
            resolvers.push([name, environment.resolve]);
          }
          for (const [name, resolveAlias] of resolvers) {
            const entries = Array.isArray(resolveAlias.alias) ? resolveAlias.alias : [];
            const mapped = entries.find((entry) => entry && entry.find === 'urlpattern-polyfill');
            assert.ok(mapped, command + ':' + name + ':urlpattern-polyfill alias');
            assert.equal(String(mapped.replacement).endsWith('index.cjs'), false, command + ':' + name + ':esm');
            assert.ok(String(mapped.replacement).endsWith('index.js'), command + ':' + name + ':' + mapped.replacement);
            const typeboxAlias = entries.find((entry) => entry && entry.find === typebox.specifier);
            assert.ok(typeboxAlias, command + ':' + name + ':typebox-alias');
            assert.equal(typeboxAlias.replacement, typebox.resolved, command + ':' + name + ':typebox-export-file');
            assert.equal(
              String(typeboxAlias.replacement).includes('elysia/dist/type/typebox/'),
              false,
              command + ':' + name + ':not-relative-elysia',
            );
            if (name !== 'root')
              assert.equal(
                (resolveAlias.conditions ?? [])[0] === 'import',
                false,
                command + ':' + name + ':workerd-conditions',
              );
          }
          const resolveId = config.createResolver();
          const fromApp = await resolveId(typebox.specifier, resolve('src/server.ts'), false, true);
          const fromElysia = await resolveId(typebox.specifier, typebox.importer, false, true);
          assert.equal(fromApp, typebox.resolved, command + ':app-typebox-export');
          assert.equal(fromElysia, typebox.resolved, command + ':workspace-typebox-export');
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

test('serve skips Paraglide generate under test runtime unless a compiler module is supplied', () => {
  expect(shouldGenerateLocalization({ REZICS_TEST_RUNTIME: '1' })).toBe(false);
  expect(
    shouldGenerateLocalization({ REZICS_TEST_RUNTIME: '1', REZICS_PARAGLIDE_COMPILER_MODULE: '/tmp/compiler.mjs' }),
  ).toBe(true);
  expect(shouldGenerateLocalization({})).toBe(true);
});

test('vite.config identity stays Node-loadable without Bun process custody', () => {
  const source = readFileSync(join(appRoot, 'vite.config.ts'), 'utf8');
  expect(source).toContain("from './tests/support/vite-dep-cache.ts'");
  expect(source).not.toContain('vite-dep-cache-build');
  expect(source).not.toContain('server-custody');
  expect(source).not.toMatch(/from ['"]bun:/);
});
