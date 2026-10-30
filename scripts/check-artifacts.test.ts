import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CHECK_ARTIFACTS_MAX_BYTES,
  artifactRunRelativePath,
  captureArtifactReturns,
  cleanupArtifactRun,
  prepareArtifactRun,
  registerArtifactDeclarations,
  restoreArtifactReturns,
  validateArtifactDeclarations,
} from './check-artifacts.ts';

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
  await registerArtifactDeclarations(root, stage, physicalRunId, paths);
  const stale = join(root, paths[0]!);
  writeFileSync(stale, 'stale proof');
  const oversized = join(root, paths[1]!);
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
