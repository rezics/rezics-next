import { viteNonceMarker } from './src/security/headers.ts';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { createWorkerPersistence } from '../../scripts/worker-persistence.ts';

const configuredInspectorPort = process.env.WORKER_INSPECTOR_PORT;
const nativeWebHost = process.env.NATIVE_WEB_TEST_HOST;
const nativeWebCertificate = process.env.NATIVE_WEB_TEST_TLS_CERT;
const nativeWebKey = process.env.NATIVE_WEB_TEST_TLS_KEY;
const nativeWebTls = Boolean(nativeWebHost || nativeWebCertificate || nativeWebKey);
if (nativeWebTls && (nativeWebHost !== 'web.native.rezics.com' || !nativeWebCertificate || !nativeWebKey))
  throw new Error('Native web TLS requires the reserved host and its test certificate');
const appRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(appRoot, '../..');
const dependencyRoot = realpathSync(join(workspaceRoot, 'node_modules'));
const fontDependencyRoots = ['manrope', 'source-serif-4', 'geist-mono'].map((name) =>
  realpathSync(join(appRoot, 'node_modules', '@fontsource-variable', name)),
);
const paraglideGenerateLock = join(workspaceRoot, '.temp/paraglide-generate.lock');

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

const linkedDependencyRoot = linkedDependencyAllow(
  realpathSync(join(appRoot, 'node_modules/@tanstack/react-start')),
);
const calendarOptimizeDeps = ['react-day-picker', 'date-fns', '@date-fns/tz'] as const;
/**
 * Generated paraglide/runtime.js imports `@inlang/paraglide-js/urlpattern-polyfill`, which re-exports
 * `urlpattern-polyfill`. Workerd export-type inspection resolves with workerd/worker/module/browser,
 * not `import`/`require`. That package's exports then miss and Node `main` loads CJS `index.cjs`.
 * `runInRunnerObject` has no `module`, so evaluating that CJS throws `module is not defined`.
 * Adding `import` to those conditions hung Rolldown before Copies printed ready. Keep Workerd's
 * conditions, resolve both the wrapper id and the nested package to the ESM files, and shim any
 * remaining CJS the Worker transform still receives. Leave the package off optimizeDeps.include:
 * prebundling it under workerd conditions feeds CJS into the runner.
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

function pinWorkerOptimizeDeps(optimizeDeps: {
  noDiscovery?: boolean;
  include?: string[];
  exclude?: string[];
}): void {
  optimizeDeps.noDiscovery = true;
  // Vite concatenates include arrays across plugins. Cloudflare sets noDiscovery false, TanStack then
  // enqueues react-dom/server, and Rolldown hangs the Worker optimizer before Copies can print ready.
  // Leave the polyfill off include: prebundling it under workerd conditions loads CJS into Workerd.
  // Leave react-dom/server off include and off exclude so Vite transforms it without the hanging prebundle.
  optimizeDeps.include = [];
  optimizeDeps.exclude = (optimizeDeps.exclude ?? []).filter(
    (packageName) => packageName !== 'react' && packageName !== 'react-dom' && packageName !== 'react-dom/server',
  );
  for (const packageName of calendarOptimizeDeps) {
    if (!optimizeDeps.exclude.includes(packageName)) optimizeDeps.exclude.push(packageName);
  }
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

export default defineConfig((context) => {
  const persistence = createWorkerPersistence('web', context, appRoot);
  return {
    server: {
      // The native stack binds 127.0.0.1 in an isolated network; publication tests prove a foreign Host never reaches page URLs.
      allowedHosts: process.env.WEB_DEV_ALLOW_ANY_HOST === '1' ? true : [],
      ...(nativeWebTls ? { https: { cert: nativeWebCertificate!, key: nativeWebKey! } } : {}),
      // Shared dependency stores can resolve package files outside the checkout's lexical node_modules path.
      fs: {
        allow: [
          workspaceRoot,
          dependencyRoot,
          ...(linkedDependencyRoot ? [linkedDependencyRoot] : []),
          ...fontDependencyRoots,
        ],
      },
    },
    html: { cspNonce: viteNonceMarker },
    resolve: { alias: [urlpatternPolyfillAlias] },
    // Fonts must stay on the site origin; the page policy does not allow data: fonts.
    build: { assetsInlineLimit: 0 },
    optimizeDeps: {
      // Scan the complete route graph up front so a local Worker browser check never discovers a route dependency
      // after the first page has loaded. Copies and Loans keep a locale Calendar grid; never prebundle
      // react-day-picker/date-fns if some other graph edge still names them.
      entries: ['src/routes/**/*.tsx'],
      holdUntilCrawlEnd: true,
      exclude: [...calendarOptimizeDeps],
    },
    ssr: {
      resolve: { alias: [urlpatternPolyfillAlias] },
      optimizeDeps: {
        noDiscovery: true,
        include: [],
        exclude: [...calendarOptimizeDeps],
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
      {
        name: 'generate-localization',
        async config(_config, { command }) {
          // Create generated localization modules before Vite scans the browser routes.
          if (command !== 'serve' || !shouldGenerateLocalization()) return;
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
        ...(persistence.directory ? { persistState: { path: persistence.directory } } : {}),
      }),
      {
        // Cloudflare's Worker environment sets noDiscovery false. The root config hook cannot
        // override that per-environment value; configEnvironment runs when the Worker env is built,
        // including vite serve, so Copies and signed-in routes can print ready.
        name: 'ssr-optimize-deps-skip-calendar-packages',
        enforce: 'post',
        configEnvironment(name) {
          if (name === 'client') return;
          return {
            resolve: { alias: [urlpatternPolyfillAlias] },
            optimizeDeps: {
              noDiscovery: true,
              include: [],
              exclude: [...calendarOptimizeDeps],
            },
          };
        },
        configResolved(config) {
          // TanStack concatenates react-dom/server onto the root ssr include after environment
          // hooks; Workerd still reads that list during export-type inspection. Keep Workerd's
          // own conditions: injecting `import` hung Rolldown before the ready line.
          pinUrlpatternAlias(config.resolve);
          if (!config.ssr.resolve) config.ssr.resolve = {};
          pinUrlpatternAlias(config.ssr.resolve);
          if (config.ssr.optimizeDeps) pinWorkerOptimizeDeps(config.ssr.optimizeDeps);
          for (const [name, environment] of Object.entries(config.environments)) {
            if (name === 'client') continue;
            pinUrlpatternAlias(environment.resolve);
            pinWorkerOptimizeDeps(environment.optimizeDeps);
          }
        },
      },
      ...(persistence.cleanupPlugin ? [persistence.cleanupPlugin] : []),
    ],
  };
});
