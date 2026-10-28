import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const components = local('../src/components');
// The shadcn components import their primitives from many packages. Pre-bundle them up front: Vite otherwise
// optimizes each on first use, reloads the page mid-run, and loads React twice.
const shadcn = local('../src/shadcn');
const shadcnEntries = [
  ...new Set(
    readdirSync(shadcn)
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) =>
        [...readFileSync(`${shadcn}/${file}`, 'utf8').matchAll(/from ["']([^"'./][^"']*)["']/g)].map(
          (match) => match[1]!,
        ),
      )
      .filter((specifier) => !/^(?:react(?:-dom)?(?:\/|$)|@rezics\/|cn$)/.test(specifier)),
  ),
].sort();

const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },
  stories: [
    '../src/**/*.stories.tsx',
    ...(process.env.REZICS_UI_ACCESSIBILITY_PROBE === '1' ? ['../tests/fixtures/accessibility-probe.stories.tsx'] : []),
  ],
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.plugins ??= [];
    config.plugins.push(tailwindcss());
    config.optimizeDeps ??= {};
    config.optimizeDeps.include = [
      ...new Set([...(config.optimizeDeps.include ?? []), ...shadcnEntries, 'date-fns/locale']),
    ];
    return config;
  },
};

export default config;
