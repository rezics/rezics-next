import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { fileURLToPath } from 'node:url';

// Workspace packages keep these libraries outside apps/web. Exact file aliases let the first
// dependency optimization prebundle them; a directory alias is not an optimizable entry.
const compositionModules = fileURLToPath(new URL('../../../packages/composition/node_modules/', import.meta.url));
const arkUi = fileURLToPath(new URL('../../../packages/ui/node_modules/@ark-ui/react/dist/', import.meta.url));
const storyAlias = (find: RegExp, replacement: string) => ({ find, replacement });

const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y'],
  core: { disableTelemetry: true },
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
    config.resolve ??= {};
    const currentAlias = config.resolve.alias ?? {};
    const aliasEntries = Array.isArray(currentAlias)
      ? currentAlias
      : Object.entries(currentAlias).map(([find, replacement]) => ({ find, replacement }));
    config.resolve.alias = [
      ...aliasEntries,
      { find: 'cloudflare:workers', replacement: fileURLToPath(new URL('./cloudflare-workers.ts', import.meta.url)) },
      {
        find: '@tanstack/react-start',
        replacement: fileURLToPath(new URL('./react-start.ts', import.meta.url)),
      },
      // The subject page imports composition, whose profile digest uses node:crypto.
      {
        find: 'node:crypto',
        replacement: fileURLToPath(new URL('../src/stories/node-crypto.ts', import.meta.url)),
      },
      storyAlias(/^canonicalize$/, `${compositionModules}canonicalize/lib/canonicalize.js`),
      storyAlias(/^typebox$/, `${compositionModules}typebox/build/index.mjs`),
      storyAlias(/^typebox\/value$/, `${compositionModules}typebox/build/value/index.mjs`),
      storyAlias(/^@ark-ui\/react$/, `${arkUi}index.js`),
      storyAlias(/^@ark-ui\/react\/dialog$/, `${arkUi}components/dialog/index.js`),
      storyAlias(/^@ark-ui\/react\/fieldset$/, `${arkUi}components/fieldset/index.js`),
      storyAlias(/^@ark-ui\/react\/menu$/, `${arkUi}components/menu/index.js`),
      storyAlias(/^@ark-ui\/react\/select$/, `${arkUi}components/select/index.js`),
      storyAlias(/^@ark-ui\/react\/locale$/, `${arkUi}providers/locale/index.js`),
    ];
    config.plugins ??= [];
    config.plugins.push(paraglideVitePlugin({ project: './project.inlang' }), tailwindcss());
    config.optimizeDeps ??= {};
    // Prebundle libraries the stories reach through workspace packages. Finding them on a later
    // story restarts Vite and leaves that story without its main landmark.
    config.optimizeDeps.include = [
      ...new Set([
        ...(config.optimizeDeps.include ?? []),
        '@ark-ui/react',
        '@ark-ui/react/dialog',
        '@ark-ui/react/fieldset',
        '@ark-ui/react/locale',
        '@ark-ui/react/menu',
        '@ark-ui/react/select',
        '@puckeditor/core/rsc',
        'canonicalize',
        'typebox',
        'typebox/value',
      ]),
    ];
    return config;
  },
};

export default config;
