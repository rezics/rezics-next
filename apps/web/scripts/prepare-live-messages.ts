import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { catalogueLocaleModules, catalogueParaglideRuntime, paraglideViteOptions } from './paraglide-vite.ts';

// Use the installed plugin's own input/output-validated cache. A standalone compile produces a different
// cache identity and cannot prime that cache. No app routes, optimizer, listener or Cloudflare runtime is needed.
const compact = process.env[catalogueLocaleModules] === '1';
const options = paraglideViteOptions(compact);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: '.temp/paraglide-vite',
  plugins: [paraglideVitePlugin(options)],
  server: { middlewareMode: true, watch: null, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  await server.environments.client!.pluginContainer.buildStart({});
} finally {
  await server.close();
}

if (options.outdir) {
  // Keep each generated module and its relative imports. Strip compiler comments before either Vite graph reads them.
  const root = resolve(options.outdir);
  const files = [...new Bun.Glob('**/*.js').scanSync({ cwd: root })];
  await Bun.build({
    root,
    entrypoints: files.map((file) => resolve(root, file)),
    outdir: catalogueParaglideRuntime,
    external: ['*'],
    minify: { whitespace: true, syntax: true },
  });
}
