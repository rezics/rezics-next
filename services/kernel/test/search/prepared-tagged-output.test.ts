import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { DiscoveryFilterDocument } from '@rezics/filter';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { currentDiscoveryCandidates } from '../../src/search/discovery-current.ts';
import type { DiscoveryEngineHit, DiscoveryReadContext } from '../../src/search/discovery.ts';
import { checkHits, type Hit } from '../../src/search/disclosure/check.ts';
import { selectCurrentPredicatePage } from '../../src/search/current-predicate.ts';
import type { SubjectSummary } from '../../src/semantic/index.ts';
import { createPreparedDiscoveryOutputSegment } from '../../src/search/prepared-discovery-output.ts';
import { appendPayload } from '../../src/search/public-filter-preparation-segment.ts';
import { admitTaggedWorkPlan, taggedWorkEngineWindow, taggedWorkRawBound } from '../../src/search/tagged-work-plan.ts';

const RAW = 670;
const REJECTED = 650;
const PAGE = 20;

test('segmented tagged preparation resumes past same-statement qualifier rejects and serving rechecks withdrawal', async () => {
  const ids = Array.from({ length: RAW }, () => randomUUID()).sort();
  const matches = new Set<string>(ids.slice(REJECTED));
  const uncertain = new Set<string>();
  const visibility = new Map<string, IndexedSubject['visibility']>(ids.map((id) => [id, 'visible']));
  const subjects = new Map<string, IndexedSubject>(
    ids.map((id) => [
      id,
      {
        id,
        type: 'schema:Book',
        visibility: 'visible',
        redirect: null,
        securityRevision: 1,
        labels: [],
        aliases: [],
        descriptions: [],
        statements: [],
      },
    ]),
  );
  const source: SubjectSource = {
    async read(partition, requested) {
      return {
        partition,
        position: 1n,
        subjects: requested.flatMap((id) => {
          const subject = subjects.get(id);
          return subject ? [{ ...subject, visibility: visibility.get(id)! }] : [];
        }),
      };
    },
    async count() {
      return { position: 1n, count: RAW };
    },
    async matchRelationFacets(partition, probes) {
      return probes.map((probe) => {
        expect(partitionOf(routeOf(probe.subject)!)).toBe(partition);
        expect(probe.qualifiers).toHaveLength(1);
        if (uncertain.has(probe.subject)) return 'not_proven';
        return matches.has(probe.subject);
      });
    },
  };
  const registry = createDiscoveryRegistry({
    release: bundledRelease,
    semantic: {
      source,
      async hydrate(requested) {
        return new Map<string, SubjectSummary>(
          requested.map((id) => [
            id,
            {
              id,
              type: 'schema:Book',
              types: ['schema:Book'],
              label: null,
              creativeWork: true,
              cover: null,
            },
          ]),
        );
      },
      icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
    },
    accounts: {
      source: {
        async read(partition) {
          return { partition, position: 1n, accounts: [] };
        },
        async count(partition) {
          return { partition, position: 1n, count: 0 };
        },
        async page(partition) {
          return { partition, position: 1n, accounts: [], next: null };
        },
      },
      async hydrate() {
        return new Map();
      },
      labels: { en: 'Accounts' },
      icon: 'account',
    },
  });
  const filter: DiscoveryFilterDocument = {
    statement: {
      property: 'schema:genre',
      in: ['018f0000-0000-7000-8000-000000000001'],
      concept: { scheme: '018f0000-0000-7000-8000-000000000002' },
      qualifiers: [{ property: 'rezics:sourceTagWeight', range: { gte: 2, unit: '1' } }],
    },
  };
  const currentFilter = {
    statement: {
      property: 'schema:genre',
      in: ['018f0000-0000-7000-8000-000000000001'],
      qualifiers: [{ property: 'rezics:sourceTagWeight', range: { gte: 2, unit: '1' } }],
    },
  };
  const raw: DiscoveryEngineHit[] = ids.map((id) => ({
    key: { owner: 'semantic', kind: 'schema:Book', route: routeOf(id)!, id },
    index: 'prepared-tagged',
    sourcePosition: '1',
    revision: '1',
    matched: [],
    sort: [id],
  }));
  const saved: string[] = [];
  let rawCount = 0;
  let outputCount = 0;
  const append = async (batch: readonly DiscoveryEngineHit[]) => {
    const next = await createPreparedDiscoveryOutputSegment({
      hits: batch,
      ownerRows: batch.map(({ key }) => ({ original: key.id, terminal: key.id })),
      ownerPositions: batch.map((_hit, index) => index),
      rawCount,
      outputCount,
      filter,
      registry,
      release: bundledRelease,
    });
    saved.push(appendPayload(next.entries));
    rawCount = next.rawCount;
    outputCount = next.outputCount;
  };
  for (let start = 0; start < 400; start += 100) await append(raw.slice(start, start + 100));

  // Reopen only committed append payloads; the raw frontier includes each definite reject.
  const reopen = () =>
    saved.flatMap(
      (payload) =>
        JSON.parse(payload) as {
          raw_ordinal: number;
          output_ordinal: number | null;
          payload: { hit: DiscoveryEngineHit; owner: { original: string; terminal: string } };
        }[],
    );
  let restored = reopen();
  rawCount = restored.length;
  outputCount = restored.filter(({ output_ordinal }) => output_ordinal !== null).length;
  for (let start = rawCount; start < RAW; start += 100) await append(raw.slice(start, Math.min(start + 100, RAW)));
  restored = reopen();

  expect(rawCount).toBe(RAW);
  expect(outputCount).toBe(PAGE);
  expect(restored.map(({ raw_ordinal }) => raw_ordinal)).toEqual(ids.map((_id, index) => index));
  const outputRows = restored
    .filter((row): row is typeof row & { output_ordinal: number } => row.output_ordinal !== null)
    .sort((left, right) => left.output_ordinal - right.output_ordinal);
  expect(outputRows.map(({ payload }) => payload.hit.key.id)).toEqual(ids.slice(REJECTED));

  const plan = admitTaggedWorkPlan({
    filter: { and: [{ kind: { in: ['schema:Book'] } }, filter] },
    kindCountLeaf: 0,
    sort: 'id',
    limit: PAGE,
    registeredKinds: new Set(['schema:Book']),
  });
  expect(taggedWorkRawBound(true, plan, PAGE)).toBe(600);
  expect(taggedWorkEngineWindow({ prepared: true, remainingHits: PAGE, remainingRaw: outputCount })).toBe(PAGE);

  const preparedHits = outputRows.map(({ payload }) => payload.hit);
  const readContext = {
    actor: { kind: 'anonymous' },
    access: {},
    deadline: Date.now() + 30_000,
  } as DiscoveryReadContext;
  const current = await currentDiscoveryCandidates(registry, preparedHits, undefined, bundledRelease, readContext);
  const page = selectCurrentPredicatePage(preparedHits, current, { limit: PAGE, exhausted: true });
  expect(page.hits.map(({ key }) => key.id)).toEqual(ids.slice(REJECTED));
  expect(page.exhausted).toBe(true);

  const unknownId = ids[0]!;
  uncertain.add(unknownId);
  const unknownHit: Hit = {
    id: unknownId,
    partition: partitionOf(routeOf(unknownId)!),
    securityRevision: 1,
    matched: [],
  };
  const unknown = await checkHits(source, [unknownHit], new Map(), {
    filter: currentFilter,
    relationProperties: ['schema:genre'],
    includeOutcomes: true,
  });
  expect(unknown.outcomes).toEqual(['not_proven']);
  expect(unknown.relationRejected).toBe(true);

  const withdrawn = outputRows[0]!.payload.hit;
  visibility.set(withdrawn.key.id, 'hidden');
  const currentAfterWithdrawal = await currentDiscoveryCandidates(
    registry,
    [withdrawn],
    undefined,
    bundledRelease,
    readContext,
  );
  expect(currentAfterWithdrawal.has(withdrawn)).toBe(false);
});
