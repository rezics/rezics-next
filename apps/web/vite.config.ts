import { viteNonceMarker } from './src/security/headers.ts';
import { testWorkerBindingsEnvName } from './src/test-runtime-binding-config.ts';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { createWorkerPersistence } from '../../scripts/worker-persistence.ts';
import { ensureMessagesReady } from './scripts/messages-ready.ts';
import {
  alignViteLockfileHashes,
  bindViteDepCacheAlign,
  elysiaTypeboxLiveModuleCode,
  webViteClientOptimizeDepsFor,
  webViteTypeboxWorkerGraph,
  webViteWarmSsrEnvName,
  webViteWorkerSsrEnvironment,
  webViteWorkerSsrOptimizeDeps,
  type ViteDepCacheAlignEnvironment,
  type ViteWorkerResolveAlias,
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
const workerSsrOptimizeDeps = webViteWorkerSsrOptimizeDeps;

function bunInstallRoot(resolved: string): string | undefined {
  const marker = `${sep}node_modules${sep}.bun${sep}`;
  const index = resolved.indexOf(marker);
  if (index === -1) return undefined;
  return resolved.slice(0, index + `${sep}node_modules`.length);
}

function isWithinRoot(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function packageRootOf(resolved: string, name: string): string {
  const needle = `${sep}node_modules${sep}${name.replaceAll('/', sep)}`;
  const index = resolved.lastIndexOf(needle);
  if (index !== -1) return resolved.slice(0, index + needle.length);
  let current = resolved;
  for (;;) {
    try {
      const listed = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as { name?: string };
      if (listed.name === name) return current;
    } catch {
      // Walk toward the filesystem root until the named package directory is found.
    }
    const parent = dirname(current);
    if (parent === current) return dirname(resolved);
    current = parent;
  }
}

function resolveInstalledPackage(name: string, fromFile: string): string | undefined {
  const require = createRequire(fromFile);
  for (const specifier of [name, `${name}/package.json`]) {
    try {
      return realpathSync(require.resolve(specifier));
    } catch {
      // Package exports may hide the specifier.
    }
  }
  for (const directory of require.resolve.paths(name) ?? []) {
    try {
      return realpathSync(join(directory, name));
    } catch {
      // This lookup path does not contain the package.
    }
  }
}

function minimizeFsRoots(roots: Iterable<string>): string[] {
  const unique = [...new Set(roots)].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const kept: string[] = [];
  for (const root of unique) {
    if (kept.some((parent) => isWithinRoot(parent, root))) continue;
    kept.push(root);
  }
  return kept;
}

function installedPackageNames(): string[] {
  const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      '@tanstack/react-start',
      'vite',
      'react',
      'react-dom',
    ]),
  ];
}

/** Smallest directories that cover the packages Vite's client and Worker actually resolve. */
function resolvedInstallRoots(): string[] {
  const roots = new Set<string>();
  const admit = (root: string) => {
    if (!isWithinRoot(workspaceRoot, root)) roots.add(root);
  };
  for (const from of [appRoot, workspaceRoot]) {
    try {
      admit(realpathSync(join(from, 'node_modules')));
    } catch {
      // A missing optional install directory must not block config load.
    }
    const fromFile = join(from, 'package.json');
    for (const name of installedPackageNames()) {
      const resolved = resolveInstalledPackage(name, fromFile);
      if (!resolved) continue;
      admit(bunInstallRoot(resolved) ?? packageRootOf(resolved, name));
    }
  }
  return minimizeFsRoots(roots);
}

const dependencyRoots = resolvedInstallRoots();

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
 * explicit React/TanStack/paraglide include. Every CommonJS package the Worker graph reaches must be listed here or
 * replaced at load, since a served CommonJS module fails Worker inspection with `require is not defined`. A graph walk
 * found `react-dom/server` (app source imports it; under the Worker conditions it resolves to `server.edge.js`),
 * `satori/standalone`, and Puck's `flat` and `object-hash`, which are nested under `@puckeditor/core` because they are
 * not resolvable from the app root. TipTap imports the `use-sync-external-store` shim files by path, so the selector
 * plugin replaces them at load. That plugin must run before the denied-dependency loader, which returns raw contents.
 * Calendar packages stay excluded.
 */
const webRequire = createRequire(import.meta.url);
const paraglideRequire = createRequire(webRequire.resolve('@inlang/paraglide-js'));
const urlpatternPolyfillCjs = paraglideRequire.resolve('urlpattern-polyfill');
const urlpatternPolyfillDir = dirname(urlpatternPolyfillCjs);
const urlpatternPolyfillEsm = join(urlpatternPolyfillDir, 'index.js');
const urlpatternPolyfillDistEsm = join(urlpatternPolyfillDir, 'dist/urlpattern.js');
const urlpatternPolyfillAlias = { find: 'urlpattern-polyfill', replacement: urlpatternPolyfillEsm } as const;
const workerResolveAliases: ViteWorkerResolveAlias[] = [urlpatternPolyfillAlias, ...webViteTypeboxWorkerGraph.aliases];
const urlpatternPolyfillId = /urlpattern-polyfill/;
const typeboxBareSpecifierId = /^typebox(?:\/|$)/;
const workerSelectorImport = 'use-sync-external-store/shim/with-selector';
const workerSelectorShimPath = join(appRoot, 'src/kernel/use-sync-external-store-with-selector.ts');
const typeboxAliasByFind = new Map(webViteTypeboxWorkerGraph.aliases.map((alias) => [alias.find, alias.replacement]));

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

function pinWorkerResolveAliases(resolveConfig: { alias?: unknown }): void {
  const finds = new Set(workerResolveAliases.map((entry) => entry.find));
  const alias = resolveConfig.alias;
  if (Array.isArray(alias)) {
    const next = alias.filter(
      (entry) => !(entry && typeof entry === 'object' && 'find' in entry && finds.has(String(entry.find))),
    );
    next.unshift(...workerResolveAliases);
    alias.length = 0;
    alias.push(...next);
    return;
  }
  if (alias && typeof alias === 'object') {
    const record = alias as Record<string, string>;
    for (const entry of workerResolveAliases) record[entry.find] = entry.replacement;
    return;
  }
  resolveConfig.alias = [...workerResolveAliases];
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
 * imports one of those dependencies as `/src/...` module ids, which are not the absolute deny paths, so the
 * Worker load has to map those ids back onto the denied files. The browser environment keeps the deny list. */
function workerDeniedDependencies(): Plugin {
  let denied = new Set<string>();
  const deniedFile = (id: string): string | undefined => {
    const file = id.split('?', 1)[0]!;
    const candidates = [
      file,
      isAbsolute(file) ? file : resolve(appRoot, file.replace(/^\//, '')),
      file.startsWith('/src/') ? join(appRoot, file.slice(1)) : undefined,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (denied.has(candidate)) return candidate;
      try {
        const real = realpathSync(candidate);
        if (denied.has(real)) return real;
      } catch {
        // The id is not a readable path; try the next candidate.
      }
    }
    return undefined;
  };
  return {
    name: 'worker-denied-dependencies',
    enforce: 'pre',
    configResolved(resolved) {
      denied = new Set();
      for (const entry of resolved.server.fs.deny) {
        denied.add(entry);
        denied.add(isAbsolute(entry) ? entry : resolve(appRoot, entry));
      }
    },
    load(id) {
      if (this.environment?.name === 'client') return null;
      const file = deniedFile(id);
      if (!file) return null;
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
      environments: {
        ssr: {
          ...webViteWorkerSsrEnvironment,
          resolve: { ...webViteWorkerSsrEnvironment.resolve, alias: [...workerResolveAliases] },
        },
      },
      resolve: { alias: [...workerResolveAliases] },
      optimizeDeps: { noDiscovery: true, include: [] },
    };
  }
  const persistence = createWorkerPersistence('web', context, appRoot);
  const testRuntime = process.env.REZICS_TEST_RUNTIME === '1';
  const testWorkerBindings = process.env[testWorkerBindingsEnvName] ?? '{}';
  const walkCacheDir = process.env.REZICS_WALK_STACK_SLOT
    ? resolve(workspaceRoot, '.temp/web-vite', process.env.REZICS_WALK_STACK_SLOT)
    : undefined;
  const selectedCacheDir = viteCacheDir ?? walkCacheDir;
  const clientOptimizeDeps = webViteClientOptimizeDepsFor();
  return {
    ...(selectedCacheDir ? { cacheDir: selectedCacheDir } : {}),
    server: {
      // The native stack binds 127.0.0.1 in an isolated network; publication tests prove a foreign Host never reaches page URLs.
      allowedHosts: process.env.WEB_DEV_ALLOW_ANY_HOST === '1' ? true : [],
      ...(nativeWebTls ? { https: { cert: nativeWebCertificate!, key: nativeWebKey! } } : {}),
      // Allow the resolved install roots of packages the client and Worker actually load, including shared stores.
      fs: {
        allow: [workspaceRoot, ...dependencyRoots, ...(selectedCacheDir ? [resolve(selectedCacheDir)] : [])],
      },
    },
    html: { cspNonce: viteNonceMarker },
    resolve: { alias: [...workerResolveAliases] },
    // Fonts must stay on the site origin; the page policy does not allow data: fonts.
    build: { assetsInlineLimit: 0 },
    optimizeDeps: {
      entries: [...clientOptimizeDeps.entries],
      holdUntilCrawlEnd: clientOptimizeDeps.holdUntilCrawlEnd,
      exclude: [...clientOptimizeDeps.exclude],
    },
    ssr: {
      optimizeDeps: {
        ...workerSsrOptimizeDeps,
        include: [...workerSsrOptimizeDeps.include],
        exclude: [...workerSsrOptimizeDeps.exclude],
      },
    },
    plugins: [
      ...(viteCacheDir
        ? [
            {
              name: 'web-vite-dep-cache-align',
              enforce: 'pre' as const,
              configureServer(server: { environments: Record<string, ViteDepCacheAlignEnvironment | undefined> }) {
                return bindViteDepCacheAlign(viteCacheDir, server.environments);
              },
            },
          ]
        : []),
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
      ...(testRuntime
        ? [
            {
              name: 'rezics-test-env-bindings',
              enforce: 'pre' as const,
              transform(code: string, id: string) {
                if (filePathOf(id) === filePathOf(testRuntimeBindings)) {
                  return {
                    code: code.replace(
                      'declare const __REZICS_TEST_WORKER_BINDINGS__: Record<string, string>;',
                      `const __REZICS_TEST_WORKER_BINDINGS__: Record<string, string> = ${testWorkerBindings};`,
                    ),
                    map: null,
                  };
                }
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
          // Isolated tests already prepared messages. Other serve callers share the same freshness lock as startup.
          if (command !== 'serve' || !shouldGenerateLocalization()) return;
          const code = await ensureMessagesReady(appRoot);
          if (code !== 0) throw new Error(`Paraglide generation exited ${code} before Vite started`);
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
            resolve: { alias: [...workerResolveAliases] },
            environments: { ssr: { optimizeDeps: { ...workerSsrOptimizeDeps, entries: [] } } },
          };
        },
        configEnvironment(name: string) {
          if (name === 'client') return;
          return {
            resolve: { alias: [...workerResolveAliases] },
            optimizeDeps: { ...workerSsrOptimizeDeps, entries: [] },
          };
        },
        configResolved(config: {
          resolve: { alias?: unknown };
          ssr: { resolve?: { alias?: unknown }; optimizeDeps?: Record<string, unknown> };
          environments?: Record<string, { resolve: { alias?: unknown }; optimizeDeps?: Record<string, unknown> }>;
        }) {
          pinWorkerResolveAliases(config.resolve);
          if (!config.ssr.resolve) config.ssr.resolve = {};
          pinWorkerResolveAliases(config.ssr.resolve);
          pinWorkerSsrOptimizeDeps(config.ssr);
          for (const [name, environment] of Object.entries(config.environments ?? {})) {
            if (name === 'client') continue;
            pinWorkerResolveAliases(environment.resolve);
            pinWorkerSsrOptimizeDeps(environment);
          }
        },
      },
      {
        // Elysia's default TypeBox stubs call require("typebox/type"). Workerd has no sync loader, so the Worker
        // loads the sibling live ESM and aliases those subpaths to installed TypeBox exports.
        name: 'web-worker-typebox-esm',
        enforce: 'pre',
        applyToEnvironment(environment) {
          return environment.name !== 'client';
        },
        resolveId: {
          filter: { id: typeboxBareSpecifierId },
          handler(id) {
            return typeboxAliasByFind.get(id);
          },
        },
        load(id) {
          const code = elysiaTypeboxLiveModuleCode(id);
          if (!code) return null;
          return { code, map: null };
        },
      },
      // Before the denied-dependency loader, which returns raw file contents for denied paths.
      {
        name: 'web-worker-selector-esm',
        enforce: 'pre',
        applyToEnvironment(environment) {
          return environment.name !== 'client';
        },
        resolveId(id) {
          if (id === workerSelectorImport || id === `${workerSelectorImport}.js`) return workerSelectorShimPath;
          return null;
        },
        // Raw CommonJS shims are replaced by file identity: TipTap imports these files by path, which bypasses the
        // bare-specifier mapping above. React exports useSyncExternalStore itself, so the index needs no shim.
        load(id) {
          const path = filePathOf(id);
          if (path.endsWith('/use-sync-external-store/shim/index.js'))
            return { code: "export { useSyncExternalStore } from 'react';\n", map: null };
          if (path.endsWith('/use-sync-external-store/shim/with-selector.js'))
            return { code: `export * from ${JSON.stringify(workerSelectorShimPath)};\n`, map: null };
          return null;
        },
      },
      workerDeniedDependencies(),
    ],
  };
});
