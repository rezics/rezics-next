import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { GoResolutionInvalid, parseGoLocalMainManifest, solveGoMvsSnapshot,
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

const localMain = 'module example.com/main\n\ngo 1.16\n\nrequire example.com/c v1.4.0\nreplace example.com/c => ./local/c\n';
const localMod = 'module example.com/fork/c\n\ngo 1.16\n\nrequire example.com/d v1.0.0\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const localInput = (overrides: Partial<GoMvsSnapshotRequest> = {}): GoMvsSnapshotRequest => ({
  profile: 'go-mvs-local-unpruned-v4', mainModule: 'example.com/main',
  goDirective: '1.16', coverage: { complete: true, unsupportedClauses: [] },
  roots: [requirement('example.com/c', 'v1.4.0')],
  releases: [release('example.com/d', 'v1.0.0')],
  mainManifest: { text: localMain, rawSha256: sha(localMain) },
  localReplacements: [{ original: { path: 'example.com/c' },
    sourceIdentity: './local/c' }],
  localSources: [{ identity: './local/c', text: localMod, rawSha256: sha(localMod) }],
  captureEvidence: [{ captureId: '00000000-0000-0000-0000-000000000001',
    path: 'example.com/d', version: 'v1.0.0', listSha256: 'a'.repeat(64),
    infoSha256: 'b'.repeat(64), modSha256: 'c'.repeat(64) }],
  ...overrides,
});

test('PKG05/PKG12: exact local go.mod selects its requirements and retains source meaning', () => {
  expect(solveGoMvsSnapshot(localInput())).toMatchObject({ status: 'solved',
    buildList: [requirement('example.com/c', 'v1.4.0'),
      requirement('example.com/d', 'v1.0.0')],
    selectedLocalSources: [{ original: requirement('example.com/c', 'v1.4.0'),
      sourceIdentity: './local/c', declaredModule: 'example.com/fork/c',
      rawSha256: sha(localMod) }], missingLocalSources: [] });
  expect(solveGoMvsSnapshot(localInput({ localSources: [] }))).toMatchObject({
    status: 'incomplete-source-data', buildList: [], missingLocalSources: ['./local/c'] });
  expect(solveGoMvsSnapshot(localInput({ releases: [], captureEvidence: [] })))
    .toMatchObject({ status: 'incomplete-source-data',
      missing: [requirement('example.com/d', 'v1.0.0')] });
});

test('PKG05: local replacement rejects path authority, changed bytes and duplicate rules', () => {
  expect(parseGoLocalMainManifest(localMain.replace(
    'replace example.com/c => ./local/c',
    'replace (\n example.com/c => ./local/c\n)')).replacements)
    .toEqual([{ original: { path: 'example.com/c' },
      sourceIdentity: './local/c' }]);
  expect(() => parseGoLocalMainManifest(localMain.replace('./local/c', '/tmp/host')))
    .toThrow(GoResolutionInvalid);
  expect(() => parseGoLocalMainManifest(localMain.replace('./local/c', '../outside')))
    .toThrow(GoResolutionInvalid);
  expect(() => solveGoMvsSnapshot(localInput({ localSources: [{ identity: './local/c',
    text: localMod, rawSha256: '0'.repeat(64) }] }))).toThrow(GoResolutionInvalid);
  expect(() => solveGoMvsSnapshot(localInput({ localSources: [
    localInput().localSources![0]!, localInput().localSources![0]!] })))
    .toThrow(GoResolutionInvalid);
  expect(() => parseGoLocalMainManifest(`${localMain}replace example.com/c => ./other\n`))
    .toThrow(GoResolutionInvalid);
  expect(solveGoMvsSnapshot(localInput({ localSources: [{ identity: './local/c',
    text: localMod.replace('go 1.16', 'go 1.17'),
    rawSha256: sha(localMod.replace('go 1.16', 'go 1.17')) }] })))
    .toMatchObject({ status: 'unsupported-semantics', buildList: [] });
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
    roots: [requirement('example.com/mod', 'v1.2.0-2026092501010-abcdef123456')] })))
    .toThrow(GoResolutionInvalid);
});

test('PKG05: Go pseudo-version timestamps order MVS and preserve major paths', () => {
  const lower = 'v1.2.4-0.20260925010101-abcdef123456';
  const higher = 'v1.2.4-0.20260925020202-fedcba654321';
  const major = 'v2.0.0-20260925000000-abcdef123456';
  const outcome = solveGoMvsSnapshot(input({
    roots: [requirement('example.com/a', 'v1.0.0'),
      requirement('example.com/b', 'v1.0.0'),
      requirement('example.com/compat/v2', major)],
    releases: [
      release('example.com/a', 'v1.0.0', [requirement('example.com/c', lower)]),
      release('example.com/b', 'v1.0.0', [requirement('example.com/c', higher)]),
      release('example.com/c', lower, [requirement('example.com/d', 'v1.0.0')]),
      release('example.com/c', higher, [requirement('example.com/e', 'v1.0.0')]),
      release('example.com/compat/v2', major),
      release('example.com/d', 'v1.0.0'), release('example.com/e', 'v1.0.0'),
    ],
  }));
  expect(outcome).toMatchObject({ status: 'solved', buildList: [
    requirement('example.com/a', 'v1.0.0'),
    requirement('example.com/b', 'v1.0.0'),
    requirement('example.com/c', higher),
    requirement('example.com/compat/v2', major),
    requirement('example.com/d', 'v1.0.0'),
    requirement('example.com/e', 'v1.0.0'),
  ] });
  expect(() => solveGoMvsSnapshot(input({
    roots: [requirement('example.com/compat', major)] })))
    .toThrow(GoResolutionInvalid);
});

test('PKG05: pre-tag pseudo-version sorts before its stable release', () => {
  const prerelease = 'v1.2.3-rc.0.20260925010101-abcdef123456';
  expect(solveGoMvsSnapshot(input({
    roots: [requirement('example.com/a', 'v1.0.0'),
      requirement('example.com/b', 'v1.0.0')],
    releases: [
      release('example.com/a', 'v1.0.0', [requirement('example.com/c', prerelease)]),
      release('example.com/b', 'v1.0.0', [requirement('example.com/c', 'v1.2.3')]),
      release('example.com/c', prerelease), release('example.com/c', 'v1.2.3'),
    ],
  }))).toMatchObject({ status: 'solved', buildList: [
    requirement('example.com/a', 'v1.0.0'),
    requirement('example.com/b', 'v1.0.0'),
    requirement('example.com/c', 'v1.2.3'),
  ] });
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

const prunedMain = `module example.com/main\n\ngo 1.17\n\nrequire (\n example.com/a v1.0.0\n example.com/b v1.0.0 // indirect\n)\n`;
const prunedInput = (overrides: Partial<GoMvsSnapshotRequest> = {}): GoMvsSnapshotRequest => ({
  profile: 'go-mvs-captured-pruned-v5', mainModule: 'example.com/main',
  goDirective: '1.17', coverage: { complete: true, unsupportedClauses: [] },
  roots: [requirement('example.com/a', 'v1.0.0'),
    requirement('example.com/b', 'v1.0.0')],
  releases: [
    { ...release('example.com/a', 'v1.0.0', [requirement('example.com/c', 'v1.0.0')]),
      goDirective: '1.17', unsupportedClauses: [] },
    { ...release('example.com/b', 'v1.0.0', [requirement('example.com/c', 'v1.1.0')]),
      goDirective: '1.16', unsupportedClauses: [] },
    { ...release('example.com/c', 'v1.1.0', [requirement('example.com/d', 'v1.0.0')]),
      goDirective: '1.17', unsupportedClauses: [] },
    { ...release('example.com/d', 'v1.0.0'),
      goDirective: '1.17', unsupportedClauses: [] },
  ],
  mainManifest: { text: prunedMain, rawSha256: sha(prunedMain) },
  captureEvidence: ['a', 'b', 'c', 'd'].map((path, index) => ({
    captureId: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    path: `example.com/${path}`, version: path === 'c' ? 'v1.1.0' : 'v1.0.0',
    listSha256: 'a'.repeat(64), infoSha256: 'b'.repeat(64), modSha256: 'c'.repeat(64),
  })), ...overrides,
});

test('PKG05/PKG12: Go 1.17 roots and legacy branch select the native pruned graph', () => {
  const outcome = solveGoMvsSnapshot(prunedInput());
  expect(outcome).toMatchObject({ status: 'solved', buildList: [
    requirement('example.com/a', 'v1.0.0'),
    requirement('example.com/b', 'v1.0.0'),
    requirement('example.com/c', 'v1.1.0'),
    requirement('example.com/d', 'v1.0.0'),
  ], loadedManifestCount: 4 });
  const pruned = prunedInput({ releases: prunedInput().releases.map(item =>
    item.path === 'example.com/b' ? { ...item, goDirective: '1.17' } : item) });
  expect(solveGoMvsSnapshot(pruned)).toMatchObject({ status: 'solved', buildList: [
    requirement('example.com/a', 'v1.0.0'),
    requirement('example.com/b', 'v1.0.0'),
    requirement('example.com/c', 'v1.1.0'),
  ], loadedManifestCount: 2 });
  expect(solveGoMvsSnapshot({ ...pruned, releases: pruned.releases.slice(0, 2),
    captureEvidence: pruned.captureEvidence!.slice(0, 2) })).toMatchObject({
      status: 'solved', loadedManifestCount: 2 });
  expect(solveGoMvsSnapshot({ ...pruned, releases: pruned.releases.map(item =>
    item.path === 'example.com/c' ? { ...item, goDirective: null,
      unsupportedClauses: ['unrecognized future directive'] } : item) }))
    .toMatchObject({ status: 'solved', loadedManifestCount: 2 });
  const reorderedMain = prunedMain.replace(
    ' example.com/a v1.0.0\n example.com/b v1.0.0 // indirect',
    ' example.com/c v1.1.0\n example.com/b v1.0.0 // indirect');
  const reordered = prunedInput({ roots: [requirement('example.com/c', 'v1.1.0'),
    requirement('example.com/b', 'v1.0.0')],
    mainManifest: { text: reorderedMain, rawSha256: sha(reorderedMain) } });
  expect(solveGoMvsSnapshot(reordered)).toMatchObject({ status: 'solved',
    buildList: [requirement('example.com/b', 'v1.0.0'),
      requirement('example.com/c', 'v1.1.0'),
      requirement('example.com/d', 'v1.0.0')], loadedManifestCount: 3 });
});

test('PKG05/PKG13: pruned profile refuses missing and incompatible loaded evidence', () => {
  const request = prunedInput();
  expect(solveGoMvsSnapshot({ ...request, releases: request.releases.slice(0, 2),
    captureEvidence: request.captureEvidence!.slice(0, 2) })).toMatchObject({
      status: 'incomplete-source-data', buildList: [],
      missing: [requirement('example.com/c', 'v1.1.0')] });
  expect(solveGoMvsSnapshot({ ...request, releases: request.releases.map(item =>
    item.path === 'example.com/c' ? { ...item, goDirective: null } : item) }))
    .toMatchObject({ status: 'unsupported-semantics', buildList: [],
      unsupportedClauses: [expect.stringContaining('go directive absent')] });
  expect(solveGoMvsSnapshot({ ...request, coverage: { complete: false,
    unsupportedClauses: [] } })).toMatchObject({ status: 'incomplete-source-data',
      buildList: [] });
  expect(solveGoMvsSnapshot({ ...request, coverage: { complete: true,
    unsupportedClauses: ['main go.mod: replace'] } })).toMatchObject({
      status: 'unsupported-semantics', buildList: [] });
  expect(() => solveGoMvsSnapshot({ ...request, goDirective: '1.16' }))
    .toThrow(GoResolutionInvalid);
  const newerMain = prunedMain.replace('go 1.17', 'go 1.18');
  expect(solveGoMvsSnapshot(prunedInput({ goDirective: '1.18',
    mainManifest: { text: newerMain, rawSha256: sha(newerMain) } })).status).toBe('solved');
  expect(solveGoMvsSnapshot({ ...request, releases: request.releases.map(item =>
    item.path === 'example.com/b' ? { ...item, goDirective: '1.28' } : item) }))
    .toMatchObject({ status: 'unsupported-semantics', buildList: [] });
});

test('PKG05/PKG13: pruned requirement traversal stops at the declared budget', () => {
  const roots = Array.from({ length: 9 }, (_, index) =>
    requirement(`example.com/root${index}`, 'v1.0.0'));
  const text = `module example.com/main\n\ngo 1.17\n\nrequire (\n${roots.map(item =>
    ` ${item.path} ${item.version}`).join('\n')}\n)\n`;
  const releases = roots.map((root, index) => ({ ...root, goDirective: '1.17',
    unsupportedClauses: [], requirements: Array.from({ length: 64 }, (_, child) =>
      requirement(`example.com/dependency${index}x${child}`, 'v1.0.0')) }));
  const captureEvidence = roots.map((root, index) => ({
    captureId: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    ...root, listSha256: 'a'.repeat(64), infoSha256: 'b'.repeat(64),
    modSha256: 'c'.repeat(64) }));
  expect(solveGoMvsSnapshot(prunedInput({ roots, releases,
    captureEvidence, mainManifest: { text, rawSha256: sha(text) } })))
    .toMatchObject({ status: 'budget-exhausted', buildList: [],
      loadedManifestCount: 9, requirementCount: 513 });
});
