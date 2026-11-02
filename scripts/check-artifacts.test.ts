import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CHECK_ARTIFACTS_MAX_BYTES,
  CHECK_ARTIFACTS_MAX_FILES,
  artifactRunRelativePath,
  captureArtifactReturns,
  cleanupArtifactRun,
  prepareArtifactRun,
  parseArtifactManifest,
  registerArtifactDeclarations,
  restoreArtifactReturns,
  validateArtifactDeclarations,
} from './check-artifacts.ts';

import {
  KERNEL_CLIENT_OUTPUT as PROFILE,
  encodeOutputTree,
  outputTreeDigest,
  receiveOutputTrees,
} from './check-output-tree.ts';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(import.meta.dir, '../.temp/check-artifacts-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('bounded artifact returns preserve exact bytes and spaced literal paths for one physical run', async () => {
  const root = workspace();
  const physicalRunId = randomUUID();
  const paths = ['browser output/frame #1.png', 'browser output/result.bin'];
  const expected = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]), Buffer.from([0, 1, 2, 0, 254])];
  const stage = prepareArtifactRun(root, physicalRunId);
  await registerArtifactDeclarations(root, stage, physicalRunId, paths);
  for (let index = 0; index < paths.length; index += 1) {
    const output = join(root, paths[index]!);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, expected[index]!);
  }
  await captureArtifactReturns(root, stage, physicalRunId, paths);
  const restored = restoreArtifactReturns(root, stage, physicalRunId);
  expect(restored.missing).toEqual([]);
  expect(restored.rejected).toEqual([]);
  expect(restored.restored).toEqual(
    paths.map((path, index) => ({
      path,
      size: expected[index]!.length,
      sha256: createHash('sha256').update(expected[index]!).digest('hex'),
    })),
  );
  for (let index = 0; index < paths.length; index += 1) {
    expect(readFileSync(join(root, paths[index]!))).toEqual(expected[index]!);
  }
  cleanupArtifactRun(root, physicalRunId);
  expect(() => readFileSync(join(root, artifactRunRelativePath(physicalRunId)))).toThrow();
});

test('bounded artifact declarations reject path escape and symlink escape before touching the target', async () => {
  const root = workspace();
  const outside = join(root, '..', `outside-${randomUUID()}`);
  roots.push(outside);
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'untouched');
  symlinkSync(outside, join(root, 'linked'), 'dir');
  const physicalRunId = randomUUID();
  const stage = prepareArtifactRun(root, physicalRunId);
  expect(() => validateArtifactDeclarations(['../outside.txt'])).toThrow('contained workspace-relative');
  expect(() => validateArtifactDeclarations(['/tmp/absolute.png'])).toThrow('contained workspace-relative');
  expect(() => validateArtifactDeclarations(['line\nbreak.png'])).toThrow('contained workspace-relative');
  await expect(registerArtifactDeclarations(root, stage, physicalRunId, ['linked/escape.txt'])).rejects.toThrow(
    'unsafe output parent',
  );
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('untouched');
});

test('bounded artifact returns retain missing and oversize evidence without restoring stale outputs', async () => {
  const root = workspace();
  const physicalRunId = randomUUID();
  const paths = ['report with space.png', 'too large.bin'];
  const stage = prepareArtifactRun(root, physicalRunId);
  const stale = join(root, paths[0]!);
  writeFileSync(stale, 'stale proof');
  await registerArtifactDeclarations(root, stage, physicalRunId, paths);
  const oversized = join(root, paths[1]!);
  writeFileSync(oversized, '');
  truncateSync(oversized, CHECK_ARTIFACTS_MAX_BYTES + 1);
  await captureArtifactReturns(root, stage, physicalRunId, paths);
  const restored = restoreArtifactReturns(root, stage, physicalRunId);
  expect(restored.missing).toEqual([paths[0]!]);
  expect(restored.rejected.join('\n')).toContain(`${paths[1]}: oversize`);
  expect(() => readFileSync(stale)).toThrow();
  expect(() => readFileSync(oversized)).toThrow();
});

test('repeated physical runs clear prior declared output and reject a different run stage', async () => {
  const root = workspace();
  const path = 'nested result/screenshot.png';
  const first = randomUUID();
  const firstStage = prepareArtifactRun(root, first);
  await registerArtifactDeclarations(root, firstStage, first, [path]);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), 'first run bytes');
  await captureArtifactReturns(root, firstStage, first, [path]);
  expect(restoreArtifactReturns(root, firstStage, first).restored).toHaveLength(1);
  cleanupArtifactRun(root, first);

  const second = randomUUID();
  const secondStage = prepareArtifactRun(root, second);
  await registerArtifactDeclarations(root, secondStage, second, [path]);
  expect(() => readFileSync(join(root, path))).toThrow();
  await expect(registerArtifactDeclarations(root, firstStage, second, [path])).rejects.toThrow(
    'does not match the physical run',
  );
  await captureArtifactReturns(root, secondStage, second, [path]);
  const result = restoreArtifactReturns(root, secondStage, second);
  expect(result.restored).toEqual([]);
  expect(result.missing).toEqual([path]);
});

test('a failed inner command can stage declared bytes before the outer owner cleans its physical directory', async () => {
  const root = workspace();
  const physicalRunId = randomUUID();
  const path = 'failed run/result.png';
  const stage = prepareArtifactRun(root, physicalRunId);
  await registerArtifactDeclarations(root, stage, physicalRunId, [path]);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  const bytes = Buffer.from([137, 80, 78, 71, 0, 0, 1, 2]);
  writeFileSync(join(root, path), bytes);
  try {
    throw new Error('fixture command failed after writing evidence');
  } catch {
    await captureArtifactReturns(root, stage, physicalRunId, [path]);
  }
  const restored = restoreArtifactReturns(root, stage, physicalRunId);
  expect(restored.restored[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  cleanupArtifactRun(root, physicalRunId);
  expect(readFileSync(join(root, path))).toEqual(bytes);
});

test('directory declarations return bounded child files and leave unrelated workspace files alone', async () => {
  const root = workspace();
  const physicalRunId = randomUUID();
  const directory = 'browser output';
  const unrelated = join(root, 'keep this file.bin');
  writeFileSync(unrelated, 'unchanged');
  const stage = prepareArtifactRun(root, physicalRunId);
  await registerArtifactDeclarations(root, stage, physicalRunId, [directory]);
  mkdirSync(join(root, directory), { recursive: true });
  const expected = new Map([
    ['frame #1.png', Buffer.from([137, 80, 78, 71, 0, 255])],
    ['trace data.bin', Buffer.from([0, 1, 2, 0, 253])],
  ]);
  for (const [name, bytes] of expected) writeFileSync(join(root, directory, name), bytes);
  await captureArtifactReturns(root, stage, physicalRunId, [directory]);
  const restored = restoreArtifactReturns(root, stage, physicalRunId, randomUUID());
  expect(restored.missing).toEqual([]);
  expect(restored.rejected).toEqual([]);
  for (const [name, bytes] of expected) expect(readFileSync(join(root, directory, name))).toEqual(bytes);
  expect(readFileSync(unrelated, 'utf8')).toBe('unchanged');
});

test('ordinary declarations and directory returns retain the exact 64/65 file bound', async () => {
  expect(CHECK_ARTIFACTS_MAX_FILES).toBe(64);
  expect(validateArtifactDeclarations(Array.from({ length: 64 }, (_, i) => `f${i}`))).toHaveLength(64);
  expect(() => validateArtifactDeclarations(Array.from({ length: 65 }, (_, i) => `f${i}`))).toThrow('at most 64');
  const root = mkdtempSync('/dev/shm/rezics-artifact-bound-');
  roots.push(root);
  const physical = randomUUID();
  const stage = prepareArtifactRun(root, physical);
  await registerArtifactDeclarations(root, stage, physical, ['outputs']);
  mkdirSync(join(root, 'outputs'));
  for (let i = 0; i < 64; i++) writeFileSync(join(root, `outputs/f${i}`), String(i));
  await captureArtifactReturns(root, stage, physical, ['outputs']);
  expect(restoreArtifactReturns(root, stage, physical).restored).toHaveLength(64);
  writeFileSync(join(root, 'outputs/overflow'), '65');
  await captureArtifactReturns(root, stage, physical, ['outputs']);
  const rejected = restoreArtifactReturns(root, stage, physical);
  expect(rejected.rejected.length).toBeGreaterThan(0);
});

test('nested physical artifact envelopes carry the complete named tree and retain schema 1 compatibility', async () => {
  const root = mkdtempSync('/dev/shm/rezics-nested-tree-');
  roots.push(root);
  const physical = randomUUID();
  const binding = { host: 'a', run: 'native-physical-run', sourceSha256: 'a'.repeat(64) };
  const stage = prepareArtifactRun(root, physical);
  await registerArtifactDeclarations(root, stage, physical, [PROFILE.transport, 'schema.sql']);
  for (let i = 0; i < 282; i++) {
    const file = join(root, PROFILE.root, `nested/f${i}.d.ts`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `export type Value${i} = ${i};\n`);
  }
  const bundle = encodeOutputTree(root, binding);
  mkdirSync(dirname(join(root, PROFILE.transport)), { recursive: true });
  writeFileSync(join(root, PROFILE.transport), bundle);
  writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE proof(id int);\n');
  await captureArtifactReturns(root, stage, physical, [PROFILE.transport, 'schema.sql']);
  const relative = artifactRunRelativePath(physical);
  const envelope = JSON.parse(readFileSync(join(root, relative, 'manifest.json'), 'utf8'));
  expect(envelope.version).toBe(1);
  expect(envelope.entries).toHaveLength(2);
  const paths = [
    `${relative}/manifest.json`,
    ...envelope.entries.map((entry: { file: string }) => `${relative}/${entry.file}`),
  ];
  const entries = paths.map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, size: bytes.length, sha256: outputTreeDigest(bytes), kind: 'file' as const };
  });
  rmSync(join(root, PROFILE.root), { recursive: true });
  mkdirSync(join(root, PROFILE.root));
  writeFileSync(join(root, PROFILE.root, 'obsolete.d.ts'), 'obsolete');
  writeFileSync(join(root, 'packages/client/src/sibling.ts'), 'untouched');
  // The old receiver cannot promote a bundle without the physical terminal publication.
  expect(restoreArtifactReturns(root, stage, physical).rejected.join('\n')).toContain(PROFILE.transport);
  expect(readFileSync(join(root, PROFILE.root, 'obsolete.d.ts'), 'utf8')).toBe('obsolete');
  receiveOutputTrees(root, root, { status: 'complete', entries }, { ...binding, exitCode: 0 }, [relative]);
  const restored = restoreArtifactReturns(root, stage, physical);
  expect(restored.rejected).toEqual([]);
  expect(restored.restored).toHaveLength(2);
  expect(readFileSync(join(root, PROFILE.root, 'nested/f281.d.ts'), 'utf8')).toBe('export type Value281 = 281;\n');
  expect(() => readFileSync(join(root, PROFILE.root, 'obsolete.d.ts'))).toThrow();
  expect(readFileSync(join(root, 'packages/client/src/sibling.ts'), 'utf8')).toBe('untouched');
});

test('nested mixed emission validates the complete authenticated schema catalogue before tree publication', async () => {
  const root = mkdtempSync('/dev/shm/rezics-nested-invalid-');
  roots.push(root);
  const physical = randomUUID();
  const binding = { host: 'a', run: 'native-mixed-run', sourceSha256: 'a'.repeat(64) };
  const stage = prepareArtifactRun(root, physical);
  await registerArtifactDeclarations(root, stage, physical, [PROFILE.transport, 'schema.sql']);
  mkdirSync(join(root, PROFILE.root), { recursive: true });
  writeFileSync(join(root, PROFILE.root, 'new.d.ts'), 'export type Fresh = true;\n');
  const bundle = encodeOutputTree(root, binding);
  mkdirSync(dirname(join(root, PROFILE.transport)), { recursive: true });
  writeFileSync(join(root, PROFILE.transport), bundle);
  writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE proof(id int);\n');
  await captureArtifactReturns(root, stage, physical, [PROFILE.transport, 'schema.sql']);
  const relative = artifactRunRelativePath(physical);
  const manifestPath = join(root, relative, 'manifest.json');
  const original = readFileSync(manifestPath);
  const envelope = parseArtifactManifest(original, physical)!;
  rmSync(join(root, PROFILE.root), { recursive: true });
  mkdirSync(join(root, PROFILE.root));
  writeFileSync(join(root, PROFILE.root, 'obsolete.d.ts'), 'old');
  for (const mode of ['missing', 'failed', 'wrong-hash', 'duplicate-file', 'undeclared'] as const) {
    const changed = structuredClone(envelope);
    const schema = changed.entries.find((entry) => entry.path === 'schema.sql')!;
    if (mode === 'missing') changed.entries = changed.entries.filter((entry) => entry !== schema);
    if (mode === 'failed') schema.status = 'missing';
    if (mode === 'wrong-hash') schema.sha256 = 'f'.repeat(64);
    if (mode === 'duplicate-file')
      schema.file = changed.entries.find((entry) => entry.path === PROFILE.transport)!.file;
    if (mode === 'undeclared') schema.path = 'unowned.sql';
    writeFileSync(manifestPath, JSON.stringify(changed));
    const paths = [`${relative}/manifest.json`, ...envelope.entries.map((entry) => `${relative}/${entry.file!}`)];
    const entries = paths.map((path) => {
      const bytes = readFileSync(join(root, path));
      return { path, size: bytes.length, sha256: outputTreeDigest(bytes), kind: 'file' as const };
    });
    expect(() =>
      receiveOutputTrees(root, root, { status: 'complete', entries }, { ...binding, exitCode: 0 }, [relative]),
    ).toThrow();
    expect(readFileSync(join(root, PROFILE.root, 'obsolete.d.ts'), 'utf8')).toBe('old');
    expect(() => readFileSync(join(root, PROFILE.root, 'new.d.ts'))).toThrow();
  }
  // Pre-extension ordinary schema-1 manifests remain readable without optional hashes/declarations.
  const old = {
    version: 1,
    physicalRunId: physical,
    entries: [{ path: 'ordinary.txt', status: 'returned', file: 'files/000.bin', size: 3 }],
  };
  expect(parseArtifactManifest(Buffer.from(JSON.stringify(old)), physical)?.entries).toEqual(old.entries);
  expect(parseArtifactManifest(Buffer.alloc(256 * 1024 + 1), physical)).toBeUndefined();
});
