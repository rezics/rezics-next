import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  admitClassificationAggregate,
  aggregateLeaksCounts,
  bindDisclosedClassificationAssociation,
  classificationBallotHandle,
  publicAggregateProjection,
  readClassificationAggregate,
  readClassificationOwnBallot,
  writeClassificationBallot,
  type ClassificationAssociationIdentity,
  type ClassificationOwnState,
} from '../src/features/pages/subject-classification-assessment';
import {
  captureClassificationCommand,
  replayClassificationCommand,
  sameClassificationCommand,
} from '../src/features/pages/subject-classification-assessment-commands';
import {
  applyClassificationCommand,
  applyClassificationRead,
  emptyClassificationSnapshot,
  measureClassificationVisit,
  retireClassificationSnapshot,
} from '../src/features/pages/subject-classification-assessment-controller';
import { ClassificationAssessmentView } from '../src/features/pages/subject-classification-assessment-view';
import { providerStatisticLabel, readRatings, type Statistic } from '../src/features/pages/subject-ratings';
import { RatingsView } from '../src/features/pages/subject-ratings-view';
import { GLOBAL, QUESTION } from '../src/features/pages/subject-ratings';

const subjectId = '00000000-0000-8000-8000-000000000010';
const associationId = '00000000-0000-8000-8000-000000000011';
const targetId = '00000000-0000-8000-8000-000000000012';
const identity: ClassificationAssociationIdentity = {
  subjectId,
  associationId,
  property: 'schema:keywords',
  targetId,
  contextId: PAGE_GLOBAL_CONTEXT,
  qualifiersKey: '[]',
  spoilerLevel: 0,
};
const digest = 'ab'.repeat(32);

type Store = {
  own: ClassificationOwnState;
  aggregate: unknown;
  statistics: Statistic[];
  writes: { method: string; path: string; key: string | null; body: unknown; authorization: string | null }[];
  calls: number;
  failNext?: number;
};

function client(store: Store) {
  return createKernelClient('https://kernel.example', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;
      const key = request.headers.get('idempotency-key');
      const authorization = request.headers.get('authorization');
      store.calls += 1;
      if (path.includes('/rating-questions/'))
        return Response.json({
          id: QUESTION,
          revision: 1,
          label: 'How much did you like this work?',
          grain: 'work',
          scale: { min: 0, max: 20, displayStep: 1 },
        });
      if (path.endsWith('/figure'))
        return Response.json({
          figure: {
            questionId: QUESTION,
            populationId: GLOBAL,
            scale: { min: 0, max: 20, displayStep: 1 },
            count: 12,
            state: 'ready',
            mean: 8.4,
            score: 8,
          },
        });
      if (path.endsWith('/ratings'))
        return Response.json({
          question: QUESTION,
          subject: subjectId,
          figures: [{ population: GLOBAL, count: 12, mean: 16.8 }],
        });
      if (path.endsWith('/source-statistics')) return Response.json(store.statistics);
      if (path.includes('/vote')) return Response.json({ units: 17, revision: 1, at: '2026-01-01T00:00:00.000Z' });
      store.writes.push({
        method: request.method,
        path,
        key,
        body: request.method === 'PUT' ? await request.clone().json().catch(() => null) : null,
        authorization,
      });
      if (store.failNext) {
        const status = store.failNext;
        store.failNext = undefined;
        return new Response(null, { status });
      }
      if (path.endsWith('/aggregate')) return Response.json(store.aggregate);
      if (path.endsWith('/assessment') && request.method === 'GET') return Response.json(store.own);
      if (path.endsWith('/assessment') && request.method === 'PUT') {
        const body = (await request.json()) as { assessment: 'support' | 'oppose'; falsePositive: boolean };
        const revision = String(Number(store.own.revision ?? '0') + 1);
        store.own = {
          associationId,
          hasBallot: true,
          assessment: body.assessment,
          falsePositive: body.falsePositive,
          revision,
          pending: true,
        };
        return Response.json({ associationId, revision, delivery: 'enqueued' });
      }
      if (path.endsWith('/assessment') && request.method === 'DELETE') {
        store.own = {
          associationId,
          hasBallot: false,
          assessment: null,
          falsePositive: false,
          revision: store.own.revision ? String(Number(store.own.revision) + 1) : '1',
          pending: true,
        };
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
}

const request = (reader = 'reader-1') =>
  new Request('https://site.test', { headers: { authorization: 'Bearer token', 'x-reader': reader } });

const disclosed = [
  {
    ...identity,
    propertyLabel: 'Tags',
    targetLabel: 'Slice of life',
    inspectHref: '/en/subjects/subject/value',
    changesHref: '/en/subjects/subject/changes',
  },
];

test('support, independent lie flag, oppose change, withdrawal, exact retry and concealment', async () => {
  const store: Store = {
    own: {
      associationId,
      hasBallot: false,
      assessment: null,
      falsePositive: false,
      revision: null,
      pending: false,
    },
    aggregate: { associationId, state: 'suppressed', pending: 'unknown' },
    statistics: [],
    writes: [],
    calls: 0,
  };
  const transport = client(store);
  expect(classificationBallotHandle(transport, subjectId, associationId)).not.toBeNull();
  const session = {};
  const own = await readClassificationOwnBallot(transport, request(), session, identity, undefined);
  expect(own.outcome.kind).toBe('absent');
  const support = await writeClassificationBallot(transport, identity, 'Bearer token', '00000000-0000-4000-8000-000000000001', {
    kind: 'set',
    assessment: 'support',
    falsePositive: true,
  });
  expect(support).toMatchObject({ kind: 'accepted', result: { delivery: 'enqueued' } });
  expect(store.own).toMatchObject({ assessment: 'support', falsePositive: true, pending: true });
  const oppose = await writeClassificationBallot(transport, identity, 'Bearer token', '00000000-0000-4000-8000-000000000002', {
    kind: 'set',
    assessment: 'oppose',
    falsePositive: true,
  });
  expect(oppose).toMatchObject({ kind: 'accepted' });
  expect(store.own.assessment).toBe('oppose');
  const withdrawn = await writeClassificationBallot(transport, identity, 'Bearer token', '00000000-0000-4000-8000-000000000003', {
    kind: 'withdraw',
  });
  expect(withdrawn.kind).toBe('accepted');
  expect(store.own.hasBallot).toBe(false);
  store.failNext = 503;
  const command = captureClassificationCommand({
    identity,
    expectedReader: 'reader-1',
    csrfToken: 'csrf',
    idempotencyKey: '00000000-0000-4000-8000-000000000004',
    operands: { kind: 'set', assessment: 'support', falsePositive: false },
  });
  const uncertain = await writeClassificationBallot(
    transport,
    command.identity,
    'Bearer token',
    command.idempotencyKey,
    command.operands,
  );
  expect(uncertain.kind).toBe('uncertain');
  const replay = replayClassificationCommand(command);
  expect(sameClassificationCommand(command, replay)).toBe(true);
  const retried = await writeClassificationBallot(
    transport,
    replay.identity,
    'Bearer token',
    replay.idempotencyKey,
    replay.operands,
  );
  expect(retried.kind).toBe('accepted');
  expect(store.writes.filter((item) => item.key?.includes('000000000004'))).toHaveLength(2);
  expect(store.writes.every((item) => item.authorization === 'Bearer token')).toBe(true);
  store.failNext = 404;
  const hidden = await readClassificationOwnBallot(transport, request(), session, identity);
  expect(hidden.outcome.kind).toBe('concealed');
  const html = renderToStaticMarkup(
    createElement(ClassificationAssessmentView, {
      snapshot: {
        ...emptyClassificationSnapshot('signed-in', identity, 'reader-1'),
        own: { kind: 'concealed' },
        aggregate: { kind: 'concealed' },
      },
      associations: disclosed,
      locale: 'en',
      title: 'Work',
      returnTo: '/en/subjects/work',
      csrfToken: 'csrf',
      sourcesHref: '/en/subjects/work/sources',
      onSelect: () => {},
      onCommand: () => {},
      onRetry: () => {},
    }),
  );
  expect(html).toContain('not available');
  expect(html).not.toContain('You support');
});

test('stale revision, association and viewer replacement retire previous rows', () => {
  const snapshot = applyClassificationRead(emptyClassificationSnapshot('signed-in', identity, 'reader-1'), {
    reader: 'reader-1',
    identity,
    own: {
      kind: 'acknowledged',
      value: {
        associationId,
        hasBallot: true,
        assessment: 'support',
        falsePositive: false,
        revision: '1',
        pending: false,
      },
    },
    aggregate: { kind: 'ready', value: { associationId, state: 'suppressed', pending: 'unknown' } },
    cost: { nativeCalls: 2, valuesProcessed: 2, bytesRetained: 40 },
  });
  expect(snapshot.own.kind).toBe('acknowledged');
  const other = { ...identity, associationId: '00000000-0000-8000-8000-000000000099' };
  const replaced = retireClassificationSnapshot(snapshot, { identity: other, reader: 'reader-1', session: 'signed-in' });
  expect(replaced.own.kind).toBe('preparing');
  expect(replaced.command).toBeNull();
  const viewer = retireClassificationSnapshot(snapshot, { identity, reader: 'reader-2', session: 'signed-in' });
  expect(viewer.own.kind).toBe('preparing');
  const stale = applyClassificationCommand(snapshot, {
    kind: 'conflict',
    command: captureClassificationCommand({
      identity,
      expectedReader: 'reader-1',
      csrfToken: 'csrf',
      operands: { kind: 'set', assessment: 'oppose', falsePositive: false },
    }),
  });
  expect(stale.own.kind).toBe('conflict');
});

test('suppressed aggregate leaks no counts; published keeps lie flags separate from enjoyment', async () => {
  const suppressed = { associationId, state: 'suppressed' as const, pending: 'unknown' as const, supportCount: 3 };
  expect(admitClassificationAggregate(suppressed, associationId)).toBeNull();
  expect(aggregateLeaksCounts(suppressed)).toBe(true);
  const clean = admitClassificationAggregate(
    { associationId, state: 'suppressed', pending: 'unknown' },
    associationId,
  );
  expect(clean).toEqual({ associationId, state: 'suppressed', pending: 'unknown' });
  expect(JSON.stringify(publicAggregateProjection(clean!))).not.toMatch(
    /supportCount|opposeCount|falsePositiveCount|supportFraction|denominator/,
  );
  const published = admitClassificationAggregate(
    {
      associationId,
      state: 'published',
      pending: 'unknown',
      supportCount: 6,
      opposeCount: 4,
      falsePositiveCount: 2,
      supportFraction: 0.6,
      asOf: '2026-11-03T00:00:00.000Z',
      generation: '8',
    },
    associationId,
  );
  expect(published).toMatchObject({ state: 'published', supportFraction: 0.6, falsePositiveCount: 2 });
  const store: Store = {
    own: {
      associationId,
      hasBallot: true,
      assessment: 'support',
      falsePositive: false,
      revision: '1',
      pending: false,
    },
    aggregate: published,
    statistics: [
      {
        source: 'vndb',
        sourceRecordId: 'v4',
        scale: { min: 1, max: 10 },
        mean: 8.4,
        count: 10,
        asOf: '2026-01-01',
      },
    ],
    writes: [],
    calls: 0,
  };
  const html = renderToStaticMarkup(
    createElement(ClassificationAssessmentView, {
      snapshot: {
        ...emptyClassificationSnapshot('signed-in', identity, 'reader-1'),
        own: { kind: 'acknowledged', value: store.own },
        aggregate: { kind: 'ready', value: published! },
      },
      associations: disclosed,
      locale: 'en',
      title: 'Work',
      returnTo: '/en/subjects/work',
      csrfToken: 'csrf',
      statistics: store.statistics,
      sourcesHref: '/en/subjects/work/sources',
      onSelect: () => {},
      onCommand: () => {},
      onRetry: () => {},
    }),
  );
  expect(html).toContain('Published community assessment');
  expect(html).toContain('false positive');
  expect(html).not.toContain('How much did you like');
  const ratings = renderToStaticMarkup(
    createElement(RatingsView, {
      data: await readRatings(client(store), subjectId),
      id: 'ratings',
      subject: subjectId,
      locale: 'en',
    }),
  );
  expect(ratings).toContain('8.4');
  expect(ratings).not.toContain('classification-assessment-editor');
});

test('independent provider rows keep distinct scale, asOf and hidden siblings', async () => {
  const bangumi: Statistic = {
    source: 'bangumi',
    sourceRecordId: '12',
    sourceAlias: 'bangumi',
    scale: { min: 0, max: 10 },
    mean: 0,
    count: 4,
    asOf: '2026-02-02',
    observation: { kind: 'unversioned', digest },
    licence: 'CC-BY-SA-4.0',
    attribution: 'Bangumi',
  };
  const vndb: Statistic = {
    source: 'vndb',
    sourceRecordId: 'v4',
    scale: { min: 1, max: 10 },
    mean: 8.4,
    count: 10,
    asOf: '2026-01-01',
    licence: 'ODbL-1.0',
    attribution: 'VNDB',
  };
  const both = await readRatings(
    client({
      own: {
        associationId,
        hasBallot: false,
        assessment: null,
        falsePositive: false,
        revision: null,
        pending: false,
      },
      aggregate: { associationId, state: 'suppressed', pending: 'unknown' },
      statistics: [vndb, bangumi],
      writes: [],
      calls: 0,
    }),
    subjectId,
  );
  expect(both.statistics.kind).toBe('ready');
  if (both.statistics.kind !== 'ready') return;
  expect(both.statistics.value.map((item) => item.source)).toEqual(['vndb', 'bangumi']);
  expect(both.statistics.value[1]).toMatchObject({ mean: 0, asOf: '2026-02-02', observation: { kind: 'unversioned' } });
  const hidden = await readRatings(
    client({
      own: {
        associationId,
        hasBallot: false,
        assessment: null,
        falsePositive: false,
        revision: null,
        pending: false,
      },
      aggregate: { associationId, state: 'suppressed', pending: 'unknown' },
      statistics: [bangumi],
      writes: [],
      calls: 0,
    }),
    subjectId,
  );
  expect(hidden.statistics.kind === 'ready' && hidden.statistics.value.map((item) => item.source)).toEqual(['bangumi']);
  const html = renderToStaticMarkup(
    createElement(RatingsView, { data: both, id: 'ratings', subject: subjectId, locale: 'en' }),
  );
  expect(html).toContain(providerStatisticLabel('bangumi'));
  expect(html).toContain('VNDB');
  expect(html).toContain('0–10');
  expect(html).toContain('12');
  expect(html).not.toContain('https://');
});

test('missing producer and realm-local associations stay unavailable', () => {
  const fake = { subjects: () => ({}) } as never;
  expect(classificationBallotHandle(fake, subjectId, associationId)).toBeNull();
  expect(
    bindDisclosedClassificationAssociation({
      subjectId,
      contextId: '00000000-0000-8000-8000-000000000099',
      statement: {
        id: associationId,
        property: { id: 'schema:keywords', data_type: 'wikibase-item' },
        value: { type: 'value', content: targetId },
      },
    }),
  ).toEqual({ kind: 'unavailable', reason: 'realm' });
  expect(
    bindDisclosedClassificationAssociation({
      subjectId,
      contextId: PAGE_GLOBAL_CONTEXT,
      statement: {
        id: associationId,
        property: { id: 'schema:keywords', data_type: 'wikibase-item' },
        value: { type: 'value', content: targetId },
      },
      related: { [targetId]: { redirect: '00000000-0000-8000-8000-000000000013' } },
    }),
  ).toEqual({ kind: 'unavailable', reason: 'redirect' });
});

test('growth at 20, 200 and 2,000 eligible ballots keeps Web work bounded to one association', async () => {
  const costs = [];
  for (const eligible of [20, 200, 2000]) {
    const published = {
      associationId,
      state: 'published' as const,
      pending: 'unknown' as const,
      supportCount: eligible - 5,
      opposeCount: 5,
      falsePositiveCount: 2,
      supportFraction: (eligible - 5) / eligible,
      asOf: '2026-11-03T00:00:00.000Z',
      generation: String(eligible),
    };
    const store: Store = {
      own: {
        associationId,
        hasBallot: true,
        assessment: 'support',
        falsePositive: false,
        revision: '1',
        pending: false,
      },
      aggregate: published,
      statistics: [
        {
          source: 'vndb',
          sourceRecordId: 'v4',
          scale: { min: 1, max: 10 },
          mean: 8.4,
          count: eligible,
          asOf: '2026-01-01',
        },
        {
          source: 'bangumi',
          sourceRecordId: '12',
          scale: { min: 0, max: 10 },
          mean: 7,
          count: eligible,
          asOf: '2026-02-02',
        },
      ],
      writes: [],
      calls: 0,
    };
    const transport = client(store);
    const own = await readClassificationOwnBallot(transport, request(), {}, identity);
    const aggregate = await readClassificationAggregate(transport, identity);
    const sources = await readRatings(transport, subjectId);
    const sourceRows = sources.statistics.kind === 'ready' ? sources.statistics.value.length : 0;
    costs.push(
      measureClassificationVisit({
        association: identity,
        own: own.outcome,
        aggregate: aggregate.outcome,
        sourceRows,
        nativeCalls: store.calls,
      }),
    );
    expect(aggregateLeaksCounts(aggregate.outcome.kind === 'ready' ? aggregate.outcome.value : {})).toBe(false);
    expect(store.writes.filter((item) => item.path.includes('/assessment') || item.path.includes('/aggregate'))).toHaveLength(
      2,
    );
  }
  expect(new Set(costs.map((item) => item.nativeCalls)).size).toBe(1);
  expect(costs.every((item) => item.valuesProcessed === costs[0]!.valuesProcessed)).toBe(true);
  expect(Math.max(...costs.map((item) => item.bytesRetained)) - Math.min(...costs.map((item) => item.bytesRetained))).toBeLessThan(
    64,
  );
  expect(costs[0]!.nativeCalls).toBeLessThanOrEqual(7);
  expect(costs[0]!.valuesProcessed).toBe(5);
});
