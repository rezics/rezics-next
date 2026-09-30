import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifactNames,
  assertCurrentFrontier,
  assertFreshTarget,
  assertRestoredRuntime,
  assertSafeTar,
  assertSeparateCustody,
  fileDigest,
  openIndex,
  openManifest,
  RecoveryBudget,
  seal,
  verifyArtifacts,
  type RecoveryIndex,
  type RecoveryManifest,
} from '../recovery-set.ts';

const key = 'a7'.repeat(32);
const sha = 'a'.repeat(64);
const rows = {
  pg: { systemIdentifier: '123', flushedLsn: '0/AB', walFile: '000000010000000000000000' },
  catalogDigest: sha,
  tables: { 'owner.receipt': { count: '1', digest: sha } },
  excluded: {},
};
const engine = { image: 'pinned', id: `sha256:${sha}` };
const manifest: RecoveryManifest = {
  version: 1,
  id: 'cut',
  capturedAt: '2026-10-01T00:00:00Z',
  source: 'rezics-qa-original',
  lineage: { dataEpoch: 'epoch', routingEpoch: '1', sequence: '2' },
  fenceGeneration: '1',
  sealedCoverage: 'signed-coverage',
  sealedDeletionSets: [],
  owners: { account: rows, access: rows, content: rows, relay: rows },
  operations: 'relay',
  release: {
    digest: sha,
    inputs: {},
    engines: { postgres: engine, fuseki: engine, rustfs: engine },
    graph: {
      imageId: engine.id,
      stateVolume: 'original-volume',
      serverAssembler: '/fuseki/fuseki-text-qa.ttl',
      serverAssemblerSha256: sha,
      indexerAssemblerSha256: sha,
      fusekiJarSha256: sha,
      commandJarSha256: sha,
      moduleVersion: 'pinned',
      facts: {
        tdb2Location: 'tdb2',
        luceneDirectory: 'lucene',
        analyzer: 'pinned',
        textDatasets: 1,
      },
    },
    javaBuild: 'OpenJDK pinned',
    assemblers: { server: 'server assembler', indexer: 'indexer assembler' },
  },
  phases: {},
};
const index: RecoveryIndex = {
  version: 1,
  id: 'cut',
  manifestDigest: sha,
  artifacts: artifactNames.map((file) => ({ file, sha256: sha, bytes: 1 })),
};

test('G-727: a missing owner, older manifest format and a tampered signature fail closed', () => {
  expect(openManifest(seal(manifest, key, 'ops-recovery-manifest'), key)).toEqual(manifest);
  const { content: _content, ...owners } = manifest.owners;
  expect(() =>
    openManifest(seal({ ...manifest, owners }, key, 'ops-recovery-manifest'), key),
  ).toThrow('incomplete');
  expect(() =>
    openManifest(seal({ ...manifest, version: 0 }, key, 'ops-recovery-manifest'), key),
  ).toThrow('invalid');
  const envelope = JSON.parse(seal(manifest, key, 'ops-recovery-manifest'));
  envelope.mac = 'f'.repeat(64);
  expect(() => openManifest(JSON.stringify(envelope), key)).toThrow('authentication');
});

test('G-727: current independent custody rejects older or mixed cuts and duplicate/missing artifacts', () => {
  const frontier = (id: string, manifestDigest = sha) =>
    seal(
      { version: 1, id, manifestDigest, capturedAt: '2026-10-01' },
      key,
      'ops-recovery-frontier',
    );
  expect(() => assertCurrentFrontier(index, frontier('cut'), key)).not.toThrow();
  expect(() => assertCurrentFrontier(index, frontier('newer'), key)).toThrow('older');
  expect(() => assertCurrentFrontier(index, frontier('cut', 'b'.repeat(64)), key)).toThrow(
    'differs',
  );
  expect(openIndex(seal(index, key, 'ops-recovery-index'), key)).toEqual(index);
  expect(() =>
    openIndex(
      seal({ ...index, artifacts: index.artifacts.slice(1) }, key, 'ops-recovery-index'),
      key,
    ),
  ).toThrow('incomplete');
  expect(() =>
    openIndex(
      seal(
        { ...index, artifacts: index.artifacts.map(() => index.artifacts[0]) },
        key,
        'ops-recovery-index',
      ),
      key,
    ),
  ).toThrow('incomplete');
});

test('G-727: restore refuses the original, running/occupied projects and traversal before mutation', () => {
  expect(() => assertFreshTarget('rezics-qa-new', manifest, () => false)).not.toThrow();
  for (const project of ['rezics-qa-original', 'rezics-dev', 'rezics-qa-../old']) {
    expect(() => assertFreshTarget(project, manifest, () => false)).toThrow('new empty');
  }
  expect(() => assertFreshTarget('rezics-qa-new', manifest, () => true)).toThrow('new empty');
  expect(() => assertSeparateCustody('/tmp/set', '/tmp/set/frontier')).toThrow('outside');
  expect(() => assertSeparateCustody('/tmp/set', '/tmp/authority/frontier')).not.toThrow();
});

test('G-727: a same-size encrypted artifact corruption fails before decryption', async () => {
  mkdirSync(join(import.meta.dir, '../../../..', '.temp', 'ops'), { recursive: true });
  const directory = mkdtempSync(join(import.meta.dir, '../../../..', '.temp', 'ops', 'checksum-'));
  try {
    const artifacts: RecoveryIndex['artifacts'] = [];
    for (const file of artifactNames) {
      writeFileSync(join(directory, file), 'encrypted');
      artifacts.push({ file, sha256: await fileDigest(join(directory, file)), bytes: 9 });
    }
    await expect(verifyArtifacts(directory, { ...index, artifacts })).resolves.toBeUndefined();
    writeFileSync(join(directory, 'graph.tar.gpg'), 'tampered!');
    await expect(verifyArtifacts(directory, { ...index, artifacts })).rejects.toThrow('checksum');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G-727: archives reject traversal and links before extraction', async () => {
  const root = join(import.meta.dir, '../../../..');
  mkdirSync(join(root, '.temp', 'ops'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp', 'ops', 'archive-'));
  const source = join(directory, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'safe'), 'bytes');
  const archive = join(directory, 'owner.tar');
  const tar = (args: string[]) => {
    const result = spawnSync('tar', args, { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error('Test tar preparation failed');
  };
  try {
    tar(['-cf', archive, '-C', source, 'safe']);
    await expect(assertSafeTar(archive, new RecoveryBudget())).resolves.toBeUndefined();
    tar(['-cf', archive, '-C', source, '--transform=s|^safe$|../safe|', 'safe']);
    await expect(assertSafeTar(archive, new RecoveryBudget())).rejects.toThrow('unsafe');
    symlinkSync('/tmp', join(source, 'outside'));
    tar(['-cf', archive, '-C', source, '.']);
    await expect(assertSafeTar(archive, new RecoveryBudget())).rejects.toThrow('unsafe');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G-727: a restored runtime must match the captured JAR, assembler and Java pins', () => {
  const restored = { ...manifest.release.graph, stateVolume: 'new-volume' };
  expect(() =>
    assertRestoredRuntime(manifest.release, restored, manifest.release.javaBuild),
  ).not.toThrow();
  expect(() =>
    assertRestoredRuntime(
      manifest.release,
      { ...restored, commandJarSha256: 'b'.repeat(64) },
      manifest.release.javaBuild,
    ),
  ).toThrow('pins differ');
  expect(() =>
    assertRestoredRuntime(
      manifest.release,
      { ...restored, serverAssemblerSha256: 'b'.repeat(64) },
      manifest.release.javaBuild,
    ),
  ).toThrow('pins differ');
  expect(() => assertRestoredRuntime(manifest.release, restored, 'another Java build')).toThrow(
    'pins differ',
  );
});
