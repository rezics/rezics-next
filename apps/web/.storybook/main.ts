import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/stories/**/*.stories.tsx'],
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.plugins ??= [];
    config.plugins.push(paraglideVitePlugin({ project: './project.inlang' }), tailwindcss());
    config.optimizeDeps ??= {};
    config.optimizeDeps.include = [...new Set([...(config.optimizeDeps.include ?? []), '@ark-ui/react/locale'])];
    return config;
  },
};

export default config;
