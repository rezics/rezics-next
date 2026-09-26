import { expect, test } from 'bun:test';
import { CargoResolutionInvalid, solveCargoSnapshot }
  from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoBytes, cargoLockFixture, withCargoLock, withCargoManifest }
  from '../fixtures/cargo-lock-snapshot.ts';
import { cargoIndexEntries, cargoIndexFile, cargoLinksFixture } from '../fixtures/cargo-links-snapshot.ts';
import { cargoFixture, withIndexLine } from '../fixtures/cargo-snapshot.ts';

test('PKG02/PKG12/PKG13: fresh yanked denial and exact caller lock reuse retain provenance', () => {
  const request = cargoLockFixture();
  const source = request.registryIndexUrl;
  const identity = { id: `${source}#leaf@1.0.0`, source, name: 'leaf', version: '1.0.0' };
  expect(solveCargoSnapshot(cargoLockFixture('fresh-yanked'))).toMatchObject({
    status: 'unsatisfiable', selected: [], instances: [], edges: [], reusedYanked: [],
    lockEvidence: null, linksConflicts: [], checksumConflicts: [],
    yankedConflicts: [{ ...identity, kind: 'yanked-not-locked',
      lockSource: `sparse+${source}`, indexChecksum: 'a'.repeat(64) }] });
  const result = solveCargoSnapshot(request);
  expect(result).toMatchObject({ status: 'solved', selected: [identity],
    lockEvidence: { provenance: 'caller-supplied', sha256: request.existingLock!.sha256,
      version: 4, packageCount: 2, registryPackageCount: 1 },
    reusedYanked: [{ ...identity, lockSource: `sparse+${source}`,
      lockChecksum: 'a'.repeat(64), indexChecksum: 'a'.repeat(64) }],
    yankedConflicts: [], checksumConflicts: [], linksConflicts: [] });
  expect(solveCargoSnapshot(cargoLockFixture('changed-root')).reusedYanked).toEqual(result.reusedYanked);
  expect(solveCargoSnapshot(cargoLockFixture('disconnected-lock')).selected).toEqual(result.selected);
  for (const kind of ['changed-requirement', 'changed-source', 'missing-source',
    'missing-lock-package'] as const) {
    expect(solveCargoSnapshot(cargoLockFixture(kind))).toMatchObject({
      status: 'unsatisfiable', selected: [], reusedYanked: [],
      yankedConflicts: [{ kind: 'yanked-not-locked' }] });
  }
  const changedRegistry = solveCargoSnapshot({ ...request,
    registryIndexUrl: 'https://changed.example.invalid/index/' });
  expect(changedRegistry.status).toBe('unsatisfiable');
  expect(changedRegistry.yankedConflicts?.[0]?.source).toBe('https://changed.example.invalid/index/');
});

test('PKG02/PKG13: absent checksums and inconsistent checksums are distinct from artifact verification', () => {
  expect(solveCargoSnapshot(cargoLockFixture('missing-checksum'))).toMatchObject({
    status: 'solved', reusedYanked: [{ lockChecksum: null, indexChecksum: 'a'.repeat(64) }] });
  for (const kind of ['changed-checksum', 'non-yanked-checksum-mismatch'] as const) {
    expect(solveCargoSnapshot(cargoLockFixture(kind))).toMatchObject({
      status: 'inconsistent-source-data', selected: [], instances: [], edges: [],
      reusedYanked: [], yankedConflicts: [], linksConflicts: [],
      checksumConflicts: [{ kind: 'lock-checksum', lockChecksum: '0'.repeat(64),
        indexChecksum: 'a'.repeat(64) }] });
  }
  expect(solveCargoSnapshot(cargoLockFixture('unselected-lock-checksum')).status).toBe('solved');
});

test('PKG02/PKG12: unselected yanks, compatible new non-yanked selections and links compose', () => {
  for (const kind of ['non-yanked', 'unselected-yanked', 'changed-requirement-non-yanked'] as const) {
    expect(solveCargoSnapshot(cargoLockFixture(kind))).toMatchObject({
      status: 'solved', reusedYanked: [], yankedConflicts: [], checksumConflicts: [] });
  }
  expect(solveCargoSnapshot(cargoLockFixture('changed-requirement-non-yanked')).selected[0]?.version)
    .toBe('2.0.0');
  const conflict = solveCargoSnapshot(cargoLockFixture('links-conflict'));
  expect(conflict).toMatchObject({ status: 'unsatisfiable', selected: [], reusedYanked: [],
    yankedConflicts: [], linksConflicts: [{ kind: 'native-links', links: 'native_shared',
      packages: [{ name: 'leaf' }, { name: 'other' }] }] });
  const both = solveCargoSnapshot({ ...cargoLockFixture('links-conflict'), existingLock: null });
  expect(both).toMatchObject({ status: 'unsatisfiable', linksConflicts: [],
    yankedConflicts: [{ name: 'leaf' }] });
});

test('PKG02/PKG13: malformed lock bytes and identities are rejected before retention', () => {
  const request = cargoLockFixture();
  const text = Buffer.from(request.existingLock!.bytesBase64, 'base64').toString('utf8');
  for (const malformed of ['version = [', text.replace('"leaf"', 'false'),
    text.replace('version = 4', 'version = 4.0'), text.replace('version = 4', 'version = 4e0'),
    text.replace('a'.repeat(64), 'not-a-checksum'),
    text + '\n[[package]]\nname = "leaf"\nversion = "1.0.0"\nsource = "sparse+'
      + request.registryIndexUrl + '"\n']) {
    expect(() => solveCargoSnapshot(withCargoLock(request, malformed))).toThrow(CargoResolutionInvalid);
  }
  expect(() => solveCargoSnapshot({ ...request, existingLock: {
    ...request.existingLock!, sha256: '0'.repeat(64) } })).toThrow(CargoResolutionInvalid);
  expect(() => solveCargoSnapshot({ ...request, existingLock: {
    ...request.existingLock!, bytesBase64: 'not base64' } })).toThrow(CargoResolutionInvalid);
  expect(() => solveCargoSnapshot({ ...request, existingLock: undefined } as never))
    .toThrow(CargoResolutionInvalid);
  for (const format of ['+4', '0x4', '0o4', '0b100']) {
    expect(solveCargoSnapshot(withCargoLock(request, text.replace('version = 4', `version = ${format}`)))
      .status).toBe('solved');
  }
  expect(() => solveCargoSnapshot({ ...request, registryIndexUrl: 'https://snapshot.example.invalid/../index/' }))
    .not.toThrow(); // The raw source identity is never silently normalized into the lock's source.
  const badFlag = cargoIndexEntries(request);
  expect(() => solveCargoSnapshot({ ...request, indexFiles: [cargoIndexFile('leaf',
    badFlag.map(entry => ({ ...entry, yanked: 'true' } as never)))] })).toThrow(CargoResolutionInvalid);
});

test('PKG02/PKG13: unsupported grammar, incomplete source and bounded work remain distinct', () => {
  const request = cargoLockFixture('links-conflict');
  const text = Buffer.from(request.existingLock!.bytesBase64, 'base64').toString('utf8');
  for (const unsupported of [text.replace('version = 4', 'version = 3'),
    text.replace('sparse+https:', 'registry+https:'), `${text}\n[metadata]\nvalue = 1\n`,
    text.replace('["leaf"]', '["leaf ^1.0"]'), text.replace('version = "1.0.0"', 'version = "1.0.0-beta"')]) {
    expect(solveCargoSnapshot(withCargoLock(request, unsupported))).toMatchObject({
      status: 'unsupported-semantics', lockEvidence: null, selected: [],
      reusedYanked: [], yankedConflicts: [], checksumConflicts: [], linksConflicts: [] });
  }
  expect(solveCargoSnapshot({ ...request, indexFiles: [] })).toMatchObject({
    status: 'incomplete-source-data', selected: [], yankedConflicts: [], linksConflicts: [] });
  expect(solveCargoSnapshot({ ...request, features: ['unknown'] })).toMatchObject({
    status: 'unsupported-semantics', yankedConflicts: [], linksConflicts: [] });
  const manyPackages = 'version = 4\n' + Array.from({ length: 130 }, (_, i) =>
    `\n[[package]]\nname = "item${i}"\nversion = "1.0.0"\n`).join('');
  const manyReferences = text.replace('["leaf"]', JSON.stringify(Array(257).fill('leaf')));
  for (const oversized of [manyPackages, manyReferences]) {
    expect(solveCargoSnapshot(withCargoLock(request, oversized))).toMatchObject({
      status: 'budget-exhausted', selected: [], lockEvidence: null, yankedConflicts: [], linksConflicts: [] });
  }
});

test('PKG02/PKG13: v1/v2 yanked receipts remain frozen', () => {
  for (const profile of ['cargo-index-exact-resolver2-v1', 'cargo-index-exact-resolver2-v2'] as const) {
    const result = solveCargoSnapshot(withIndexLine({ ...cargoFixture(), profile }, 'bridge',
      entry => ({ ...entry, yanked: true })));
    expect(result).toEqual({ status: 'unsupported-semantics', selected: [], instances: [],
      edges: [], missing: [], unsupportedClauses: ['yanked Cargo release'],
      releaseCount: 0, edgeCount: 0, featureActivationCount: 0,
      ...(profile.endsWith('v2') ? { linksConflicts: [] } : {}) });
  }
});

test('PKG19/PKG13: lock work is bounded by supplied history and selected graph', () => {
  const request = cargoLockFixture();
  const text = Buffer.from(request.existingLock!.bytesBase64, 'base64').toString('utf8');
  const baseline = solveCargoSnapshot(request);
  for (const count of [1, 8, 24]) {
    const history = Array.from({ length: count }, (_, index) =>
      `\n[[package]]\nname = "old${index}"\nversion = "1.0.0"\n`
      + `source = "sparse+https://other.example.invalid/index/"\n`).join('');
    const result = solveCargoSnapshot(withCargoLock(request, text + history));
    expect(result.selected).toEqual(baseline.selected);
    expect(result.reusedYanked).toEqual(baseline.reusedYanked);
    expect(result.edgeCount).toBe(baseline.edgeCount);
    expect(result.featureActivationCount).toBe(baseline.featureActivationCount);
    expect(result.lockEvidence?.packageCount).toBe(2 + count);
  }
  const prior = cargoLinksFixture('single-owner');
  const entries = cargoIndexEntries(prior);
  const lock = 'version = 4\n' + entries.map(entry => `\n[[package]]\nname = "${entry.name}"\n`
    + `version = "${entry.vers}"\nsource = "sparse+${prior.registryIndexUrl}"\nchecksum = "${entry.cksum}"\n`).join('');
  const input = { ...prior, profile: 'cargo-index-exact-resolver2-v3' as const,
    existingLock: cargoBytes(lock), indexFiles: prior.indexFiles.map(file => cargoIndexFile(file.name,
      entries.filter(entry => entry.name === file.name).map(entry => ({ ...entry, yanked: true })))) };
  const graph = solveCargoSnapshot(input);
  expect(graph.status).toBe('solved');
  expect(graph.selected).toEqual(solveCargoSnapshot(prior).selected);
  expect(graph.reusedYanked).toHaveLength(4);
  const shuffled = { ...input, indexFiles: input.indexFiles.toReversed() };
  expect(solveCargoSnapshot(shuffled)).toEqual(graph);
  expect(solveCargoSnapshot(withCargoManifest(input, Buffer.from(input.manifestBase64, 'base64')
    .toString('utf8') + '\n')).reusedYanked).toEqual(graph.reusedYanked);
});
