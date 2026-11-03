import { expect, test } from 'bun:test';
import {
  matchCharacterPersonWitnesses,
  prepareCharacterPersonPage,
  authorizeCharacterPersonPage,
  planCharacterPersonWitnesses,
} from '../../src/search/character-person-voice.ts';
import { collectRetainedUsefulPage, type SearchConsumedWindow } from '../../src/search/useful-page.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import { withPublicRatings } from '../../src/search/rating-subject-source.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import type {
  IndexedStatement,
  IndexedSubject,
  RelationFacetProbe,
  RelationFacetMatch,
  SubjectSource,
} from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const credit = (character?: string, role = id(8)) => ({
  subject: id(1),
  statement: {
    property: 'wdt:P725',
    value: id(2),
    qualifiers: [
      { property: 'wdt:P3831', value: role },
      ...(character ? [{ property: 'wdt:P453', value: character }] : []),
    ],
  },
});
const probe = (threshold?: 0 | 1 | 2, character?: string): RelationFacetProbe => ({
  subject: id(1),
  property: 'wdt:P725',
  value: id(2),
  ...(threshold === undefined ? {} : { spoilerThreshold: threshold }),
  ...(character ? { qualifiers: [{ property: 'wdt:P453', in: [character] }] } : {}),
});

test('each repeated voice credit needs its own current permitted appearance at thresholds 0/1/2', async () => {
  const rows = [credit(id(3)), credit(id(4)), credit(undefined)];
  let appearances: IndexedStatement[] = [3, 4].map((n) => ({
    property: 'schema:character',
    value: id(n),
    qualifiers: [{ property: 'rezics:spoilerLevel', value: String(n - 2) }],
  }));
  const match = async (probes: readonly RelationFacetProbe[]) =>
    probes.map((p) =>
      holdsCurrentStatements(appearances, {
        facet: 'statement',
        property: p.property,
        values: [p.value],
        qualifiers: p.qualifiers,
      })
        ? true
        : ('not_proven' as const),
    );
  for (const threshold of [0, 1, 2] as const) {
    expect(
      await matchCharacterPersonWitnesses([probe(threshold, id(3)), probe(threshold, id(4))], rows, match),
    ).toEqual([threshold >= 1 ? true : 'not_proven', threshold >= 2 ? true : 'not_proven']);
  }
  // One multi-character credit cannot disclose its hidden second character through the first.
  const combined = credit(id(3));
  combined.statement.qualifiers.push({ property: 'wdt:P453', value: id(4) });
  expect(await matchCharacterPersonWitnesses([probe(1)], [combined], match)).toEqual(['not_proven']);
  expect(await matchCharacterPersonWitnesses([probe(2)], [credit(undefined)], match)).toEqual(['not_proven']);
  expect(await matchCharacterPersonWitnesses([probe()], [credit(undefined)], match)).toEqual([true]);
  appearances[0]!.qualifiers!.push({ property: 'rezics:spoilerLevel', value: '0' });
  expect(await matchCharacterPersonWitnesses([probe(2, id(3))], rows, match)).toEqual(['not_proven']);
  appearances = [];
  expect(await matchCharacterPersonWitnesses([probe(2)], rows, match)).toEqual(['not_proven']);
});

test('appearance batches include sparse late witnesses and reanchor credits after foreign reads', async () => {
  const rows = Array.from({ length: 257 }, (_, n) => credit(id(n + 10)));
  const plan = planCharacterPersonWitnesses([probe(0), probe(0)], [...rows, rows[0]!]);
  expect(plan.touchedPools).toEqual([
    {
      partition: 10,
      primaryKeys: 1,
      appearanceKeys: 257,
      primaryBatches: 1,
      appearanceBatches: 2,
      probeBatchBound: 3,
    },
  ]);
  const twoThresholds = planCharacterPersonWitnesses([probe(0), probe(1)], rows);
  expect(twoThresholds.touchedPools[0]).toMatchObject({
    primaryKeys: 1,
    appearanceKeys: 514,
    appearanceBatches: 3,
    probeBatchBound: 4,
  });
  const sizes: number[] = [];
  const match = async (probes: readonly RelationFacetProbe[]) => {
    sizes.push(probes.length);
    return probes.map((p) => (p.value === id(266) ? true : ('not_proven' as const)));
  };
  expect(await matchCharacterPersonWitnesses([probe(0)], rows, match)).toEqual([true]);
  expect(sizes).toEqual([256, 1]);
  expect(await matchCharacterPersonWitnesses([probe(0)], rows, match, async () => [])).toEqual(['not_proven']);
  expect(await matchCharacterPersonWitnesses([probe(0)], rows, match, async () => [credit(id(999))])).toEqual([
    'not_proven',
  ]);
  await expect(matchCharacterPersonWitnesses([probe(0)], rows, async () => [])).rejects.toThrow(
    'Malformed appearance probe results',
  );
});

test('inverse Boolean checks forward the threshold and unavailable appearances remain unknown under NOT', async () => {
  const actor: IndexedSubject = {
    id: id(2),
    type: 'schema:Person',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const seen: RelationFacetProbe[] = [];
  const source: SubjectSource = {
    read: async () => ({ partition: 10, position: 1n, subjects: [actor] }),
    count: async () => ({ position: 1n, count: 1 }),
    matchRelationFacets: async (_, probes) => {
      seen.push(...probes);
      return matchCharacterPersonWitnesses(probes, [credit(id(3))], async (ps) => ps.map(() => 'not_proven'));
    },
  };
  const leaf = { statement: { property: 'wdt:P725', inverse: true as const, in: [id(1)] } };
  for (const filter of [leaf, { not: leaf }]) {
    const result = await checkHits(
      source,
      [{ id: actor.id, partition: 10, securityRevision: 1, matched: [] }],
      new Map(),
      {
        filter,
        spoilerThreshold: 0,
        relationProperties: ['wdt:P725'],
        observeRelationRelease: async () => ({ digest: 'release', head: 1, release: { types: {}, properties: {} } }),
      },
    );
    expect(result.passed).toEqual([]);
    expect(result.relationRejected).toBe(true);
  }
  expect(seen).toEqual([probe(0), probe(0)]);
});

function retainedFixture() {
  const rows: { subject: string; statement: IndexedStatement }[] = [];
  const prepared: RelationFacetProbe[][] = [];
  const dispatched: RelationFacetProbe[][] = [];
  let epoch = 0;
  let onDispatch = () => {};
  return {
    rows,
    prepared,
    dispatched,
    change() {
      epoch++;
    },
    onDispatch(callback: () => void) {
      onDispatch = callback;
    },
    async prepare(partition: number, input: readonly RelationFacetProbe[]) {
      const before = epoch;
      const statements = structuredClone(
        rows.filter((row) =>
          input.some(
            (p) =>
              p.subject === row.subject && p.property === row.statement.property && p.value === row.statement.value,
          ),
        ),
      );
      prepared.push([...input]);
      return {
        partition,
        input,
        probes: input,
        statements,
        revalidate: async () => before === epoch,
        async finish(values: readonly RelationFacetMatch[]) {
          dispatched.push([...input]);
          onDispatch();
          return [...values];
        },
      };
    },
  };
}

test('one page authorizes all cuts and distinct work/character/threshold keys before dispatch', async () => {
  const f = retainedFixture();
  const probes = Array.from({ length: 257 }, (_, n) => ({ ...probe(0), value: id(n + 1000) }));
  // The same appearance is introduced by different native credits, across the 256-key cut.
  for (const p of probes) f.rows.push({ ...credit(id(3)), statement: { ...credit(id(3)).statement, value: p.value } });
  probes.push({ ...probes[0]!, spoilerThreshold: 1 }, probes[0]!);
  const otherWork = id(2).replace('00a0', '00b0');
  probes.push({ ...probe(0), subject: otherWork });
  f.rows.push({ ...credit(id(3)), subject: otherWork });
  for (const subject of [id(1), otherWork])
    f.rows.push({
      subject,
      statement: {
        property: 'schema:character',
        value: id(3),
        qualifiers: [{ property: 'rezics:spoilerLevel', value: '0' }],
      },
    });
  const page = await prepareCharacterPersonPage(probes, f.prepare);
  expect(f.dispatched).toEqual([]);
  expect(page.bounds).toEqual([
    { partition: 10, primaryKeys: 257, appearanceKeys: 2, primaryBatches: 2, appearanceBatches: 1, probeBatchBound: 3 },
    { partition: 11, primaryKeys: 1, appearanceKeys: 1, primaryBatches: 1, appearanceBatches: 1, probeBatchBound: 2 },
  ]);
  const preparedCount = f.prepared.length;
  f.onDispatch(() => expect(f.prepared).toHaveLength(preparedCount));
  probes.length = 0;
  expect((await page.match()).every((value) => value === true)).toBe(true);
  expect(f.dispatched).toHaveLength(5);
  await expect(page.match()).rejects.toThrow('already dispatched');
  const authorization = authorizeCharacterPersonPage(planCharacterPersonWitnesses([probe(0)], [credit(id(3))]));
  authorization.dispatch(10, 'primary');
  expect(() => authorization.dispatch(10, 'primary')).toThrow('exceeded its retained bound');
  expect(() => authorization.dispatch(10, 'appearance')).toThrow('exceeded its retained bound');
});

test('a changed retained cut before or during dispatch retires the complete page and a fresh page repairs it', async () => {
  for (const during of [false, true]) {
    const f = retainedFixture();
    f.rows.push(credit(id(3)), {
      subject: id(1),
      statement: {
        property: 'schema:character',
        value: id(3),
        qualifiers: [{ property: 'rezics:spoilerLevel', value: '0' }],
      },
    });
    const page = await prepareCharacterPersonPage([probe(0)], f.prepare);
    if (during) f.onDispatch(() => f.change());
    else f.change();
    expect(await page.match()).toEqual(['not_proven']);
    expect(await page.revalidate()).toBe(false);
    if (!during) expect(f.dispatched).toEqual([]);
    f.onDispatch(() => {});
    expect(await (await prepareCharacterPersonPage([probe(0)], f.prepare)).match()).toEqual([true]);
  }
});

test('an actual pool outside the retained bound retires the complete page', async () => {
  const f = retainedFixture();
  const page = await prepareCharacterPersonPage([probe()], async (partition, probes) => {
    const cut = await f.prepare(partition, probes);
    return cut && { ...cut, partition: partition + 1 };
  });

  expect(await page.match()).toEqual(['not_proven']);
  expect(await page.revalidate()).toBe(false);
  expect(f.dispatched).toEqual([]);
});

test('rated first next and final retained pages stay ordered through dense current voice rejections', async () => {
  const accepted = new Set([3, 7, 10, 14, 18].map((n) => id(n + 100)));
  const subjects: IndexedSubject[] = Array.from({ length: 20 }, (_, n) => ({
    id: id(n + 100),
    type: 'schema:Movie',
    visibility: accepted.has(id(n + 100)) ? 'visible' : 'hidden',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [],
  }));
  const f = retainedFixture();
  for (const subject of subjects.filter((s) => accepted.has(s.id)))
    f.rows.push(
      { ...credit(id(3)), subject: subject.id },
      {
        subject: subject.id,
        statement: {
          property: 'schema:character',
          value: id(3),
          qualifiers: [{ property: 'rezics:spoilerLevel', value: '0' }],
        },
      },
    );
  const semantic: SubjectSource = {
    read: async (partition, ids) => ({ partition, position: 1n, subjects: subjects.filter((s) => ids.includes(s.id)) }),
    count: async () => ({ position: 1n, count: subjects.length }),
    prepareRelationFacets: (probes) => prepareCharacterPersonPage(probes, f.prepare),
  };
  const binding = { questionId: id(9), populationId: GLOBAL_CONTEXT.id };
  const source = withPublicRatings(
    semantic,
    {
      read: async (partition) => ({ partition, position: 1n, figures: new Map() }),
      epoch: async () => ({ ...binding, priorEpoch: null }),
    },
    binding,
  );
  let offset = 0;
  let consumed = 0;
  let continuation: SearchConsumedWindow | undefined;
  const pages: string[][] = [];
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const page = await collectRetainedUsefulPage({
      limit: 2,
      continuation,
      read: async (size) => {
        offset += consumed;
        const hits = subjects.slice(offset, offset + size).map((s) => ({
          id: s.id,
          partition: 10,
          securityRevision: 1,
          matched: [],
          sort: [s.id],
        }));
        return {
          execution: `window-${offset}`,
          hits,
          window: {
            examined: hits.length,
            positions: hits.map((_, i) => i),
            exhausted: offset + hits.length === subjects.length,
          },
        };
      },
      check: async (hits) =>
        new Map(
          (
            await checkHits(source, hits, new Map(), {
              filter: { statement: { property: 'wdt:P725', in: [id(2)] } },
              relationProperties: ['wdt:P725'],
              spoilerThreshold: 0,
            })
          ).passed.map(({ hit, subject }) => [hit, subject]),
        ),
      consume: async (prefix) => {
        consumed = prefix.consumed;
      },
      canonicalId: (subject) => subject.id,
    });
    expect(page.status).toBe(pageNumber === 2 ? 'exhausted' : 'filled');
    continuation = page.continuation;
    pages.push(page.values.map((s) => s.id));
  }
  expect(pages).toEqual([[id(103), id(107)], [id(110), id(114)], [id(118)]]);
});

test('source cuts and release activation retire the entire Boolean window even when another branch passes', async () => {
  for (const change of ['source', 'release']) {
    const subject: IndexedSubject = {
      id: id(1),
      type: 'schema:Movie',
      visibility: 'visible',
      redirect: null,
      securityRevision: 1,
      labels: [],
      aliases: [],
      descriptions: [],
      statements: [],
    };
    let position = 1n;
    let head = 1;
    const source: SubjectSource = {
      read: async () => ({ partition: 10, position, subjects: [subject] }),
      count: async () => ({ position, count: 1 }),
      prepareRelationFacets: async (probes) => ({
        bounds: [{ partition: 10, probeBatchBound: 1 }],
        revalidate: async () => true,
        async match() {
          if (change === 'source') position++;
          else head += 2;
          return probes.map(() => true);
        },
      }),
    };
    const result = await checkHits(
      source,
      [{ id: id(1), partition: 10, securityRevision: 1, matched: [] }],
      new Map(),
      {
        filter: { or: [{ type: { in: ['schema:Movie'] } }, { statement: { property: 'wdt:P725', in: [id(2)] } }] },
        relationProperties: ['wdt:P725'],
        spoilerThreshold: 0,
        observeRelationRelease: async () => ({ digest: 'same-release', head, release: { types: {}, properties: {} } }),
      },
    );
    expect(result.passed).toEqual([]);
    expect(result.relationRejected).toBe(true);
  }
});
