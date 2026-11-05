import { expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import { checkHits, type FactClause, type Hit } from '../../src/search/disclosure/check.ts';
import { discloseFacetValues } from '../../src/search/facets.ts';
import {
  subjectPartition,
  type IndexedSubject,
  type SubjectSnapshot,
  type SubjectSource,
} from '../../src/search/source.ts';

type Home = { id: string; partition: number };

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;

function homes(count: number): Home[] {
  const unique = new Map<number, string>();
  for (let n = 1; unique.size < count; n++) {
    const value = id(n);
    const partition = subjectPartition(value);
    if (!unique.has(partition)) unique.set(partition, value);
  }
  return [...unique].map(([partition, value]) => ({ id: value, partition }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function subject(value: string, overflowProperty?: string): IndexedSubject {
  return {
    id: value,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [],
    ...(overflowProperty === undefined ? {} : { relationFacetOverflow: [overflowProperty] }),
  };
}

const snapshot = (partition: number, ids: readonly string[]): SubjectSnapshot => ({
  partition,
  position: 0n,
  subjects: ids.map((value) => subject(value)),
});

async function expectReadDrain(run: (source: SubjectSource, ids: readonly string[]) => Promise<unknown>) {
  const selected = homes(9);
  const gates = new Map(selected.slice(0, 8).map(({ partition }) => [partition, deferred<SubjectSnapshot>()]));
  const reads: number[] = [];
  let eightStarted!: () => void;
  const started = new Promise<void>((resolve) => (eightStarted = resolve));
  const source: SubjectSource = {
    read(partition) {
      reads.push(partition);
      if (reads.length === 8) eightStarted();
      return gates.get(partition)?.promise ?? Promise.resolve(snapshot(partition, []));
    },
    async count() {
      return { position: 0n, count: 0 };
    },
  };
  const failure = new Error('Source read failed');
  let settled = false;
  const pending = run(
    source,
    selected.map(({ id }) => id),
  );
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  const rejected = expect(pending).rejects.toBe(failure);

  await started;
  gates.get(selected[0]!.partition)!.reject(failure);
  await Promise.resolve();
  for (const { partition } of selected.slice(2, 8)) gates.get(partition)!.resolve(snapshot(partition, []));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(reads).toEqual(selected.slice(0, 8).map(({ partition }) => partition));

  const sibling = selected[1]!;
  gates.get(sibling.partition)!.resolve(snapshot(sibling.partition, []));
  await rejected;
  expect(reads).toHaveLength(8);
}

test('Source read failures drain admitted facet and hit reads before rejecting', async () => {
  await expectReadDrain((source, ids) => discloseFacetValues(source, ids));
  await expectReadDrain((source, ids) =>
    checkHits(
      source,
      ids.map((value): Hit => ({ id: value, partition: subjectPartition(value), securityRevision: 1, matched: [] })),
      new Map<string, FactClause>(),
    ),
  );
});

test('relation probe failure stops later homes and drains the already-started probe', async () => {
  const selected = homes(9);
  const property = 'schema:author';
  const target = id(1000);
  const gates = new Map(selected.slice(0, 8).map(({ partition }) => [partition, deferred<boolean[]>()]));
  const reads: number[] = [];
  const probes: number[] = [];
  let eightProbesStarted!: () => void;
  const started = new Promise<void>((resolve) => (eightProbesStarted = resolve));
  const source: SubjectSource = {
    async read(partition, ids) {
      reads.push(partition);
      return { partition, position: 0n, subjects: ids.map((value) => subject(value, property)) };
    },
    async count() {
      return { position: 0n, count: 0 };
    },
    matchRelationFacets(partition, relationProbes) {
      probes.push(partition);
      if (probes.length === 8) eightProbesStarted();
      return gates.get(partition)?.promise ?? Promise.resolve(relationProbes.map(() => true));
    },
  };
  const filter: FilterDocument = { statement: { property, in: [target] } };
  const hits = selected.map(({ id, partition }): Hit => ({ id, partition, securityRevision: 1, matched: [] }));
  const failure = new Error('Relation probe failed');
  let settled = false;
  const pending = checkHits(source, hits, new Map<string, FactClause>(), {
    filter,
    relationProperties: [property],
  });
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  const rejected = expect(pending).rejects.toBe(failure);

  await started;
  gates.get(selected[0]!.partition)!.reject(failure);
  await Promise.resolve();
  for (const { partition } of selected.slice(2, 8)) gates.get(partition)!.resolve([true]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(reads).toHaveLength(8);
  expect(probes).toHaveLength(8);

  gates.get(selected[1]!.partition)!.resolve([true]);
  await rejected;
  expect(reads).toHaveLength(8);
  expect(probes).toHaveLength(8);
});

async function expectBoundedSuccess(
  selected: readonly Home[],
  run: (source: SubjectSource) => Promise<unknown>,
  assertResult: (result: unknown) => void,
) {
  const gates = new Map(selected.slice(0, 8).map(({ partition }) => [partition, deferred<SubjectSnapshot>()]));
  const reads: number[] = [];
  let active = 0;
  let peak = 0;
  let eightStarted!: () => void;
  const started = new Promise<void>((resolve) => (eightStarted = resolve));
  const source: SubjectSource = {
    read(partition, ids) {
      reads.push(partition);
      active++;
      peak = Math.max(peak, active);
      if (reads.length === 8) eightStarted();
      const result = gates.get(partition)?.promise ?? Promise.resolve(snapshot(partition, ids));
      return result.finally(() => active--);
    },
    async count() {
      return { position: 0n, count: 0 };
    },
  };
  const pending = run(source);
  await started;
  expect(reads).toEqual(selected.slice(0, 8).map(({ partition }) => partition));
  for (const home of [...selected.slice(0, 8)].reverse())
    gates.get(home.partition)!.resolve(snapshot(home.partition, [home.id]));
  const result = await pending;
  expect(reads).toHaveLength(selected.length);
  expect(peak).toBe(8);
  assertResult(result);
}

test('successful fanout remains bounded and returns values in request order', async () => {
  const selected = homes(10);
  const ids = selected.map(({ id }) => id);
  await expectBoundedSuccess(
    selected,
    (source) => discloseFacetValues(source, [...ids, ids[0]!]),
    (result) => expect([...(result as Map<string, IndexedSubject>).keys()]).toEqual(ids),
  );
  await expectBoundedSuccess(
    selected,
    (source) =>
      checkHits(
        source,
        selected.map(({ id, partition }): Hit => ({ id, partition, securityRevision: 1, matched: [] })),
        new Map<string, FactClause>(),
        { concurrency: 20 },
      ),
    (result) => expect((result as Awaited<ReturnType<typeof checkHits>>).passed.map(({ hit }) => hit.id)).toEqual(ids),
  );
});
