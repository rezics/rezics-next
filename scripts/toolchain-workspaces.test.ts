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
      // A workspace may run the same tsc through its own scripts/typecheck.ts (the kernel places it on a check host).
      const script: string = manifest.scripts.typecheck;
      const typecheck = script.startsWith('bun scripts/typecheck.ts')
        ? await Bun.file(resolve(root, path, '../scripts/typecheck.ts')).text()
        : script;
      expect(typecheck.replace(/['",]/g, '').replace(/\s+/g, ' '), path).toContain('tsc --noEmit --runExternalCode');
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
