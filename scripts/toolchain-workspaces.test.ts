import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

test('every workspace without SQL content mappers selects the measured Bun checker', async () => {
  const manifests = [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: root })].sort();
  let native = 0;
  let mapped = 0;
  for (const path of manifests) {
    const manifest = await Bun.file(resolve(root, path)).json();
    const config = await Bun.file(resolve(root, path, '../tsconfig.json')).text();
    if (config.includes('"contentMappers"')) {
      expect(manifest.scripts.typecheck, path).toContain('tsc --noEmit --runExternalCode');
      mapped += 1;
    } else {
      expect(manifest.scripts.typecheck, path).toContain('bun check --no-script -p tsconfig.json');
      native += 1;
    }
  }
  expect(native).toBe(11);
  expect(mapped).toBe(2);
});

test('client declaration generation retains tsc', async () => {
  const source = await Bun.file(resolve(root, 'services/kernel/scripts/client.ts')).text();
  expect(source).toContain('tsc');
  expect(source).toContain('emitDeclarationOnly: true');
});
