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
