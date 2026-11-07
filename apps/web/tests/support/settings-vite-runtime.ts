import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer as createViteServer, type Plugin, type ViteDevServer } from 'vite';
import { testWorkerBindingsEnvName } from '../../src/test-runtime-binding-config';
import { resolveWebViteConfig } from './vite-config';

const appRoot = resolve(import.meta.dir, '../..');
const workspaceRoot = resolve(appRoot, '../..');

type SettingsViteRuntime = {
  vite: ViteDevServer;
  origin: string;
  clientModule(path: string): Promise<{ status: number; code: string }>;
  close(): Promise<void>;
};

/** Starts the real Web Vite configuration with startup-fixed Worker fixture bindings. */
export async function createSettingsViteRuntime(
  bindings: Readonly<Record<string, string>>,
  plugins: Plugin[] = [],
  options: { omitCloudflarePlugins?: boolean } = {},
): Promise<SettingsViteRuntime> {
  const previous = new Map<string, string | undefined>(
    ['REZICS_TEST_RUNTIME', testWorkerBindingsEnvName, 'WEB_TEST_STATE_INSTANCE_DIR', 'WEB_VITE_CACHE_DIR'].map(
      (key) => [key, process.env[key]],
    ),
  );
  const stateDirectory = await mkdtemp(join(workspaceRoot, '.temp/settings-vite-state-'));
  const cacheDirectory = await mkdtemp(join(workspaceRoot, '.temp/settings-vite-cache-'));
  process.env.REZICS_TEST_RUNTIME = '1';
  process.env[testWorkerBindingsEnvName] = JSON.stringify(bindings);
  process.env.WEB_TEST_STATE_INSTANCE_DIR = stateDirectory;
  process.env.WEB_VITE_CACHE_DIR = cacheDirectory;

  let vite: ViteDevServer | undefined;
  let http: ReturnType<typeof createHttpServer> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (http?.listening)
        await new Promise<void>((resolveClose, rejectClose) =>
          http!.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
    } finally {
      try {
        await vite?.close();
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
        await rm(cacheDirectory, { recursive: true, force: true });
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  };

  try {
    const config = await resolveWebViteConfig({ command: 'serve', mode: 'test' }, appRoot);
    const configuredPlugins = (config.plugins ?? [])
      .flatMap((plugin) => (Array.isArray(plugin) ? plugin : [plugin]))
      .filter((plugin) => {
        if (!options.omitCloudflarePlugins || !plugin || typeof plugin !== 'object' || !('name' in plugin))
          return true;
        // The installed Cloudflare config loader explicitly rejects Bun. This browser-only graph test does not
        // exercise Worker config loading, so keep the real Web plugins and omit only that Node-bound integration.
        return !String(plugin.name).includes('cloudflare');
      });
    vite = await createViteServer({
      ...config,
      configFile: false,
      root: appRoot,
      cacheDir: cacheDirectory,
      plugins: [...configuredPlugins, ...plugins],
      server: { ...config.server, middlewareMode: true, hmr: false, watch: null },
      appType: 'custom',
      logLevel: 'silent',
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
    if (!address || typeof address === 'string') throw new Error('Settings Vite did not bind a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      vite,
      origin,
      async clientModule(path) {
        const response = await fetch(new URL(path, origin));
        return { status: response.status, code: await response.text() };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function settingsClientModuleGraph(
  runtime: Pick<SettingsViteRuntime, 'clientModule'>,
  entry: string,
): Promise<Map<string, { status: number; code: string }>> {
  const modules = new Map<string, { status: number; code: string }>();
  const pending = [entry];
  const importPattern = /(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g;
  while (pending.length) {
    const path = pending.pop()!;
    if (modules.has(path)) continue;
    const module = await runtime.clientModule(path);
    modules.set(path, module);
    if (module.status !== 200) continue;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(module.code))) {
      const imported = match[1]!;
      if (!imported.startsWith('/src/')) continue;
      const importedPath = imported.split('?', 1)[0]!;
      if (!modules.has(importedPath)) pending.push(importedPath);
    }
  }
  return modules;
}
