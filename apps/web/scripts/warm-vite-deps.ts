import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = process.env.WEB_VITE_CACHE_DIR;
if (!cacheDir) throw new Error('WEB_VITE_CACHE_DIR is required to warm SSR optimizeDeps');
process.env.WEB_VITE_WARM_SSR = '1';

const server = await createServer({
  configFile: join(appRoot, 'vite.config.ts'),
  root: appRoot,
  cacheDir,
  appType: 'custom',
  logLevel: 'info',
  server: { middlewareMode: true, hmr: false, watch: null },
});
try {
  const optimizer = server.environments.ssr?.depsOptimizer;
  if (!optimizer) throw new Error('SSR dependency optimizer is missing');
  await optimizer.init();
  const metadata = join(cacheDir, 'deps_ssr', '_metadata.json');
  if (!existsSync(metadata)) throw new Error(`SSR dependency warm did not write ${metadata}`);
} finally {
  await server.close();
}
