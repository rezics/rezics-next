import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../features/**/*.stories.@(ts|tsx)', '../../../packages/ui/src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y', '@storybook/addon-mcp'],
  // Component manifest for the MCP docs toolset; agents read it at http://127.0.0.1:6006/mcp.
  features: { componentsManifest: true },
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.plugins ??= [];
    config.plugins.push(tailwindcss());
    config.optimizeDeps ??= {};
    config.optimizeDeps.include = [...new Set([...(config.optimizeDeps.include ?? []),
      '@ark-ui/react/factory', 'clsx', 'tailwind-merge', 'tailwind-variants',
      '@storybook/react-dom-shim'])];
    return config;
  },
};

export default config;
