import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const routes = join(app, 'src/routes');
const routeTree = join(app, 'src/routeTree.gen.ts');

function newestRouteChange(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((newest, entry) => {
    const target = join(path, entry.name);
    return Math.max(newest, entry.isDirectory() ? newestRouteChange(target) : statSync(target).mtimeMs);
  }, 0);
}

// Storybook omits TanStack's Vite plugin, so refresh its ignored route tree when it is absent or stale.
if (!existsSync(routeTree) || newestRouteChange(routes) > statSync(routeTree).mtimeMs) {
  const result = spawnSync('node', ['.storybook/generate-routes.ts'], {
    cwd: app,
    stdio: 'inherit',
    env: { ...process.env, WEBSITE_CLIENT_KEY: process.env.WEBSITE_CLIENT_KEY ?? '{}' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not generate the application route tree (exit ${result.status}).`);
}

const config: StorybookConfig = {
  framework: {
    name: '@storybook/react-vite',
    options: { builder: { viteConfigPath: null } },
  },
  features: { viewportStoryGlobals: true } as NonNullable<StorybookConfig['features']> & { viewportStoryGlobals: true },
  stories: ['../src/stories/**/*.stories.tsx', '../src/stories/**/*.mdx', '../src/shell/**/*.stories.tsx'],
  storySorts: [
    {
      order: [
        'Overview',
        'Pages',
        ['Library', 'Subjects', 'Discovery', 'Community', 'Commerce', 'Account'],
        'Patterns',
        ['Library', 'Subjects', 'Discovery', 'Community', 'Commerce', 'Account'],
        'Components',
        '*',
      ],
    },
  ],
  refs: {
    ui: { title: 'Components', url: process.env.STORYBOOK_UI_URL ?? 'http://localhost:6007' },
  },
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y', '@storybook/addon-docs'],
  core: { disableTelemetry: true },
  // Generated cover images for the recorded summaries, served where the site's media route would be.
  staticDirs: [
    { from: '../public', to: '/' },
    {
      from: '../node_modules/@fontsource-variable/manrope/files',
      to: '/node_modules/@fontsource-variable/manrope/files',
    },
    { from: './media', to: '/media' },
  ],
  async viteFinal(config) {
    const storyPlugins = (plugins: typeof config.plugins): typeof config.plugins =>
      plugins?.flatMap((plugin) =>
        Array.isArray(plugin)
          ? storyPlugins(plugin)
          : plugin && typeof plugin === 'object' && 'name' in plugin && /cloudflare|tanstack/.test(String(plugin.name))
            ? []
            : [plugin],
      ) ?? [];
    config.plugins = storyPlugins(config.plugins) ?? [];
    config.server ??= {};
    config.server.allowedHosts = ['127.0.0.1', 'localhost'];
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'cloudflare:workers': fileURLToPath(new URL('./cloudflare-workers.ts', import.meta.url)),
      '@tanstack/react-start/server': fileURLToPath(new URL('./react-start.ts', import.meta.url)),
      '@tanstack/react-start': fileURLToPath(new URL('./react-start.ts', import.meta.url)),
    };
    config.plugins ??= [];
    config.plugins.push(paraglideVitePlugin({ project: './project.inlang' }), tailwindcss());
    config.optimizeDeps ??= {};
    // These packages install dependencies in their own node_modules, so a bare id does not resolve from web.
    const throughWorkspace = (id: string): string =>
      id === 'canonicalize' || id === 'typebox' || id.startsWith('@noble/hashes/') ? `@rezics/composition > ${id}` : id;
    config.optimizeDeps.include = [
      ...new Set([
        ...(config.optimizeDeps.include ?? []).map(throughWorkspace),
        '@rezics/composition > canonicalize',
        '@rezics/composition > typebox',
        '@rezics/composition > @noble/hashes/sha2.js',
        '@rezics/composition > @noble/hashes/utils.js',
      ]),
    ];
    return config;
  },
};

export default config;
