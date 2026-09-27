import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

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
    // vinext supplies next/navigation and next/link in the app; stories get stand-ins.
    config.resolve ??= {};
    config.resolve.alias = [
      ...(Array.isArray(config.resolve.alias) ? config.resolve.alias
        : Object.entries(config.resolve.alias ?? {}).map(([find, replacement]) => ({ find, replacement }))),
      { find: /^next\/navigation$/, replacement: local('./next-navigation.ts') },
      { find: /^next\/link$/, replacement: local('./next-link.tsx') },
    ];
    config.optimizeDeps ??= {};
    config.optimizeDeps.include = [...new Set([...(config.optimizeDeps.include ?? []),
      '@ark-ui/react/factory', 'clsx', 'tailwind-merge', 'tailwind-variants',
      '@storybook/react-dom-shim'])];
    return config;
  },
};

export default config;
