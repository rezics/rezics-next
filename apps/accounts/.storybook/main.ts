import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { browserDependencies } from '../optimize-deps.ts';

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../features/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.plugins ??= [];
    config.plugins.push(tailwindcss());
    config.optimizeDeps ??= {};
    config.optimizeDeps.include = [...new Set([...(config.optimizeDeps.include ?? []),
      ...browserDependencies, '@storybook/react-dom-shim'])];
    return config;
  },
};

export default config;
