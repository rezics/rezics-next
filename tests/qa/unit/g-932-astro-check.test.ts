import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const checker = join(root, 'apps/about/astro-check.cjs');

function check(cwd: string) {
  const result = Bun.spawnSync(['node', checker], {
    cwd,
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

test('G-932: Astro checks collection schemas in a clean checkout and after a schema change', () => {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const fixture = mkdtempSync(join(temporary, 'g-932-astro-'));
  try {
    mkdirSync(join(fixture, 'src/pages'), { recursive: true });
    writeFileSync(
      join(fixture, 'astro.config.mjs'),
      `
import { defineConfig } from 'astro/config';
export default defineConfig({ cacheDir: './cache/' });
`,
    );
    writeFileSync(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({
        extends: 'astro/tsconfigs/strict',
        include: ['src/**/*', '.astro/types.d.ts'],
      }),
    );
    const schema = (draft: boolean) => `
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
export const collections = { legal: defineCollection({
  loader: { name: 'test-legal', async load() {} },
  schema: z.object({ slug: z.string()${draft ? ', draft: z.boolean()' : ''} }),
}) };
`;
    writeFileSync(join(fixture, 'src/content.config.ts'), schema(true));
    writeFileSync(
      join(fixture, 'src/pages/index.astro'),
      `---
import { getCollection } from 'astro:content';
const policies = (await getCollection('legal')).filter(entry => !entry.data.draft);
---
<ul>{policies.map(entry => <li>{entry.data.slug}</li>)}</ul>
`,
    );
    expect(existsSync(join(fixture, '.astro/types.d.ts'))).toBe(false);
    const clean = check(fixture);
    expect(clean.code, clean.output).toBe(0);
    expect(readFileSync(join(fixture, '.astro/content.d.ts'), 'utf8')).toContain(
      'InferEntrySchema<"legal">',
    );

    // A previous successful sync must not hide an incompatible schema update.
    writeFileSync(join(fixture, 'src/content.config.ts'), schema(false));
    const changed = check(fixture);
    expect(changed.code, changed.output).not.toBe(0);
    expect(changed.output).toContain("Property 'draft' does not exist");
    expect(changed.output).not.toContain("implicitly has an 'any' type");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 150_000);
