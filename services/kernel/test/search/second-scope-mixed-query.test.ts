import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { compileDiscoveryFilter, currentDiscoveryFilter } from '../../src/search/discovery-filter.ts';
import { currentDiscoveryCandidates } from '../../src/search/discovery-current.ts';
import { compareDiscoveryTuple, type DiscoveryCandidate } from '../../src/search/discovery-query.ts';
import type { DiscoveryKey, DiscoveryReadContext, DiscoveryRegistry } from '../../src/search/discovery.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const entries = [
  { owner: 'semantic', kind: 'schema:Person' },
  { owner: 'content', kind: 'collection', domains: ['text', 'kind'] },
] as unknown as DiscoveryRegistry['entries'];
const registry = {
  entries,
  get: (kind: string) => entries.find((entry) => entry.kind === kind)!,
  key: (key: DiscoveryKey) => key,
} as unknown as DiscoveryRegistry;

test('Subject-only NOT stays in its domain and an unready metadata owner cannot become an empty success', async () => {
  const subjectType = { type: { in: ['schema:Person'] } };
  const notSubjectType = { not: subjectType };
  expect(currentDiscoveryFilter(subjectType, registry, 'collection', bundledRelease)).toBe(false);
  expect(currentDiscoveryFilter(notSubjectType, registry, 'collection', bundledRelease)).toBe(false);
  expect(JSON.stringify(compileDiscoveryFilter(notSubjectType, registry, bundledRelease).query)).toContain(
    '"owner":"semantic"',
  );
  const candidate = { key: { owner: 'content', kind: 'collection', route: 160, id } } as unknown as DiscoveryCandidate;
  await expect(
    currentDiscoveryCandidates(registry, [candidate], notSubjectType, bundledRelease, {} as DiscoveryReadContext),
  ).rejects.toThrow('Current discovery owner evidence is unavailable');
  expect(
    compareDiscoveryTuple([id, 'collection', 'collection:uuid'], [id, 'review', 'thread:uuid'], 'id'),
  ).toBeLessThan(0);
});
