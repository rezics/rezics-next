import { expect, test } from 'bun:test';
import { CargoResolutionInvalid, solveCargoSnapshot }
  from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoFixture, withIndexLine } from '../fixtures/cargo-snapshot.ts';
import { cargoIndexEntries, cargoIndexFile, cargoLinksFixture } from '../fixtures/cargo-links-snapshot.ts';

test('PKG02/PKG12/PKG13: exact Cargo links conflict witnesses preserve identity and roles', () => {
  const request = cargoLinksFixture();
  const result = solveCargoSnapshot(request);
  expect(result).toMatchObject({ status: 'unsatisfiable', selected: [], instances: [],
    edges: [], missing: [], unsupportedClauses: [], linksConflicts: [{
      kind: 'native-links', links: 'native_shared', packages: [
        { id: `${request.registryIndexUrl}#shared@1.0.0`, source: request.registryIndexUrl,
          name: 'shared', version: '1.0.0', roles: ['host', 'target'] },
        { id: `${request.registryIndexUrl}#shared@2.0.0`, source: request.registryIndexUrl,
          name: 'shared', version: '2.0.0', roles: ['target'] },
      ],
    }] });
  const reordered = { ...request, indexFiles: [...request.indexFiles].reverse().map(file =>
    cargoIndexFile(file.name, cargoIndexEntries({ ...request, indexFiles: [file] }).reverse())) };
  expect(solveCargoSnapshot(reordered)).toEqual(result);
  const otherSource = 'https://other.example.invalid/index/';
  const changed = solveCargoSnapshot({ ...request, registryIndexUrl: otherSource });
  expect(changed.linksConflicts?.[0]?.packages.every(item => item.source === otherSource
    && item.id.startsWith(otherSource))).toBe(true);
  const differentNames = solveCargoSnapshot(cargoLinksFixture('different-names'));
  expect(differentNames.status).toBe('unsatisfiable');
  expect(differentNames.linksConflicts?.[0]?.packages.map(item => item.name))
    .toEqual(['bridge', 'shared']);
});

test('PKG02/PKG12: one native owner across roles and unselected releases never conflict', () => {
  const single = solveCargoSnapshot(cargoLinksFixture('single-owner'));
  const original = solveCargoSnapshot(cargoFixture());
  expect(single.status).toBe('solved');
  expect(single.linksConflicts).toEqual([]);
  expect(single.selected).toEqual(original.selected);
  expect(single.instances).toEqual(original.instances);
  expect(single.edges).toEqual(original.edges);
  for (const kind of ['single-owner-no-default', 'single-owner-windows'] as const) {
    const request = cargoLinksFixture(kind);
    const graph = solveCargoSnapshot(request);
    const v1 = solveCargoSnapshot({ ...cargoFixture(),
      defaultFeatures: request.defaultFeatures, target: request.target });
    expect(graph.status).toBe('solved');
    expect(graph.selected).toEqual(v1.selected);
    expect(graph.instances).toEqual(v1.instances);
    expect(graph.edges).toEqual(v1.edges);
  }
  const distinct = solveCargoSnapshot(cargoLinksFixture('distinct-links'));
  expect(distinct.status).toBe('solved');
  expect(distinct.linksConflicts).toEqual([]);
  expect(distinct.selected.filter(item => item.name === 'shared').map(item => item.version))
    .toEqual(['1.0.0', '2.0.0']);
  const entries = cargoIndexEntries(cargoLinksFixture());
  entries.find(entry => entry.name === 'shared' && entry.vers === '2.0.0')!.links = 'Native_Shared';
  const caseSensitive = { ...cargoLinksFixture(), indexFiles: cargoLinksFixture().indexFiles
    .map(file => cargoIndexFile(file.name, entries.filter(entry => entry.name === file.name))) };
  expect(solveCargoSnapshot(caseSensitive).status).toBe('solved');
});

test('PKG02/PKG12: lock selection distinguishes root optional and transitive optional features', () => {
  for (const kind of ['inactive-target', 'inactive-root-optional'] as const) {
    const result = solveCargoSnapshot(cargoLinksFixture(kind));
    expect(result.status).toBe('unsatisfiable');
    expect(result.linksConflicts?.[0]?.packages.find(item => item.name !== 'shared')?.roles)
      .toEqual([]);
  }
  const inactive = cargoLinksFixture('inactive-transitive-optional');
  const solved = solveCargoSnapshot(inactive);
  expect(solved.status).toBe('solved');
  expect(solved.selected.filter(item => item.name === 'shared').map(item => item.version))
    .toEqual(['1.0.0']);
  const withoutUnusedRelease = { ...inactive, indexFiles: inactive.indexFiles.map(file =>
    cargoIndexFile(file.name, cargoIndexEntries({ ...inactive, indexFiles: [file] })
      .filter(entry => entry.vers === '1.0.0'))) };
  expect(solveCargoSnapshot(withoutUnusedRelease)).toEqual(solved);
  expect(solveCargoSnapshot(cargoLinksFixture('active-transitive-optional')).status)
    .toBe('unsatisfiable');
});

test('PKG02/PKG13: malformed, missing, unsupported and bounded work cannot become unsatisfiable', () => {
  const input = cargoLinksFixture();
  expect(solveCargoSnapshot({ ...input,
    indexFiles: input.indexFiles.filter(file => file.name !== 'windowsonly') })).toMatchObject({
    status: 'incomplete-source-data', linksConflicts: [], selected: [],
    missing: ['windowsonly@1.0.0'] });
  expect(solveCargoSnapshot({ ...input, features: ['unknown'] })).toMatchObject({
    status: 'unsupported-semantics', linksConflicts: [] });
  expect(solveCargoSnapshot(withIndexLine(input, 'bridge', entry =>
    ({ ...entry, yanked: true })))).toMatchObject({
    status: 'unsupported-semantics', linksConflicts: [] });
  expect(solveCargoSnapshot(withIndexLine(input, 'bridge', entry =>
    ({ ...entry, links: 'unsupported/name' })))).toMatchObject({
    status: 'unsupported-semantics', linksConflicts: [] });
  expect(() => solveCargoSnapshot(withIndexLine(input, 'bridge', entry =>
    ({ ...entry, links: 42 })))).toThrow(CargoResolutionInvalid);
  expect(() => solveCargoSnapshot({ ...input, manifestSha256: '0'.repeat(64) }))
    .toThrow(CargoResolutionInvalid);
  const tooMany = withIndexLine(input, 'bridge', entry => ({ ...entry,
    deps: Array.from({ length: 257 }, (_, index) => ({ name: `dep${index}`,
      req: '=1.0.0', features: [], optional: false, default_features: true,
      target: null, kind: 'normal', registry: null, package: null })) }));
  expect(solveCargoSnapshot(tooMany)).toMatchObject({ status: 'budget-exhausted',
    selected: [], linksConflicts: [] });
});

test('PKG02/PKG13: v1 native links outcome remains byte-for-byte compatible', () => {
  expect(solveCargoSnapshot({ ...cargoLinksFixture(),
    profile: 'cargo-index-exact-resolver2-v1' })).toEqual({
    status: 'unsupported-semantics', selected: [], instances: [], edges: [], missing: [],
    unsupportedClauses: ['Cargo native links'], releaseCount: 0, edgeCount: 0,
    featureActivationCount: 0,
  });
  expect(solveCargoSnapshot(cargoFixture())).not.toHaveProperty('linksConflicts');
});

test('PKG19/PKG13: Cargo links work depends on selected graph with bounded irrelevant releases', () => {
  const input = cargoLinksFixture('single-owner');
  const baseline = solveCargoSnapshot(input);
  for (const count of [1, 8, 24]) {
    const entries = cargoIndexEntries(input).filter(entry => entry.name === 'shared');
    const additional = Array.from({ length: count }, (_, index) =>
      ({ ...entries[0]!, vers: `${index + 4}.0.0` }));
    const candidate = { ...input, indexFiles: input.indexFiles.map(file => file.name === 'shared'
      ? cargoIndexFile('shared', [...entries, ...additional]) : file) };
    const result = solveCargoSnapshot(candidate);
    expect(result).toEqual(baseline);
  }
});
