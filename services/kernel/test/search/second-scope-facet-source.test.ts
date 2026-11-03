import { expect, test } from 'bun:test';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext } from '../../src/search/public-filter-consumer-contract.ts';
import { subjectPartition } from '../../src/search/source.ts';
import {
  bindScopedFacetPorts,
  createScopedFacetSource,
  scopedFacetIdentityKey,
  type ScopedFacetIdentity,
} from '../../src/search/scoped-facet-source.ts';

const cost: PublicFilterCost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};
const identity: ScopedFacetIdentity = {
  source: 'realm-members-v1',
  meaning: 'a'.repeat(64),
  population: 'b'.repeat(64),
  authorization: 'c'.repeat(64),
};
const admission = { identity, request: Object.freeze({ realm: 'private-request' }) } as const;
const context = {} as PublicFilterConsumerContext;
const alice = '00000000-0000-7000-8000-000000000001';
const bob = '00000000-0000-7000-8000-000000000002';

test('the default adapter uses only an admission-bound source and fails closed without one', async () => {
  const ports = {
    async observe() {
      return { status: 'observed' as const, identity, cost };
    },
    async readCandidates() {
      return { status: 'complete' as const, identity, subjects: [alice], frontier: 'end', cost };
    },
    async readMembership(_request: unknown, subjects: readonly string[]) {
      return {
        status: 'matched' as const,
        identity,
        subjects: subjects.map((subject) => ({ subject, member: true })),
        cost,
      };
    },
  };
  const source = createScopedFacetSource();
  const bound = { identity, request: bindScopedFacetPorts(ports, admission.request) };

  expect((await source.observe(admission, context)).status).toBe('unavailable');
  const page = await source.readPage(bound, null, 1, context);
  if (!('subjects' in page)) throw new Error('Expected the admission-bound source to return subjects');
  expect(page.subjects).toEqual([
    { partition: subjectPartition(alice), subject: alice },
  ]);
});

test('scope candidate pages emit only current members under the admitted observation', async () => {
  const calls: string[] = [];
  const source = createScopedFacetSource({
    async observe() {
      calls.push('observe');
      return { status: 'observed', identity, cost };
    },
    async readCandidates(_request, after, limit) {
      calls.push('candidates');
      expect(after).toBeNull();
      expect(limit).toBe(2);
      return { status: 'complete', identity, subjects: [alice, bob], frontier: 'end', cost };
    },
    async readMembership(_request, subjects) {
      calls.push('membership');
      return {
        status: 'matched',
        identity,
        subjects: subjects.map((subject) => ({ subject, member: subject === alice })),
        cost,
      };
    },
  });

  const page = await source.readPage(admission, null, 2, context);
  expect(page).toEqual({
    status: 'complete',
    observation: scopedFacetIdentityKey(identity),
    subjects: [{ partition: subjectPartition(alice), subject: alice }],
    frontier: 'end',
    cost,
  });
  expect(calls).toEqual(['observe', 'candidates', 'membership', 'observe']);
});

test('uncertain membership or a changed authorization returns no candidate rows', async () => {
  const changed = { ...identity, authorization: 'd'.repeat(64) };
  const source = createScopedFacetSource({
    async observe() {
      return { status: 'observed', identity, cost };
    },
    async readCandidates() {
      return { status: 'progress', identity, subjects: [alice], frontier: 'next', cost };
    },
    async readMembership(_request, subjects) {
      return {
        status: 'matched',
        identity,
        subjects: subjects.map((subject) => ({ subject, member: 'not_proven' as const })),
        cost,
      };
    },
  });
  const uncertain = await source.readPage(admission, null, 1, context);
  expect(uncertain.status).toBe('unready');
  expect('subjects' in uncertain).toBe(false);
  expect(scopedFacetIdentityKey(changed)).not.toBe(scopedFacetIdentityKey(identity));

  let observations = 0;
  const changedSource = createScopedFacetSource({
    async observe() {
      observations++;
      return { status: 'observed', identity: observations === 1 ? identity : changed, cost };
    },
    async readCandidates() {
      return { status: 'complete', identity, subjects: [alice], frontier: 'end', cost };
    },
    async readMembership(_request, subjects) {
      return {
        status: 'matched',
        identity,
        subjects: subjects.map((subject) => ({ subject, member: true })),
        cost,
      };
    },
  });
  const unauthorized = await changedSource.readPage(admission, null, 1, context);
  expect(unauthorized.status).toBe('unready');
  expect('subjects' in unauthorized).toBe(false);
});

test('a progressing native source must advance its finite frontier', async () => {
  const source = createScopedFacetSource({
    async observe() {
      return { status: 'observed', identity, cost };
    },
    async readCandidates(_request, after) {
      return { status: 'progress', identity, subjects: [], frontier: after ?? 'first', cost };
    },
    async readMembership(_request, subjects) {
      return { status: 'matched', identity, subjects: [], cost };
    },
  });
  const stalled = await source.readPage(admission, 'first', 1, context);
  expect(stalled.status).toBe('unready');
  expect('subjects' in stalled).toBe(false);
});
