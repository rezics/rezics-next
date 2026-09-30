import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogs } from '../src/i18n/messages/index.ts';
import { uiLocales } from '../src/i18n/locales.ts';

const root = resolve(import.meta.dir, '../../..');
let fixtureRoot: string;

beforeAll(() => {
  const temp = join(root, '.temp');
  mkdirSync(temp, { recursive: true });
  fixtureRoot = mkdtempSync(join(temp, 'about-status-badge-'));
  mkdirSync(join(fixtureRoot, 'src/pages'), { recursive: true });
  // Astro discovers renderer bundling from the workspace's declared dependencies.
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    readFileSync(join(root, 'apps/about/package.json'), 'utf8'),
  );
  writeFileSync(
    join(fixtureRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' },
    }),
  );
  writeFileSync(
    join(fixtureRoot, 'astro.config.mjs'),
    `
    import react from '@astrojs/react';
    import { defineConfig } from 'astro/config';
    export default defineConfig({
      integrations: [react()],
      build: { format: 'directory' },
      devToolbar: { enabled: false },
    });
  `,
  );
  writeFileSync(
    join(fixtureRoot, 'src/pages/[locale].astro'),
    `---
    import Fixture from ${JSON.stringify(join(import.meta.dir, 'fixtures/StatusBadge.astro'))};
    export const getStaticPaths = () => ${JSON.stringify(uiLocales)}.map(locale => ({ params: { locale } }));
    const locale = Astro.params.locale;
    ---
    <Fixture locale={locale} />
  `,
  );
  // Build a separate test site. Its synthetic Later input never enters the public dist.
  const build = Bun.spawnSync([join(root, 'node_modules/.bin/astro'), 'build'], {
    cwd: fixtureRoot,
    env: { ...process.env, NODE_ENV: 'production', ASTRO_TELEMETRY_DISABLED: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0)
    throw new Error(
      `badge fixture build failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`,
    );
}, 180_000);

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

test('a synthetic Later feature renders one localized label; launch and principles render none', () => {
  for (const locale of uiLocales) {
    const source = readFileSync(join(fixtureRoot, 'dist', locale, 'index.html'), 'utf8');
    const samples = new Map(
      [...source.matchAll(/<div data-fixture="(\w+)">([\s\S]*?)<\/div>/g)].map(([, kind, body]) => [
        kind,
        body!,
      ]),
    );
    expect(samples.size, locale).toBe(3);
    const later = samples.get('later')!;
    const words = catalogs.site[locale].status;
    expect([...source.matchAll(/data-status=/g)], locale).toHaveLength(1);
    expect(later).toContain('data-status="later"');
    expect(later).toContain(`lang="${locale}"`);
    expect(later).toContain(`title="${words.laterHelp}"`);
    expect(later.replace(/<[^>]*>/g, '').trim()).toBe(words.later);
    expect(samples.get('launch')?.trim(), locale).toBe('');
    expect(samples.get('principle')?.trim(), locale).toBe('');
  }
});
