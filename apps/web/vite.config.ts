import { viteNonceMarker } from './src/security/headers.ts';
import { testFixtureEnvHeader } from './src/test-fixture-header.ts';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { createWorkerPersistence } from '../../scripts/worker-persistence.ts';
import { messagesCurrent } from './scripts/messages-ready.ts';
import { readWorkerFixtureOverlay } from './tests/support/dev-server-fixture.ts';
import {
  alignViteLockfileHashes,
  bindViteDepCacheAlign,
  webViteClientOptimizeDeps,
  webViteWarmSsrEnvName,
  webViteWorkerSsrEnvironment,
  webViteWorkerSsrOptimizeDeps,
  type ViteDepCacheAlignEnvironment,
} from './tests/support/vite-dep-cache.ts';

const configuredInspectorPort = process.env.WORKER_INSPECTOR_PORT;
const nativeWebHost = process.env.NATIVE_WEB_TEST_HOST;
const nativeWebCertificate = process.env.NATIVE_WEB_TEST_TLS_CERT;
const nativeWebKey = process.env.NATIVE_WEB_TEST_TLS_KEY;
const nativeWebTls = Boolean(nativeWebHost || nativeWebCertificate || nativeWebKey);
if (nativeWebTls && (nativeWebHost !== 'web.native.rezics.com' || !nativeWebCertificate || !nativeWebKey))
  throw new Error('Native web TLS requires the reserved host and its test certificate');
const appRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(appRoot, '../..');
const testRuntimeBindings = fileURLToPath(new URL('./src/test-runtime-bindings.ts', import.meta.url));
const paraglideGenerateLock = join(workspaceRoot, '.temp/paraglide-generate.lock');
const workerSsrOptimizeDeps = webViteWorkerSsrOptimizeDeps;

function bunInstallRoot(resolved: string): string | undefined {
  const marker = `${sep}node_modules${sep}.bun${sep}`;
  const index = resolved.indexOf(marker);
  if (index === -1) return undefined;
  return resolved.slice(0, index + `${sep}node_modules`.length);
}

function resolvedInstallRoots(): string[] {
  const roots = new Set<string>();
  for (const candidate of [
    join(workspaceRoot, 'node_modules'),
    join(appRoot, 'node_modules'),
    join(appRoot, 'node_modules/@tanstack/react-start'),
    ...['manrope', 'source-serif-4', 'geist-mono'].map((name) =>
      join(appRoot, 'node_modules', '@fontsource-variable', name),
    ),
  ]) {
    try {
      const resolved = realpathSync(candidate);
      roots.add(resolved);
      const store = bunInstallRoot(resolved);
      if (store) roots.add(store);
    } catch {
      // A missing optional package must not block config load.
    }
  }
  return [...roots];
}

function containedWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Bun's linker places packages under a shared store; the node_modules directory itself stays in the checkout. */
function linkedDependencyAllow(packageRealPath: string): string | undefined {
  const marker = `${sep}.bun${sep}`;
  const index = packageRealPath.indexOf(marker);
  const root = index === -1 ? packageRealPath : packageRealPath.slice(0, index);
  return containedWithin(workspaceRoot, root) ? undefined : root;
}

const dependencyRoots = resolvedInstallRoots();
const linkedDependencyRoot = linkedDependencyAllow(
  realpathSync(join(appRoot, 'node_modules/@tanstack/react-start')),
);

/**
 * Generated paraglide/runtime.js imports `@inlang/paraglide-js/urlpattern-polyfill`, which re-exports
 * `urlpattern-polyfill`. Workerd export-type inspection resolves with workerd/worker/module/browser,
 * not `import`/`require`. That package's exports then miss and Node `main` loads CJS `index.cjs`.
 * `runInRunnerObject` has no `module`, so evaluating that CJS throws `module is not defined`.
 * Adding `import` to those conditions hung Rolldown before Copies printed ready.
 *
 * Host-b evidence: Worker discovery printed `(ssr) [optimizer] scanning dependencies...` and then
 * nothing for 150s. Empty include plus `noDiscovery` printed no Vite line at all. The composition
 * that reaches ready is Web's host-local optimizeDeps cache plus Worker `noDiscovery` with an
 * explicit React/TanStack/paraglide include. Leave `urlpattern-polyfill` and `react-dom/server`
 * off include: the nested package is resolved to ESM, and `react-dom/server` stays on Vite's
 * transform path. Calendar packages stay excluded.
 */
const webRequire = createRequire(import.meta.url);
const paraglideRequire = createRequire(webRequire.resolve('@inlang/paraglide-js'));
const urlpatternPolyfillCjs = paraglideRequire.resolve('urlpattern-polyfill');
const urlpatternPolyfillDir = dirname(urlpatternPolyfillCjs);
const urlpatternPolyfillEsm = join(urlpatternPolyfillDir, 'index.js');
const urlpatternPolyfillDistEsm = join(urlpatternPolyfillDir, 'dist/urlpattern.js');
const urlpatternPolyfillAlias = { find: 'urlpattern-polyfill', replacement: urlpatternPolyfillEsm } as const;
const urlpatternPolyfillId = /urlpattern-polyfill/;

function filePathOf(id: string): string {
  return (id.split('?')[0] ?? id).replace(/\\/g, '/');
}

function urlpatternPolyfillReplacement(id: string): string | undefined {
  const path = filePathOf(id);
  if (
    id === 'urlpattern-polyfill' ||
    path === urlpatternPolyfillCjs.replace(/\\/g, '/') ||
    path === urlpatternPolyfillEsm.replace(/\\/g, '/') ||
    path.endsWith('/urlpattern-polyfill/index.cjs') ||
    path.endsWith('/urlpattern-polyfill/index.js')
  ) {
    return urlpatternPolyfillEsm;
  }
  if (
    id === 'urlpattern-polyfill/urlpattern' ||
    path.endsWith('/urlpattern-polyfill/dist/urlpattern.cjs') ||
    path.endsWith('/urlpattern-polyfill/dist/urlpattern.js')
  ) {
    return urlpatternPolyfillDistEsm;
  }
  return undefined;
}

function pinUrlpatternAlias(resolveConfig: { alias?: unknown }): void {
  const alias = resolveConfig.alias;
  if (Array.isArray(alias)) {
    const next = alias.filter(
      (entry) => !(entry && typeof entry === 'object' && 'find' in entry && entry.find === 'urlpattern-polyfill'),
    );
    next.unshift(urlpatternPolyfillAlias);
    alias.length = 0;
    alias.push(...next);
    return;
  }
  if (alias && typeof alias === 'object') {
    (alias as Record<string, string>)['urlpattern-polyfill'] = urlpatternPolyfillEsm;
    return;
  }
  resolveConfig.alias = [urlpatternPolyfillAlias];
}

function looksLikeCjs(id: string, code: string): boolean {
  const path = filePathOf(id);
  if (path.endsWith('.mjs') || path.endsWith('.mts')) return false;
  if (path.endsWith('.cjs') || path.endsWith('.cts')) return true;
  if (/\b(?:import\s|export\s)/.test(code)) return false;
  return /\bmodule\.exports\b/.test(code) || /\bexports\.\w+\s*=/.test(code);
}

function workerCjsShim(code: string): string {
  return `const module = { exports: {} }; const exports = module.exports;\n${code}\nexport default module.exports;\n`;
}

function pinWorkerSsrOptimizeDeps(environment?: { optimizeDeps?: Record<string, unknown> }): void {
  if (!environment) return;
  environment.optimizeDeps = {
    ...environment.optimizeDeps,
    ...workerSsrOptimizeDeps,
    include: [...workerSsrOptimizeDeps.include],
    exclude: [...workerSsrOptimizeDeps.exclude],
    entries: [],
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withParaglideGenerateLock(run: () => Promise<void>): Promise<void> {
  mkdirSync(join(workspaceRoot, '.temp'), { recursive: true });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(paraglideGenerateLock);
      writeFileSync(join(paraglideGenerateLock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = 0;
      try {
        holder = Number.parseInt(readFileSync(join(paraglideGenerateLock, 'pid'), 'utf8'), 10);
      } catch {
        holder = 0;
      }
      if (!Number.isInteger(holder) || holder <= 0 || !processExists(holder)) {
        rmSync(paraglideGenerateLock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Paraglide generate lock timed out');
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  try {
    await run();
  } finally {
    rmSync(paraglideGenerateLock, { recursive: true, force: true });
  }
}

export function shouldGenerateLocalization(env: NodeJS.ProcessEnv = process.env): boolean {
  // Isolated tests already ran generate.ts. A custom compiler module is the localization-startup seam.
  return env.REZICS_TEST_RUNTIME !== '1' || Boolean(env.REZICS_PARAGLIDE_COMPILER_MODULE);
}

let inspectorPort: number | false = false;
if (configuredInspectorPort !== undefined) {
  const parsedInspectorPort = Number(configuredInspectorPort);
  if (
    !/^\d+$/.test(configuredInspectorPort) ||
    !Number.isInteger(parsedInspectorPort) ||
    parsedInspectorPort < 1 ||
    parsedInspectorPort > 65535
  ) {
    throw new Error(
      `WORKER_INSPECTOR_PORT must be an integer from 1 to 65535; received ${JSON.stringify(configuredInspectorPort)}`,
    );
  }
  inspectorPort = parsedInspectorPort;
}

/** The Cloudflare plugin denies every dependency of cloudflare.config.ts to browser file serving. The site Worker
 * imports one of those dependencies, so only the Worker environment may load them from disk. The browser
 * environment keeps the deny list, and the loaded file stays watched. */
function workerDeniedDependencies(): Plugin {
  let denied = new Set<string>();
  return {
    name: 'worker-denied-dependencies',
    enforce: 'post',
    configResolved(resolved) {
      denied = new Set(resolved.server.fs.deny.filter((entry) => isAbsolute(entry)));
    },
    load(id) {
      const file = id.split('?', 1)[0]!;
      if (this.environment.name !== 'ssr' || !denied.has(file)) return null;
      this.addWatchFile(file);
      return readFileSync(file, 'utf8');
    },
  };
}

export default defineConfig((context) => {
  const viteCacheDir = process.env.WEB_VITE_CACHE_DIR;
  if (viteCacheDir) alignViteLockfileHashes(viteCacheDir, appRoot);
  if (process.env[webViteWarmSsrEnvName] === '1') {
    return {
      ...(viteCacheDir ? { cacheDir: viteCacheDir } : {}),
      ssr: { target: 'webworker', noExternal: true },
      environments: { ssr: webViteWorkerSsrEnvironment },
      resolve: { alias: [urlpatternPolyfillAlias] },
      optimizeDeps: { noDiscovery: true, include: [] },
    };
  }
  const persistence = createWorkerPersistence('web', context, appRoot);
  const testRuntime = process.env.REZICS_TEST_RUNTIME === '1';
  return {
    ...(viteCacheDir ? { cacheDir: viteCacheDir } : {}),
    server: {
      // The native stack binds 127.0.0.1 in an isolated network; publication tests prove a foreign Host never reaches page URLs.
      allowedHosts: process.env.WEB_DEV_ALLOW_ANY_HOST === '1' ? true : [],
      ...(nativeWebTls ? { https: { cert: nativeWebCertificate!, key: nativeWebKey! } } : {}),
      // Shared dependency stores can resolve package files outside the checkout's lexical node_modules path.
      fs: {
        allow: [
          workspaceRoot,
          ...dependencyRoots,
          ...(linkedDependencyRoot ? [linkedDependencyRoot] : []),
          ...(viteCacheDir ? [resolve(viteCacheDir)] : []),
        ],
      },
    },
    html: { cspNonce: viteNonceMarker },
    resolve: { alias: [urlpatternPolyfillAlias] },
    // Fonts must stay on the site origin; the page policy does not allow data: fonts.
    build: { assetsInlineLimit: 0 },
    optimizeDeps: {
      ...webViteClientOptimizeDeps,
    },
    ssr: {
      resolve: { alias: [urlpatternPolyfillAlias] },
      optimizeDeps: {
        ...workerSsrOptimizeDeps,
        include: [...workerSsrOptimizeDeps.include],
        exclude: [...workerSsrOptimizeDeps.exclude],
      },
    },
    plugins: [
      {
        name: 'urlpattern-polyfill-esm',
        enforce: 'pre',
        resolveId: {
          filter: { id: urlpatternPolyfillId },
          handler(id) {
            return urlpatternPolyfillReplacement(id);
          },
        },
        load: {
          filter: { id: urlpatternPolyfillId },
          handler(id) {
            const replacement = urlpatternPolyfillReplacement(id);
            if (!replacement) return;
            if (filePathOf(id) === replacement.replace(/\\/g, '/')) return;
            return readFileSync(replacement, 'utf8');
          },
        },
      },
      {
        // Workerd's runner eval has no `module`. CJS that still reaches this environment is named
        // here so the executing file is in the Vite log, then wrapped so inspection can finish.
        name: 'worker-cjs-eval-shim',
        applyToEnvironment(environment) {
          return environment.name !== 'client';
        },
        transform: {
          filter: { code: /\bmodule\.exports\b|\bexports\.\w+\s*=/ },
          handler(code, id) {
            if (!looksLikeCjs(id, code)) return;
            console.error(`[worker-cjs] ${id}`);
            return { code: workerCjsShim(code), map: null };
          },
        },
      },
      ...(viteCacheDir
        ? [
            {
              name: 'web-vite-dep-cache-align',
              configureServer(server: { environments: Record<string, ViteDepCacheAlignEnvironment | undefined> }) {
                return bindViteDepCacheAlign(viteCacheDir, server.environments);
              },
            },
          ]
        : []),
      ...(testRuntime
        ? [
            {
              name: 'rezics-test-fixture-env',
              configureServer(server: {
                middlewares: {
                  use: (
                    handler: (req: { headers: Record<string, unknown> }, res: unknown, next: () => void) => void,
                  ) => void;
                };
              }) {
                const directory = process.env.WEB_TEST_STATE_DIR;
                if (!directory) return;
                server.middlewares.use((req, _res, next) => {
                  const overlay = readWorkerFixtureOverlay(directory);
                  if (overlay) req.headers[testFixtureEnvHeader] = JSON.stringify(overlay);
                  next();
                });
              },
            },
            {
              name: 'rezics-test-env-bindings',
              enforce: 'pre' as const,
              transform(code: string, id: string) {
                if (id.includes('test-runtime-bindings')) return;
                if (!code.includes("from 'cloudflare:workers'")) return;
                return {
                  code: code.replaceAll("from 'cloudflare:workers'", `from ${JSON.stringify(testRuntimeBindings)}`),
                  map: null,
                };
              },
            },
          ]
        : []),
      {
        name: 'generate-localization',
        async config(_config, { command }) {
          // Isolated tests already compiled catalogues. A check or `bun run generate` that already
          // compiled current catalogues is reused, so a cold start compiles them once.
          if (command !== 'serve' || !shouldGenerateLocalization() || messagesCurrent(appRoot)) return;
          await withParaglideGenerateLock(
            () =>
              new Promise<void>((resolveGenerate, reject) => {
                const child = spawn('bun', ['scripts/generate.ts'], { stdio: 'inherit' });
                child.once('error', reject);
                child.once('exit', (code, signal) => {
                  if (code === 0) resolveGenerate();
                  else reject(new Error(`Paraglide generation exited with ${signal ?? code}`));
                });
              }),
          );
        },
      },
      paraglideVitePlugin({ project: './project.inlang' }),
      tanstackStart(),
      react(),
      tailwindcss(),
      ...cloudflare({
        viteEnvironment: { name: 'ssr' },
        inspectorPort,
        remoteBindings: false,
        ...(persistence.directory ? { persistState: { path: persistence.directory } } : {}),
      }),
      ...(persistence.cleanupPlugin ? [persistence.cleanupPlugin] : []),
      {
        // Cloudflare's config hook enables discovery from the Worker entry. mergeConfig concatenates `entries`, so a
        // later configEnvironment cannot remove that crawl. Pin the resolved Worker optimizer after plugin merge.
        name: 'web-worker-explicit-dependencies',
        enforce: 'post' as const,
        config() {
          return {
            resolve: { alias: [urlpatternPolyfillAlias] },
            environments: { ssr: { optimizeDeps: { ...workerSsrOptimizeDeps, entries: [] } } },
          };
        },
        configEnvironment(name: string) {
          if (name === 'client') return;
          return {
            resolve: { alias: [urlpatternPolyfillAlias] },
            optimizeDeps: { ...workerSsrOptimizeDeps, entries: [] },
          };
        },
        configResolved(config: {
          resolve: { alias?: unknown };
          ssr: { resolve?: { alias?: unknown }; optimizeDeps?: Record<string, unknown> };
          environments?: Record<string, { resolve: { alias?: unknown }; optimizeDeps?: Record<string, unknown> }>;
        }) {
          pinUrlpatternAlias(config.resolve);
          if (!config.ssr.resolve) config.ssr.resolve = {};
          pinUrlpatternAlias(config.ssr.resolve);
          pinWorkerSsrOptimizeDeps(config.ssr);
          for (const [name, environment] of Object.entries(config.environments ?? {})) {
            if (name === 'client') continue;
            pinUrlpatternAlias(environment.resolve);
            pinWorkerSsrOptimizeDeps(environment);
          }
        },
      },
      workerDeniedDependencies(),
    ],
  };
});
