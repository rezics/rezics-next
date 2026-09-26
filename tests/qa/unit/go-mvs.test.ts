import { expect, test } from 'bun:test';
import { GoResolutionInvalid, solveGoMvsSnapshot,
  type GoMvsSnapshotRequest } from '../../../services/main/src/modules/package/go-mvs.ts';

const requirement = (path: string, version: string) => ({ path, version });
const release = (path: string, version: string,
  requirements: Array<{ path: string; version: string }> = []) =>
  ({ path, version, requirements });
const input = (overrides: Partial<GoMvsSnapshotRequest> = {}): GoMvsSnapshotRequest => ({
  profile: 'go-mvs-stable-unpruned-v1', mainModule: 'example.com/main',
  goDirective: '1.16', coverage: { complete: true, unsupportedClauses: [] },
  roots: [], releases: [], ...overrides,
});

test('PKG05: Go unpruned MVS selects highest requirement, not latest available release', () => {
  const outcome = solveGoMvsSnapshot(input({
    roots: [requirement('example.com/a', 'v1.2.0'),
      requirement('example.com/b', 'v1.2.0'),
      requirement('example.com/compat/v2', 'v2.1.0')],
    releases: [
      release('example.com/a', 'v1.2.0', [requirement('example.com/c', 'v1.3.0')]),
      release('example.com/b', 'v1.2.0', [requirement('example.com/c', 'v1.4.0')]),
      release('example.com/c', 'v1.3.0', [requirement('example.com/d', 'v1.2.0')]),
      release('example.com/c', 'v1.4.0', [requirement('example.com/e', 'v1.1.0')]),
      release('example.com/d', 'v1.2.0'), release('example.com/d', 'v1.9.0'),
      release('example.com/e', 'v1.1.0'),
      release('example.com/compat/v2', 'v2.1.0'),
    ],
  }));
  expect(outcome.status).toBe('solved');
  expect(outcome.buildList).toEqual([
    requirement('example.com/a', 'v1.2.0'),
    requirement('example.com/b', 'v1.2.0'),
    requirement('example.com/c', 'v1.4.0'),
    requirement('example.com/compat/v2', 'v2.1.0'),
    requirement('example.com/d', 'v1.2.0'),
    requirement('example.com/e', 'v1.1.0'),
  ]);
  expect(outcome.loadedManifestCount).toBe(7);
});

test('PKG05/PKG13: absent manifest, partial coverage and unsupported clause never solve', () => {
  const request = input({ roots: [requirement('example.com/a', 'v1.0.0')],
    releases: [release('example.com/a', 'v1.0.0',
      [requirement('example.com/missing', 'v1.0.0')])] });
  expect(solveGoMvsSnapshot(request)).toMatchObject({
    status: 'incomplete-source-data', buildList: [],
    missing: [requirement('example.com/missing', 'v1.0.0')] });
  expect(solveGoMvsSnapshot({ ...request, coverage: { complete: false,
    unsupportedClauses: [] } }).status).toBe('incomplete-source-data');
  expect(solveGoMvsSnapshot({ ...request, coverage: { complete: true,
    unsupportedClauses: ['replace example.com/a => ../local'] } })).toMatchObject({
      status: 'unsupported-semantics', buildList: [], loadedManifestCount: 0 });
});

test('PKG05/PKG13: budget and unsupported version/path are explicit', () => {
  const releases = Array.from({ length: 129 }, (_, index) =>
    release(`example.com/m${index}`, 'v1.0.0', index < 128
      ? [requirement(`example.com/m${index + 1}`, 'v1.0.0')] : []));
  const outcome = solveGoMvsSnapshot(input({
    roots: [requirement('example.com/m0', 'v1.0.0')], releases }));
  expect(outcome.status).toBe('budget-exhausted');
  expect(outcome.buildList).toEqual([]);
  expect(() => solveGoMvsSnapshot(input({
    roots: [requirement('example.com/mod', 'v2.0.0')] })))
    .toThrow(GoResolutionInvalid);
  expect(() => solveGoMvsSnapshot(input({
    roots: [requirement('example.com/mod', 'v1.2.0-pre')] })))
    .toThrow(GoResolutionInvalid);
});

test('PKG05: main exclusions suppress the required version and replacements load source manifests', () => {
  const request: GoMvsSnapshotRequest = input({
    profile: 'go-mvs-stable-unpruned-main-directives-v2',
    roots: [requirement('example.com/a', 'v1.2.0'),
      requirement('example.com/b', 'v1.2.0')],
    releases: [
      release('example.com/a', 'v1.2.0', [requirement('example.com/c', 'v1.3.0')]),
      release('example.com/b', 'v1.2.0', [requirement('example.com/c', 'v1.4.0')]),
      release('example.com/c', 'v1.3.0', [requirement('example.com/d', 'v1.0.0')]),
      release('example.com/c', 'v1.4.0', [requirement('example.com/e', 'v1.0.0')]),
      release('example.com/c', 'v1.5.0', [requirement('example.com/f', 'v1.0.0')]),
      release('example.com/f', 'v1.0.0'),
    ],
    mainDirectives: { exclusions: [requirement('example.com/c', 'v1.3.0')],
      replacements: [{ original: requirement('example.com/c', 'v1.4.0'),
        source: requirement('example.com/c', 'v1.5.0') }] },
  });
  const outcome = solveGoMvsSnapshot(request);
  expect(outcome).toMatchObject({ status: 'solved', buildList: [
    requirement('example.com/a', 'v1.2.0'),
    requirement('example.com/b', 'v1.2.0'),
    requirement('example.com/c', 'v1.4.0'),
    requirement('example.com/f', 'v1.0.0'),
  ], selectedSources: [{ original: requirement('example.com/c', 'v1.4.0'),
    source: requirement('example.com/c', 'v1.5.0') }] });
  expect(outcome.buildList.some(item => item.path === 'example.com/d'
    || item.path === 'example.com/e')).toBe(false);
  expect(solveGoMvsSnapshot({ ...request, releases: request.releases.filter(item =>
    item.version !== 'v1.5.0') })).toMatchObject({
      status: 'incomplete-source-data', buildList: [],
      missing: [requirement('example.com/c', 'v1.5.0')] });
  expect(() => solveGoMvsSnapshot({ ...request,
    releases: request.releases.map(item => item.version === 'v1.5.0'
      ? { ...item, declaredModule: 'example.com/wrong' } : item) }))
    .toThrow(GoResolutionInvalid);
  const fork = { path: 'example.com/fork/c', version: 'v1.0.0' };
  expect(solveGoMvsSnapshot({ ...request,
    mainDirectives: { exclusions: request.mainDirectives!.exclusions,
      replacements: [{ original: requirement('example.com/c', 'v1.4.0'),
        source: fork }] },
    releases: [...request.releases, { ...fork, declaredModule: 'example.com/c',
      requirements: [requirement('example.com/f', 'v1.0.0')] }] })).toMatchObject({
        status: 'solved', selectedSources: [{
          original: requirement('example.com/c', 'v1.4.0'), source: fork }] });
  expect(solveGoMvsSnapshot({ ...request,
    roots: [...request.roots, requirement('example.com/c', 'v1.5.0')] }))
    .toMatchObject({ status: 'solved', selectedSources: [] });
});

test('PKG05: latest supplied manifest can advise on a selected retracted version', () => {
  const request: GoMvsSnapshotRequest = input({
    profile: 'go-mvs-stable-unpruned-main-directives-v2',
    roots: [requirement('example.com/d', 'v1.2.0')],
    releases: [release('example.com/d', 'v1.2.0'),
      { ...release('example.com/d', 'v1.9.0'), retractions: [
        { lower: 'v1.2.0', upper: 'v1.2.0', rationale: 'bad release' }] }],
    mainDirectives: { exclusions: [], replacements: [] },
  });
  expect(solveGoMvsSnapshot(request)).toMatchObject({
    status: 'solved', buildList: [requirement('example.com/d', 'v1.2.0')],
    retractedSelected: [{ selected: requirement('example.com/d', 'v1.2.0'),
      announcedBy: requirement('example.com/d', 'v1.9.0'),
      rationale: 'bad release' }] });
  expect(solveGoMvsSnapshot({ ...request,
    roots: [requirement('example.com/d', 'v1.9.0')] })).toMatchObject({
      status: 'solved', retractedSelected: [] });
  expect(() => solveGoMvsSnapshot({ ...request,
    releases: [request.releases[0]!, { ...request.releases[1]!,
      retractions: [{ lower: 'v1.3.0', upper: 'v1.2.0', rationale: 'bad' }] }] }))
    .toThrow(GoResolutionInvalid);
  expect(() => solveGoMvsSnapshot({ ...request,
    profile: 'go-mvs-stable-unpruned-v1', mainDirectives: undefined }))
    .toThrow(GoResolutionInvalid);
});

test('PKG05: path-wide Go replacement loads both visited versions and exact rule wins', () => {
  const request = input({ profile: 'go-mvs-stable-unpruned-main-directives-v2',
    roots: [requirement('example.com/a', 'v1.0.0'),
      requirement('example.com/b', 'v1.0.0')],
    releases: [
      release('example.com/a', 'v1.0.0', [requirement('example.com/c', 'v1.3.0')]),
      release('example.com/b', 'v1.0.0', [requirement('example.com/c', 'v1.4.0')]),
      release('example.com/c', 'v1.5.0', [requirement('example.com/f', 'v1.0.0')]),
      { ...release('example.com/fork/c', 'v1.0.0',
        [requirement('example.com/g', 'v1.0.0')]), declaredModule: 'example.com/c' },
      release('example.com/f', 'v1.0.0'), release('example.com/g', 'v1.0.0'),
    ],
    mainDirectives: { exclusions: [], replacements: [
      { original: { path: 'example.com/c' },
        source: requirement('example.com/c', 'v1.5.0') },
    ] },
  });
  const wildcard = solveGoMvsSnapshot(request);
  expect(wildcard).toMatchObject({ status: 'solved', buildList: [
    requirement('example.com/a', 'v1.0.0'),
    requirement('example.com/b', 'v1.0.0'),
    requirement('example.com/c', 'v1.4.0'),
    requirement('example.com/f', 'v1.0.0'),
  ], selectedSources: [{ original: requirement('example.com/c', 'v1.4.0'),
    source: requirement('example.com/c', 'v1.5.0') }] });
  const override = solveGoMvsSnapshot({ ...request,
    mainDirectives: { exclusions: [], replacements: [
      { original: requirement('example.com/c', 'v1.4.0'),
        source: requirement('example.com/fork/c', 'v1.0.0') },
      ...request.mainDirectives!.replacements,
    ] } });
  expect(override).toMatchObject({ status: 'solved', buildList: [
    requirement('example.com/a', 'v1.0.0'),
    requirement('example.com/b', 'v1.0.0'),
    requirement('example.com/c', 'v1.4.0'),
    requirement('example.com/f', 'v1.0.0'),
    requirement('example.com/g', 'v1.0.0'),
  ], selectedSources: [{ original: requirement('example.com/c', 'v1.4.0'),
    source: requirement('example.com/fork/c', 'v1.0.0') }] });
  expect(() => solveGoMvsSnapshot({ ...request,
    mainDirectives: { exclusions: [], replacements: [
      ...request.mainDirectives!.replacements,
      ...request.mainDirectives!.replacements,
    ] } })).toThrow(GoResolutionInvalid);
  expect(solveGoMvsSnapshot({ ...request,
    releases: request.releases.filter(item => item.path !== 'example.com/c') }))
    .toMatchObject({ status: 'incomplete-source-data', missing: [
      requirement('example.com/c', 'v1.5.0') ] });
});
