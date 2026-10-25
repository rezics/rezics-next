import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const components = local('../src/components');
const arkEntries = [
  ...new Set(
    readdirSync(components)
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) =>
        [...readFileSync(`${components}/${file}`, 'utf8').matchAll(/from ['"](@ark-ui\/react(?:\/[\w-]+)?)/g)].map(
          (match) => match[1]!,
        ),
      ),
  ),
].sort();

const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.plugins ??= [];
    config.plugins.push(tailwindcss());
    config.optimizeDeps ??= {};
    config.optimizeDeps.include = [...new Set([...(config.optimizeDeps.include ?? []), ...arkEntries])];
    return config;
  },
};

export default config;
