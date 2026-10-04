import { expect, test } from 'bun:test';
import {
  projectionResource,
  aggregateMeasurement,
  rollupMeasurement,
  ratingAnnotation,
} from '../src/modules/export/scoped.ts';
import type { queryTargetRatingAggregate } from '../src/modules/rating/target-aggregate.ts';
import type { queryRatingRollup } from '../src/modules/rating/rollup-read.ts';

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
    memberCount: 2,
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
