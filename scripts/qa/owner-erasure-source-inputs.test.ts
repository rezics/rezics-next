import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { producerModules } from '../../tests/qa/fault-recovery/owner-restore-erasure-fixture.ts';
import { fusekiBuildInputs, fusekiDockerfile } from '../dev/fuseki-image.ts';
import { sha256 } from '../fixture/corpus.ts';
import { migrationInventory } from '../fixture/manifest.ts';
import { sourceFileDigests, sourceKey, type SourceInputs } from './retained-source.ts';

test('owner-erasure inventory hashes current native, model, imported and declared inputs without a stack', () => {
  const root = resolve(import.meta.dir, '../..');
  const declared = ['tests/qa/fault-recovery/owner-restore-erasure-fixture.ts',
    'yarn.lock', 'package.json', 'services/main/package.json', 'services/content/package.json', 'services/account/package.json',
    'scripts/qa/owner-erasure-source-inputs.test.ts'];
  const modules = producerModules(root, declared);
  const producerDigests = sourceFileDigests(root, modules);
  const migrations = migrationInventory(root);
  const files = { ...producerDigests, ...migrations };
  const native = fusekiBuildInputs(root);
  expect(native).toContain(fusekiDockerfile);
  expect(native).toContain('infra/jena/patches/ThriftConvert.java');
  expect(native).toContain('infra/jena/command-module/pom.xml');
  expect(native).toContain('generated/model/manifest.json');
  const model = [...new Bun.Glob('packages/model/src/**/*').scanSync({ cwd: root, onlyFiles: true })];
  expect(model.length).toBeGreaterThan(0);
  // Include non-module data and a service reached through the producer's import closure.
  expect(model).toContain('packages/model/src/address/UNICODE-LICENSE.txt');
  for (const path of [...native, ...model, ...declared, 'services/main/src/modules/owner/operations.ts',
    ...Object.keys(migrations)]) {
    expect(files[path]).toBe(sha256(readFileSync(join(root, path))));
  }
  expect(modules.some(path => path.startsWith('infra/fuseki/'))).toBe(false);

  const specification: SourceInputs = {
    producer: 'owner-erasure-source', version: '1', files,
    inputs: { foregroundSeed: null, laterApiAdmission: false }, compatibility: { native: 'fixed-for-byte-check' },
  };
  const before = sourceKey(specification);
  const temp = join(root, '.temp');
  mkdirSync(temp, { recursive: true });
  const copy = mkdtempSync(join(temp, 'owner-erasure-inputs-'));
  try {
    for (const path of native) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      cpSync(join(root, path), join(copy, path));
    }
    expect(sourceFileDigests(copy, native)).toEqual(sourceFileDigests(root, native));
    for (const path of [fusekiDockerfile, 'infra/jena/patches/ThriftConvert.java']) {
      const original = readFileSync(join(copy, path));
      const changed = Buffer.from(original);
      changed[0] = changed[0]! ^ 1;
      writeFileSync(join(copy, path), changed);
      const next = { ...specification, files: { ...files, ...sourceFileDigests(copy, native) } };
      expect(next.files[path]).toBe(sha256(changed));
      expect(next.files[path]).not.toBe(files[path]);
      expect(sourceKey(next)).not.toBe(before);
      writeFileSync(join(copy, path), original);
      expect(sourceKey({ ...specification, files: { ...files, ...sourceFileDigests(copy, native) } })).toBe(before);
    }
    expect(sourceFileDigests(root, modules)).toEqual(producerDigests);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
