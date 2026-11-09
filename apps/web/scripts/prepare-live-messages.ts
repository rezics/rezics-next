import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { createServer } from 'vite';

// Use the installed plugin's own input/output-validated cache. A standalone compile produces a different
// cache identity and cannot prime that cache. No app routes, optimizer, listener or Cloudflare runtime is needed.
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: '.temp/paraglide-vite',
  plugins: [paraglideVitePlugin({ project: './project.inlang', outputStructure: 'message-modules' })],
  server: { middlewareMode: true, watch: null, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  await server.environments.client!.pluginContainer.buildStart({});
} finally {
  await server.close();
}
