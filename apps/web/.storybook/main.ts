import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { fileURLToPath } from 'node:url';

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
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'cloudflare:workers': fileURLToPath(new URL('./cloudflare-workers.ts', import.meta.url)),
      '@tanstack/react-start': fileURLToPath(new URL('./react-start.ts', import.meta.url)),
    };
    config.plugins ??= [];
    config.plugins.push(paraglideVitePlugin({ project: './project.inlang' }), tailwindcss());
    config.optimizeDeps ??= {};
    config.optimizeDeps.include = [...new Set([...(config.optimizeDeps.include ?? []), '@ark-ui/react/locale'])];
    return config;
  },
};

export default config;
