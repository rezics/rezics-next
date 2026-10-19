import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { resolveConfig } from 'vite';

const config = await resolveConfig({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts') }, 'serve');

test('browser prebundling does not force client packages into the RSC optimizer', () => {
  const client = config.environments.client!.optimizeDeps.include ?? [];
  const rsc = config.environments.rsc!.optimizeDeps.include ?? [];
  for (const dependency of ['@ark-ui/react/dialog', '@tanstack/react-query', 'lucide-react']) {
    expect(client).toContain(dependency);
    expect(rsc).not.toContain(dependency);
  }
});

test('both server environments prepare shared styling and localization dependencies before rendering', () => {
  for (const environment of ['rsc', 'ssr']) {
    const dependencies = config.environments[environment]!.optimizeDeps.include ?? [];
    expect(dependencies).toContain('tailwind-variants');
    expect(dependencies).toContain('native-i18n');
  }
});
