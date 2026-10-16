import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { independentRestoreSourceSpecification } from '../../tests/qa/fault-recovery/independent-restore-support.ts';
import { ownerErasureSourceSpecification, producerModules } from '../../tests/qa/fault-recovery/owner-restore-erasure-fixture.ts';
import { retainedContentSourceSpecification } from '../../tests/qa/fault-recovery/retained-content-source-support.ts';
import { realmSourceInputs } from '../../tests/qa/support/realm-discussion-source-runtime.ts';
import { fusekiBuildInputs } from '../dev/fuseki-image.ts';
import { loadCompatibility } from '../load/compatibility.ts';
import { isRetainedSourceInput, RETAINED_SOURCE_EXCLUDED_ROOTS, sourceFileDigests, sourceKey, type SourceInputs } from './retained-source.ts';
import { fixtureCorpus } from '../fixture/corpus.ts';
import { manifestCore, manifestIdentity } from '../fixture/manifest.ts';
import { fixtureOwners } from '../fixture/owners/index.ts';
import { workProfileCorpusId } from '../load/work-profile-corpus.ts';
import { seedSpecification } from '../../tests/qa/support/seed-specification.ts';
import { seedCheckpointPlan } from '../../tests/qa/support/seed-checkpoint-plan.ts';

const root = resolve(import.meta.dir, '../..');
const compatibility = { native: 'fixed-for-source-byte-check' };
// Exercise the same specifications the adapters publish, without engine inspection
// or producing a corpus. Both independent-restore variants have separate keys.
const adapters = [
  { name: 'owner-erasure-source', producer: 'tests/qa/fault-recovery/owner-restore-erasure-fixture.ts',
    specification: (directory: string) => ownerErasureSourceSpecification(directory, {}, compatibility) },
  { name: 'owner-erasure-source', variant: 'owner-later', producer: 'tests/qa/fault-recovery/owner-restore-erasure-fixture.ts',
    specification: (directory: string) => ownerErasureSourceSpecification(directory, { laterApiAdmission: true }, compatibility) },
  { name: 'independent-recipe-source', producer: 'tests/qa/fault-recovery/independent-restore-support.ts',
    specification: (directory: string) => independentRestoreSourceSpecification(directory, true, compatibility) },
  { name: 'independent-authority-source', producer: 'tests/qa/fault-recovery/independent-restore-support.ts',
    specification: (directory: string) => independentRestoreSourceSpecification(directory, false, compatibility) },
  { name: 'realm-discussion-source', producer: 'tests/qa/support/realm-discussion-source.ts',
    specification: realmSourceInputs },
  { name: 'retained-content-source-v1', producer: 'tests/qa/fault-recovery/retained-content-source-support.ts',
    specification: (directory: string) => retainedContentSourceSpecification(directory, compatibility) },
] as const;

test('the shared exclusion rule names orchestration roots and respects path boundaries', () => {
  expect(RETAINED_SOURCE_EXCLUDED_ROOTS).toContain('scripts/goal/');
  expect(RETAINED_SOURCE_EXCLUDED_ROOTS).toContain('scripts/qa/core.ts');
  expect(RETAINED_SOURCE_EXCLUDED_ROOTS).toContain('scripts/qa/memory-admission.ts');
  for (const path of ['scripts/goal/config.ts', './scripts/goal/new-tool.ts',
    'scripts/fixture/../goal/config.ts', 'scripts/qa/core.ts', 'scripts/qa/process/new-tool.ts']) {
    expect(isRetainedSourceInput(path), path).toBe(false);
  }
  for (const path of ['scripts/goalkeeper.ts', 'scripts/qa/core.tsx', 'scripts/fixture/stack.ts',
    'scripts/qa/retained-source.ts', 'services/main/src/modules/owner/operations.ts']) {
    expect(isRetainedSourceInput(path), path).toBe(true);
  }
});

for (const adapter of adapters) test(`${'variant' in adapter ? adapter.variant : adapter.name}: orchestration never changes the key; data inputs do`, async () => {
  const original = await adapter.specification(root);
  expect(original.producer).toBe(adapter.name);
  const temp = join(root, '.temp');
  mkdirSync(temp, { recursive: true });
  const copy = mkdtempSync(join(temp, 'retained-source-inputs-'));
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    writeFileSync(join(copy, path), bytes);
  };
  try {
    for (const path of Object.keys(original.files)) expect(isRetainedSourceInput(path), path).toBe(true);
    // Compatibility inventories and the shared walker's native-image inputs are
    // read independently of specification.files by some adapters.
    const fixtureFiles = new Set([...Object.keys(original.files), ...fusekiBuildInputs(root),
      ...Object.keys(loadCompatibility(root).files)]);
    for (const path of fixtureFiles) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      cpSync(join(root, path), join(copy, path));
    }
    const before = sourceKey(original);
    const specification = (): SourceInputs | Promise<SourceInputs> => adapter.specification(copy);
    expect(sourceKey(await specification())).toBe(before);

    // This is the original invalidation: changing only goalctl's config.
    write('scripts/goal/config.ts', readFileSync(join(root, 'scripts/goal/config.ts')));
    expect(sourceKey(await specification())).toBe(before);
    write('scripts/goal/config.ts', '// goalctl-only change\n');
    expect(sourceKey(await specification())).toBe(before);

    // Every excluded root can change, even adding imports of unrelated code.
    // Neither the harness bytes nor its new dependency belong in this corpus.
    write('unrelated-tool.ts', 'export const schedulingOnly = true;\n');
    const excluded = RETAINED_SOURCE_EXCLUDED_ROOTS.map(path => path.endsWith('/') ? `${path}new-tool.ts` : path);
    for (const path of excluded) write(path, `import '${'../'.repeat(path.split('/').length - 1)}unrelated-tool.ts';\n`);
    expect(sourceFileDigests(copy, excluded)).toEqual({});
    expect(producerModules(copy, excluded)).not.toContain('unrelated-tool.ts');
    expect(sourceKey(await specification())).toBe(before);

    const dataInputs = [adapter.producer, 'services/main/src/modules/work/metadata-schema.ts',
      'packages/model/src/address/UNICODE-LICENSE.txt', 'infra/jena/patches/ThriftConvert.java',
      Object.keys(original.files).find(path => path.endsWith('.sql'))!];
    for (const path of dataInputs) {
      expect(original.files[path], `included input: ${path}`).toBeDefined();
      const bytes = readFileSync(join(copy, path));
      write(path, Buffer.concat([bytes, Buffer.from('\n// changed source input\n')]));
      expect(sourceKey(await specification()), `changed input: ${path}`).not.toBe(before);
      write(path, bytes);
      expect(sourceKey(await specification())).toBe(before);
    }
    expect(sourceKey({ ...original, inputs: { ...original.inputs, corpusInput: 'different' } })).not.toBe(before);
    expect(sourceKey({ ...original, compatibility: { ...original.compatibility, image: 'different' } })).not.toBe(before);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 30_000);

test('small fixture and every seed cut keep their keys across tooling-only changes', () => {
  const engines = {
    fuseki: { image: 'fixed-fuseki', id: 'fixed-fuseki-digest' },
    postgres: { image: 'fixed-postgres', id: 'fixed-postgres-digest' },
    rustfs: { image: 'fixed-rustfs', id: 'fixed-rustfs-digest' },
  };
  const corpus = fixtureCorpus('small');
  const original = manifestCore(root, corpus, fixtureOwners, engines);
  const keys = (directory: string) => ({
    fixtureSmall: manifestIdentity(manifestCore(directory, corpus, fixtureOwners, engines)).id,
    seed: seedCheckpointPlan().map(stage => workProfileCorpusId(
      { ...seedSpecification, fixed: stage.fixed }, stage.axis, stage.scale, loadCompatibility(directory))),
  });
  const copy = mkdtempSync(join(root, '.temp/retained-storage-inputs-'));
  try {
    const paths = new Set(['generated/model/manifest.json', ...fusekiBuildInputs(root), ...Object.keys(original.migrations),
      ...Object.keys(original.account), ...Object.keys(loadCompatibility(root).files),
      ...Object.values(original.owners).flatMap(owner => Object.keys(owner.inputs))]);
    for (const path of paths) if (existsSync(join(root, path)) && statSync(join(root, path)).isFile()) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      cpSync(join(root, path), join(copy, path));
    }
    const before = keys(root);
    expect(keys(copy)).toEqual(before);
    for (const path of ['.goalctl/settings.json', ...RETAINED_SOURCE_EXCLUDED_ROOTS.map(path =>
      path.endsWith('/') ? `${path}new-tool.ts` : path)]) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      writeFileSync(join(copy, path), '// tooling-only change\n');
    }
    expect(keys(copy)).toEqual(before);
    const migration = Object.keys(original.migrations).find(path => path.startsWith('services/account/'))!;
    writeFileSync(join(copy, migration), readFileSync(join(copy, migration), 'utf8') + '\n-- changed storage input\n');
    const changed = keys(copy);
    expect(changed.fixtureSmall).not.toBe(before.fixtureSmall);
    for (const [index, key] of changed.seed.entries()) expect(key).not.toBe(before.seed[index]);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}, 30_000);
