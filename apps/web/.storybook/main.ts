import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Every Ark UI entry Rezics UI imports, pre-bundled before the first story loads:
// an entry Vite discovers mid-run reloads the page, which fails that Vitest run.
const components = local('../../../packages/ui/src/components');
const arkEntries = [...new Set(readdirSync(components).filter(file => file.endsWith('.tsx'))
  .flatMap(file => [...readFileSync(`${components}/${file}`, 'utf8')
    .matchAll(/from '(@ark-ui\/react(?:\/[\w-]+)?)'/g)].map(match => match[1]!)))].sort();

const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: { builder: { viteConfigPath: local('./vite.config.ts') } } },
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
    config.optimizeDeps.include = [...new Set([...(config.optimizeDeps.include ?? []), ...arkEntries,
      'tailwind-variants', 'lucide-react', 'native-i18n',
      '@tanstack/react-query', '@storybook/react-dom-shim'])];
    return config;
  },
};

export default config;
