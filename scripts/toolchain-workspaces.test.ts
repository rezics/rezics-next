import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

test('each workspace selects a checker compatible with its project', async () => {
  const manifests = [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: root })].sort();
  let native = 0;
  let mapped = 0;
  for (const path of manifests) {
    const manifest = await Bun.file(resolve(root, path)).json();
    const config = await Bun.file(resolve(root, path, '../tsconfig.json')).text();
    const script: string = manifest.scripts.typecheck;
    if (config.includes('"contentMappers"')) {
      const typecheck = script.startsWith('bun scripts/typecheck.ts')
        ? await Bun.file(resolve(root, path, '../scripts/typecheck.ts')).text()
        : script;
      const command = typecheck.replace(/['",]/g, '').replace(/\s+/g, ' ');
      expect(command, path).toMatch(/\btsc --noEmit (?:\.\.\.\w+ )*--runExternalCode\b/);
      mapped += 1;
    } else {
      const project = /\bbun check --no-script -p (tsconfig(?:\.[\w-]+)?\.json)\b/.exec(script)?.[1];
      expect(project, path).toBeDefined();
      expect(await Bun.file(resolve(root, path, '..', project!)).exists(), path).toBe(true);
      native += 1;
    }
  }
  expect(native).toBeGreaterThan(0);
  expect(mapped).toBeGreaterThan(0);
});

test('client declaration generation retains tsc', async () => {
  const source = await Bun.file(resolve(root, 'services/kernel/scripts/client.ts')).text();
  expect(source).toContain('tsc');
  expect(source).toContain('emitDeclarationOnly: true');
});
