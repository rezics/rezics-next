import { expect, test } from 'bun:test';
import {
  projectionResource,
  aggregateMeasurement,
  rollupMeasurement,
  ratingAnnotation,
  readProjectionResource,
  readPersonalProjectionResources,
} from '../src/modules/export/scoped.ts';
import type { queryTargetRatingAggregate } from '../src/modules/rating/target-aggregate.ts';
import type { queryRatingRollup } from '../src/modules/rating/rollup-read.ts';
import { canonicalExport } from '../src/modules/export/planner.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { derivedId } from '../src/modules/structure/graph.ts';
import { resolveTargets, resolveVisibleTargets } from '../src/modules/target/resolve.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

/** Real summary, capability admission and export readers; the retained
 * projection still frames its source Work after that Work is merged. */
function mergedProjectionFixture(currentUsesSurvivor = false) {
  const id = (name: string) => derivedId(`projection-export-merge:${name}`);
  const source = id('source'), survivor = id('survivor'), subject = id('subject'), projection = id('projection');
  const revision = (resource: string) => id(`revision:${resource}`), retained = id('retained-revision');
  const value = (text: string) => ({ type: 'literal' as const, value: text });
  const uri = (text: string) => ({ type: 'uri' as const, value: text });
  const currentFrame = currentUsesSurvivor ? survivor : source;
  const position = { epoch: value('epoch'), sequence: value('1') };
  const graph = new FusekiClient('http://graph.invalid');
  type Row = NonNullable<SparqlResult['results']>['bindings'][number];
  const resourcesIn = (query: string) => [...new Set([...query.matchAll(/VALUES \?r \{([^}]+)\}/g)]
    .flatMap(match => [...match[1]!.matchAll(/<([^>]+)>/g)].map(reference => reference[1]!)))];
  graph.query = async query => {
    const resources = resourcesIn(query);
    if (query.includes('SELECT ?epoch ?sequence ?hold')) {
      const bindings = resources.flatMap((resource): Row[] => {
        if (resource === projection) return [{ ...position, r: uri(resource), type: value('projection'),
          public: value('false'), erased: value('false'), projectionSubject: uri(subject), projectionFrame: uri(currentFrame) }];
        if (![source, survivor, subject].includes(resource)) return [];
        return [{ ...position, r: uri(resource), type: value('work'), work: uri(resource), head: uri(revision(resource)),
          public: value('true'), erased: value('false'), label: { ...value(resource), 'xml:lang': 'en' } }];
      });
      return { results: { bindings: bindings.length ? bindings : [position] } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision ?type')) return { results: { bindings: resources.map(resource => ({
      ...position, r: uri(resource), revision: uri(revision(resource)),
      type: uri(resource === projection ? 'https://rezics.com/vocab/Projection' : 'https://schema.org/CreativeWork'),
      ...(resource === source ? { mergedInto: uri(survivor) } : {}),
    })) } };
    if (query.includes('SELECT ?resource ?revision ?subject ?frame')) return { results: { bindings: [{
      ...position, resource: uri(projection), revision: uri(revision(projection)), subject: uri(subject), frame: uri(currentFrame),
    }] } };
    if (query.includes('SELECT ?subject ?frame ?epoch ?sequence')) {
      expect(query).toContain(`<${retained}> a rv:ProjectionRevision`);
      return { results: { bindings: [{ ...position, subject: uri(subject), frame: uri(source) }] } };
    }
    throw new Error(`Unexpected projection export query: ${query}`);
  };
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/projection-export-merge',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: {}, account: {} } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/exports'), {},
    { dataEpoch: 'epoch', sequence: '1' });
  return { session, source, survivor, subject, projection, revision, retained };
}

test('inventory admission preserves requested fields while explicit resolution returns the readable merge survivor', async () => {
  const f = mergedProjectionFixture();
  expect((await resolveTargets(f.session, [f.source], 'report'))[0]!.resource).toBe(f.survivor);
  const requested = { resource: f.source, base: 'work' as const, work: f.source, revision: f.revision(f.source),
    types: ['https://schema.org/CreativeWork'], disclosure: 'public' as const };
  expect(await resolveVisibleTargets(f.session, [f.source, f.source], 'report')).toEqual([requested, requested]);
});

test('retained projection export keeps a frame naming the requested Work after its readable merge', async () => {
  const f = mergedProjectionFixture(true);
  const result = await readProjectionResource(f.session, f.projection, f.retained);
  expect(result.representation).toMatchObject({
    id: f.projection, 'rv:projectionRevision': { id: f.retained }, 'prov:specializationOf': { id: f.subject },
    'rv:frame': [{ 'rv:coordinate': { id: f.source }, 'rv:dimension': 'work' }],
  });
  expect(canonicalExport(result.representation)).not.toContain(f.survivor);
});

test('personal projection export retains projections whose parts name a Work merged into a readable survivor', async () => {
  const f = mergedProjectionFixture();
  const result = await readPersonalProjectionResources(f.session, [f.projection]);
  expect([...result.keys()]).toEqual([f.projection]);
  expect(result.get(f.projection)).toMatchObject({
    id: f.projection, 'rv:projectionRevision': { id: f.revision(f.projection) },
    'prov:specializationOf': { id: f.subject },
    'rv:frame': [{ 'rv:coordinate': { id: f.source }, 'rv:dimension': 'work' }],
  });
});

type Aggregate = Awaited<ReturnType<typeof queryTargetRatingAggregate>>;
const aggregate: Aggregate = {
  profile: 'realm-target-latest-mean-v1',
  complete: true,
  context: 'https://example.org/context',
  contextRevision: 'https://example.org/context-revision',
  lastAdmissionId: 'ad000000-0000-4000-8000-000000000000',
  realm: 'https://example.org/realm',
  target: 'https://example.org/projection',
  targetGrain: 'projection',
  scope: {
    question: 'How did she do?',
    language: 'en',
    grain: 'projection',
    population: 'account-principal',
    countedTarget: 'https://example.org/projection',
  },
  scale: { min: 1, max: 10, step: 1 },
  cadence: 'standing',
  populationPolicy: 'account-principal',
  aggregationPolicy: 'latest-per-rater-mean',
  population: 1,
  count: 1,
  withdrawnCount: 0,
  histogram: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
  sum: 8,
  displayThreshold: 10,
  mean: null,
  meanDisplay: 'withheld-below-threshold',
  precision: { kind: 'withheld-below-threshold' },
  sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
};

test('projection maps its subject and typed coordinates without becoming its subject', () => {
  expect(
    projectionResource('projection', 'subject', [
      { iri: 'episode', dimension: 'position' },
      { iri: 'canon', dimension: 'continuity' },
    ]),
  ).toMatchObject({
    id: 'projection',
    'prov:specializationOf': { id: 'subject' },
    'rv:frame': [
      { 'rv:coordinate': { id: 'episode' }, 'rv:dimension': 'position' },
      { 'rv:coordinate': { id: 'canon' }, 'rv:dimension': 'continuity' },
    ],
  });
});

test('DQV retains context meaning and additive components but never a withheld mean', () => {
  const mapped = aggregateMeasurement({ ...aggregate, mean: 8 }); // Defensive even against an inconsistent upstream field.
  expect(mapped).toMatchObject({
    type: 'dqv:QualityMeasurement',
    'dqv:computedOn': { id: aggregate.target },
    'dqv:isMeasurementOf': {
      id: `${aggregate.context}#question`,
      type: 'dqv:Metric',
      'rv:question': { '@value': aggregate.scope.question, '@language': 'en' },
    },
    'rv:count': 1,
    'rv:displayThreshold': 10,
    'rv:histogram': { '@list': aggregate.histogram },
    'rv:origin': 'native',
  });
  expect(mapped).not.toHaveProperty('dqv:value');
  expect(aggregateMeasurement({ ...aggregate, meanDisplay: 'shown', mean: 8 })['dqv:value']).toBe(
    8,
  );
  expect(aggregateMeasurement({ ...aggregate, meanDisplay: 'no-data' })).not.toHaveProperty(
    'dqv:value',
  );
});

test('each aggregate measurement IRI pins its Context, target and sealed admission evidence', () => {
  const mapped = aggregateMeasurement(aggregate);
  expect(mapped.id).toMatch(/^urn:rezics:quality-measurement:[a-f0-9]{64}$/);
  expect(mapped.id).toBe(aggregateMeasurement({ ...aggregate }).id);
  for (const changed of [
    { ...aggregate, target: 'https://example.org/another-target' },
    { ...aggregate, contextRevision: 'https://example.org/another-context-revision' },
    { ...aggregate, lastAdmissionId: 'ad000000-0000-4000-8000-000000000001' },
  ])
    expect(mapped.id).not.toBe(aggregateMeasurement(changed).id);
});

test('derived rollups retain unavailable members and coverage without leaking member means', () => {
  const rollup: Awaited<ReturnType<typeof queryRatingRollup>> = {
    profile: 'rating-rollup-v1',
    context: aggregate.context,
    realm: aggregate.realm,
    scope: aggregate.scope,
    scale: aggregate.scale,
    formula: 'mean-of-means',
    contextRevision: aggregate.contextRevision,
    displayThreshold: 10,
    memberCount: 3,
    coverage: { members: 2, available: 1, meetingThreshold: 0 },
    value: null,
    valueWithheld: 'coverage-below-half',
    members: [
      {
        target: aggregate.target,
        status: 'available',
        lastAdmissionId: aggregate.lastAdmissionId,
        components: {
          population: 1,
          count: 1,
          withdrawnCount: 0,
          sum: 8,
          histogram: aggregate.histogram,
        },
        mean: 8,
        meanDisplay: 'withheld-below-threshold',
        meetsThreshold: false,
      },
      { target: 'hidden', status: 'unavailable', reason: 'unavailable' },
      { target: 'outside-question', status: 'not-accepted' },
    ],
    rank: null,
    sourcePosition: aggregate.sourcePosition,
  };
  const mapped = rollupMeasurement(rollup);
  expect(mapped).toMatchObject({
    'rv:origin': 'derived',
    'rv:formula': 'mean-of-means',
    'rv:coverage': rollup.coverage,
  });
  expect(mapped).not.toHaveProperty('dqv:value');
  expect(mapped['rv:members'][0]).not.toHaveProperty('mean');
  expect(mapped['rv:members'][1]).toMatchObject({ status: 'unavailable', reason: 'unavailable' });
  expect(mapped['rv:members'][2]).toEqual({
    target: { id: 'outside-question' },
    status: 'not-accepted',
  });
  expect(() => canonicalExport(mapped)).not.toThrow();
  expect(mapped['dqv:computedOn']).toEqual([]);
  expect(rollupMeasurement({ ...rollup, formula: 'pooled' })['dqv:computedOn']).toEqual([
    { id: aggregate.target },
  ]);
  const aboveThreshold = {
    ...rollup,
    members: rollup.members.map((member) =>
      member.status === 'available' ? { ...member, meetsThreshold: true } : member,
    ),
  };
  expect(rollupMeasurement(aboveThreshold)['dqv:computedOn']).toEqual([{ id: aggregate.target }]);
  expect(mapped.id).not.toBe(aggregateMeasurement(aggregate).id);
  expect(mapped.id).not.toBe(rollupMeasurement({ ...rollup, formula: 'pooled' }).id);
});

test('own ratings use assessing annotations and carry value, scale and language-tagged question', () => {
  const target = projectionResource(aggregate.target, 'subject', [
    { iri: 'work', dimension: 'work' },
  ]);
  expect(
    ratingAnnotation({
      observation: 'observation',
      revision: 'revision',
      target,
      context: aggregate.context,
      question: aggregate.scope.question,
      language: 'en',
      value: 8,
      scale: aggregate.scale,
    }),
  ).toMatchObject({
    id: 'revision',
    type: 'oa:Annotation',
    'oa:motivatedBy': { id: 'http://www.w3.org/ns/oa#assessing' },
    'oa:hasTarget': target,
    'oa:hasBody': {
      'rv:value': 8,
      'rv:scale': aggregate.scale,
      'rv:question': { '@value': aggregate.scope.question, '@language': 'en' },
    },
  });
});
