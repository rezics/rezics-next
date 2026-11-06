import { viteNonceMarker } from './src/security/headers.ts';
import { realpathSync } from 'node:fs';
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
    // Fonts must stay on the site origin; the page policy does not allow data: fonts.
    build: { assetsInlineLimit: 0 },
    optimizeDeps: {
      // Scan the complete route graph up front so a local Worker browser check never discovers a route dependency
      // after the first page has loaded. Copies and Loans keep a locale Calendar grid; never prebundle
      // react-day-picker/date-fns if some other graph edge still names them.
      entries: ['src/routes/**/*.tsx'],
      holdUntilCrawlEnd: true,
      exclude: ['react-day-picker', 'date-fns', '@date-fns/tz'],
    },
    ssr: {
      optimizeDeps: {
        include: ['@inlang/paraglide-js/urlpattern-polyfill'],
      },
    },
    plugins: [
      {
        name: 'generate-localization',
        async config(_config, { command }) {
          // Create generated localization modules before Vite scans the browser routes.
          if (command === 'serve') {
            await new Promise<void>((resolve, reject) => {
              const child = spawn('bun', ['scripts/generate.ts'], { stdio: 'inherit' });
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
            optimizeDeps: {
              noDiscovery: true,
              exclude: ['react-day-picker', 'date-fns', '@date-fns/tz'],
            },
          };
        },
        configResolved(config) {
          for (const [name, environment] of Object.entries(config.environments)) {
            if (name === 'client') continue;
            const optimizeDeps = environment.optimizeDeps;
            optimizeDeps.noDiscovery = true;
            optimizeDeps.exclude ??= [];
            for (const packageName of ['react-day-picker', 'date-fns', '@date-fns/tz']) {
              if (!optimizeDeps.exclude.includes(packageName)) optimizeDeps.exclude.push(packageName);
            }
          }
        },
      },
      ...(persistence.cleanupPlugin ? [persistence.cleanupPlugin] : []),
    ],
  };
});
