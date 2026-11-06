import { viteNonceMarker } from './src/security/headers.ts';
import { testFixtureEnvHeader } from './src/test-fixture-header.ts';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { createWorkerPersistence } from '../../scripts/worker-persistence.ts';
import { readWorkerFixtureOverlay } from './tests/support/dev-server-fixture.ts';

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
const testRuntimeBindings = fileURLToPath(new URL('./src/test-runtime-bindings.ts', import.meta.url));
const fontDependencyRoots = ['manrope', 'source-serif-4', 'geist-mono'].map((name) =>
  realpathSync(join(appRoot, 'node_modules', '@fontsource-variable', name)),
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
  const testRuntime = process.env.REZICS_TEST_RUNTIME === '1';
  const viteCacheDir = process.env.WEB_VITE_CACHE_DIR;
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
          dependencyRoot,
          ...fontDependencyRoots,
          ...(viteCacheDir ? [resolve(viteCacheDir)] : []),
        ],
      },
    },
    html: { cspNonce: viteNonceMarker },
    // Fonts must stay on the site origin; the page policy does not allow data: fonts.
    build: { assetsInlineLimit: 0 },
    optimizeDeps: {
      // Scan the complete route graph up front so a local Worker browser check never discovers a route dependency
      // after the first page has loaded.
      entries: ['src/routes/**/*.tsx'],
      holdUntilCrawlEnd: true,
    },
    ssr: {
      optimizeDeps: {
        holdUntilCrawlEnd: true,
        include: ['@inlang/paraglide-js/urlpattern-polyfill'],
      },
    },
    plugins: [
      ...(testRuntime
        ? [
            {
              name: 'rezics-test-fixture-env',
              configureServer(server: { middlewares: { use: (handler: (req: { headers: Record<string, unknown> }, res: unknown, next: () => void) => void) => void } }) {
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
      ...(persistence.cleanupPlugin ? [persistence.cleanupPlugin] : []),
    ],
  };
});
