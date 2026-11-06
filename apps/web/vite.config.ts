import { viteNonceMarker } from './src/security/headers.ts';
import { testFixtureEnvHeader } from './src/test-fixture-header.ts';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { createWorkerPersistence } from '../../scripts/worker-persistence.ts';
import { messagesCurrent } from './scripts/messages-ready.ts';
import { readWorkerFixtureOverlay } from './tests/support/dev-server-fixture.ts';
import {
  bindViteDepCacheAlign,
  alignViteLockfileHashes,
  webViteClientOptimizeDeps,
  webViteWarmSsrEnvName,
  webViteWorkerSsrEnvironment,
  webViteWorkerSsrOptimizeDeps,
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
const workerSsrOptimizeDeps = webViteWorkerSsrOptimizeDeps;

function pinWorkerSsrOptimizeDeps(environment?: { optimizeDeps?: Record<string, unknown> }): void {
  if (!environment) return;
  environment.optimizeDeps = {
    ...environment.optimizeDeps,
    ...workerSsrOptimizeDeps,
    include: [...workerSsrOptimizeDeps.include],
    entries: [],
  };
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

export default defineConfig((context) => {
  const viteCacheDir = process.env.WEB_VITE_CACHE_DIR;
  if (viteCacheDir) alignViteLockfileHashes(viteCacheDir, appRoot);
  if (process.env[webViteWarmSsrEnvName] === '1') {
    const warm: UserConfig = {
      ssr: { target: 'webworker', noExternal: true },
      environments: { ssr: webViteWorkerSsrEnvironment },
      optimizeDeps: { noDiscovery: true, include: [] },
    };
    if (viteCacheDir) warm.cacheDir = viteCacheDir;
    return warm;
  }
  const persistence = createWorkerPersistence('web', context, appRoot);
  const testRuntime = process.env.REZICS_TEST_RUNTIME === '1';
  const config: UserConfig = {
    server: {
      // The native stack binds 127.0.0.1 in an isolated network; publication tests prove a foreign Host never reaches page URLs.
      allowedHosts: process.env.WEB_DEV_ALLOW_ANY_HOST === '1' ? true : [],
      // Allow the resolved install roots of packages the client and Worker actually load, including shared stores.
      fs: {
        allow: [workspaceRoot, ...dependencyRoots, ...(viteCacheDir ? [resolve(viteCacheDir)] : [])],
      },
    },
    ...(process.env.REZICS_WALK_STACK_SLOT
      ? { cacheDir: resolve(workspaceRoot, '.temp/web-vite', process.env.REZICS_WALK_STACK_SLOT) }
      : {}),
    html: { cspNonce: viteNonceMarker },
    // Fonts must stay on the site origin; the page policy does not allow data: fonts.
    build: { assetsInlineLimit: 0 },
    optimizeDeps: {
      // Scan the complete route graph up front so a local Worker browser check never discovers a route dependency
      // after the first page load.
      entries: [...webViteClientOptimizeDeps.entries],
      holdUntilCrawlEnd: webViteClientOptimizeDeps.holdUntilCrawlEnd,
    },
    plugins: [
      ...(viteCacheDir
        ? [
            {
              name: 'web-vite-dep-cache-align',
              enforce: 'pre' as const,
              configureServer(server) {
                return bindViteDepCacheAlign(viteCacheDir, server.environments);
              },
            } satisfies Plugin,
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
          // Create generated localization modules before Vite scans the browser routes. A check or `bun run generate`
          // that already compiled current catalogues, including every message leaf, is reused.
          if (command === 'serve' && !messagesCurrent(appRoot)) {
            await new Promise<void>((resolve, reject) => {
              const child = spawn('bun', ['scripts/generate.ts'], { cwd: appRoot, stdio: 'inherit' });
              child.once('error', reject);
              child.once('exit', (code, signal) => {
                if (code === 0) resolve();
                else reject(new Error(`Paraglide generation exited with ${signal ?? code}`));
              });
            });
          }
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
      workerDeniedDependencies(),
      {
        // Cloudflare's config hook enables discovery from the Worker entry. mergeConfig concatenates `entries`, so a
        // later configEnvironment cannot remove that crawl. Pin the resolved Worker optimizer after plugin merge.
        name: 'web-worker-explicit-dependencies',
        enforce: 'post' as const,
        config() {
          return { environments: { ssr: { optimizeDeps: { ...workerSsrOptimizeDeps, entries: [] } } } };
        },
        configEnvironment(name: string) {
          if (name !== 'ssr') return;
          return { optimizeDeps: { ...workerSsrOptimizeDeps, entries: [] } };
        },
        configResolved(resolved: { environments?: { ssr?: { optimizeDeps?: Record<string, unknown> } } }) {
          pinWorkerSsrOptimizeDeps(resolved.environments?.ssr);
        },
      },
    ],
  };
  if (viteCacheDir) config.cacheDir = viteCacheDir;
  if (nativeWebTls && config.server) config.server.https = { cert: nativeWebCertificate!, key: nativeWebKey! };
  return config;
});
