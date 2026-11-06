import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import {
  KIND_COUNT_HIT_WITNESSES,
  proveKindCount,
  projectKindDirectoryCounts,
  publicCatalogueKindCounts,
  type KindCountProof,
} from '../../src/search/kind-count-proof.ts';

const unused = async (): Promise<never> => {
  throw new Error('Kind count proof must not read a producer');
};
const registry = createDiscoveryRegistry({
  release: bundledRelease,
  semantic: {
    source: { read: unused, count: unused },
    hydrate: unused,
    icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
  },
  accounts: {
    source: { read: unused, count: unused, page: unused },
    hydrate: unused,
    labels: { en: 'Accounts' },
    icon: 'account',
  },
});
const book = 'schema:Book';
const proof = (patch: Partial<KindCountProof> = {}): KindCountProof => ({
  continuation: false,
  exhausted: false,
  aggregateProof: false,
  witnesses: new Map([[book, 2]]),
  ...patch,
});

test('a disclosed sample is a positive lower bound and never an exact total', () => {
  expect(proveKindCount(book, proof())).toEqual({ kind: book, value: 2, exact: false });
  expect(proveKindCount(book, proof({ exhausted: true }))).toEqual({ kind: book, value: 2, exact: false });
  expect(proveKindCount(book, proof({ aggregateProof: true }))).toEqual({ kind: book, value: 2, exact: false });
});

test('whole-predicate exhaustion plus aggregate proof certifies exact membership and absence', () => {
  const complete = proof({ exhausted: true, aggregateProof: true });
  expect(proveKindCount(book, complete)).toEqual({ kind: book, value: 2, exact: true });
  expect(proveKindCount(book, { ...complete, witnesses: new Map() })).toEqual({ kind: book, value: 0, exact: true });
});

test('hit and kind continuations keep counts unavailable', () => {
  expect(proveKindCount(book, proof({ continuation: true, exhausted: true, aggregateProof: true }))).toEqual({
    kind: book,
    unavailable: true,
  });
});

test('zero witnesses without aggregate proof cannot become an inferred empty total', () => {
  expect(proveKindCount(book, proof({ witnesses: new Map() }))).toEqual({ kind: book, unavailable: true });
  expect(proveKindCount(book, proof({ witnesses: new Map([[book, 0]]) }))).toEqual({ kind: book, unavailable: true });
});

test('catalogue kind chips never publish an exact total from a disclosed sample or continuation', () => {
  expect(KIND_COUNT_HIT_WITNESSES).toBe(2);
  expect(publicCatalogueKindCounts([book, book, 'schema:Recipe'], { continuation: false, exhausted: true })).toEqual(
    new Map([[book, 2]]),
  );
  expect(publicCatalogueKindCounts([book], { continuation: true, exhausted: true }).size).toBe(0);
});

test('kind directory projection keeps current witnesses on the initial page only', () => {
  const entries = [{ kind: book, metadata: registry.get(book).metadata }];
  expect(projectKindDirectoryCounts(registry, entries, proof())[0]!.count).toEqual({
    kind: book,
    value: 2,
    exact: false,
  });
  expect(projectKindDirectoryCounts(registry, entries, proof({ continuation: true }))[0]!.count).toEqual({
    kind: book,
    unavailable: true,
  });
});
