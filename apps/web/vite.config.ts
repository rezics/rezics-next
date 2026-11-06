import { viteNonceMarker } from './src/security/headers.ts';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  const persistence = createWorkerPersistence('web', context, appRoot);
  return {
    server: {
      // The native stack binds 127.0.0.1 in an isolated network; publication tests prove a foreign Host never reaches page URLs.
      allowedHosts: process.env.WEB_DEV_ALLOW_ANY_HOST === '1' ? true : [],
      ...(nativeWebTls ? { https: { cert: nativeWebCertificate!, key: nativeWebKey! } } : {}),
      // Shared dependency stores can resolve package files outside the checkout's lexical node_modules path.
      fs: { allow: [workspaceRoot, dependencyRoot, ...fontDependencyRoots] },
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
        include: ['@inlang/paraglide-js/urlpattern-polyfill'],
      },
    },
    plugins: [
      {
        name: 'generate-localization',
        async config(_config, { command }) {
          // Create generated localization modules before Vite scans the browser routes. A check or `bun run generate`
          // that already compiled current catalogues is reused, so a cold start compiles them once.
          if (command === 'serve' && !messagesCurrent(appRoot)) {
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
      workerDeniedDependencies(),
    ],
  };
});
