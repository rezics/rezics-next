import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserRoutes } from './browser-routes.ts';

const app = fileURLToPath(new URL('..', import.meta.url));
const componentRefs =
  process.env.STORYBOOK_DISABLE_COMPONENT_REF === '1'
    ? {}
    : { ui: { title: 'Components', url: process.env.STORYBOOK_UI_URL ?? 'http://localhost:6007' } };

// A fresh pass also catches deletions/renames and never trusts ignored output after a failed generation.
const result = spawnSync('node', ['.storybook/generate-routes.ts'], { cwd: app, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Could not generate the application route tree (exit ${result.status}).`);

const config: StorybookConfig = {
  framework: {
    name: '@storybook/react-vite',
    options: { builder: { viteConfigPath: null } },
  },
  // This alpha serves the dev JSON manifest only with builder-side docgen.
  features: {
    viewportStoryGlobals: true,
    componentsManifest: true,
    docgenServer: false,
  } as NonNullable<StorybookConfig['features']> & {
    viewportStoryGlobals: true;
  },
  stories: [
    '../src/stories/**/*.stories.tsx',
    '../src/stories/**/*.mdx',
    '../src/shell/**/*.stories.tsx',
    '../../auth/src/stories/**/*.stories.tsx',
  ],
  storySorts: [
    {
      order: [
        'Overview',
        'Pages',
        ['Library', 'Subjects', 'Discovery', 'Community', 'Commerce', 'Account', 'Catalogue', 'Zones', 'Imports', '*'],
        'Patterns',
        ['Library', 'Subjects', 'Discovery', 'Community', 'Commerce', 'Account', 'Catalogue', 'Zones', 'Imports', '*'],
        'Components',
        '*',
      ],
    },
  ],
  refs: componentRefs,
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y', '@storybook/addon-mcp', '@storybook/addon-docs'],
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
    // Run before React transforms; this allocates no Start/Cloudflare runtime or route watcher.
    config.plugins.unshift(await browserRoutes(app));
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
    config.plugins.push(
      paraglideVitePlugin({
        project: '../auth/project.inlang',
        outdir: '../auth/src/paraglide',
        emitTsDeclarations: true,
        strategy: ['cookie', 'custom-accept-language', 'baseLocale'],
        cookieName: 'rezics_locale',
      }),
    );
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
