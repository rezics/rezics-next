import { t } from 'elysia';
import { sourcePosition } from '../../api-contract.ts';
import { GLOBAL_AGGREGATE_PROFILE } from './global-aggregate.ts';
import { GLOBAL_CONTEXT_ID, GLOBAL_OBSERVATION_ID, GLOBAL_RATING_POPULATION_OWNER } from './global.ts';
import { REALM_GLOBAL_SYNTHESIS_PROFILE } from './synthesis.ts';

const target = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const integerText = t.String({ pattern: '^(0|[1-9][0-9]*)$', maxLength: 128 });
const positiveText = t.String({ pattern: '^[1-9][0-9]*$', maxLength: 128 });
const fraction = t.Object({ numerator: integerText, denominator: positiveText });
const count = t.Integer({ minimum: 0, maximum: 100 });
const replay = { sourcePosition, replayed: t.Boolean() };
const globalScale = t.Object({ min: t.Literal(1), max: t.Literal(5), step: t.Literal(1) });
const owner = t.Literal(GLOBAL_RATING_POPULATION_OWNER);

export const globalContextInput = t.Object({
  profile: t.Literal(GLOBAL_CONTEXT_ID), question: t.String({ minLength: 3, maxLength: 120 }),
  actingSubject: target,
}, { additionalProperties: false });

const globalContext = {
  context: target, populationOwner: owner, question: t.String(), contextRevision: target,
  targetGrain: t.Literal('mainVersion'), scale: globalScale, cadence: t.Literal('standing'),
  population: t.Literal('global-account-principal'), aggregation: t.Literal('latest-per-rater-mean'),
  profile: t.Literal(GLOBAL_CONTEXT_ID),
};
export const globalContextRead = t.Object(globalContext);
export const globalContextWrite = t.Object({ ...globalContext, ...replay });

export const globalObservationInput = t.Object({
  profile: t.Literal(GLOBAL_OBSERVATION_ID), context: target, work: target, mainVersion: target,
  expectedRevisionHead: t.Nullable(target), value: t.Nullable(t.Integer({ minimum: 1, maximum: 5 })),
  actingSubject: target,
}, { additionalProperties: false });

export const globalObservationWrite = t.Object({
  observation: target, observationRevision: target, predecessor: t.Nullable(target),
  context: target, work: target, mainVersion: target, value: t.Nullable(t.Integer({ minimum: 1, maximum: 5 })),
  availability: t.Union([t.Literal('available'), t.Literal('withdrawn')]),
  profile: t.Literal(GLOBAL_OBSERVATION_ID), ...replay,
});

const component = (kind: 'realm' | 'global') => ({
  context: target, populationOwner: kind === 'global' ? owner : target, contextRevision: target,
  contextProfile: t.Literal(kind === 'global' ? GLOBAL_CONTEXT_ID : 'realm-standing-rating-context-v1'),
  populationPolicy: t.Literal(kind === 'global' ? 'global-account-principal' : 'account-principal'),
  cadence: t.Literal('standing'), aggregationPolicy: t.Literal('latest-per-rater-mean'),
  scale: kind === 'global' ? globalScale : t.Object({ min: t.Literal(1), max: t.Literal(10), step: t.Literal(1) }),
  population: count, count, withdrawnCount: count,
  histogram: t.Array(count, { minItems: kind === 'global' ? 5 : 10, maxItems: kind === 'global' ? 5 : 10 }),
  sum: t.Integer({ minimum: 0, maximum: 1000 }), mean: t.Nullable(t.Number()),
  precision: t.Union([t.Object({ kind: t.Literal('no-data') }),
    t.Object({ kind: t.Literal('exact-rational'), numerator: integerText, denominator: positiveText })]),
  unitMean: t.Nullable(fraction),
});

export const globalAggregateInput = t.Object({
  profile: t.Literal(GLOBAL_AGGREGATE_PROFILE), context: target, work: target, mainVersion: target,
}, { additionalProperties: false });

export const globalAggregateResult = t.Object({
  profile: t.Literal(GLOBAL_AGGREGATE_PROFILE), complete: t.Literal(true), work: target, mainVersion: target,
  targetGrain: t.Literal('mainVersion'), ...component('global'), sourcePosition,
});

export const synthesisInput = t.Object({
  profile: t.Literal(REALM_GLOBAL_SYNTHESIS_PROFILE), realmContext: target, globalContext: target,
  work: target, mainVersion: target,
}, { additionalProperties: false });

export const synthesisResult = t.Object({
  profile: t.Literal(REALM_GLOBAL_SYNTHESIS_PROFILE), work: target, mainVersion: target,
  targetGrain: t.Literal('mainVersion'),
  policy: t.Object({ normalization: t.Literal('scale-min-max-unit-interval'),
    weighting: t.Literal('equal-context'), raterPooling: t.Literal('none') }),
  status: t.Union([t.Literal('complete'), t.Literal('partial')]),
  missing: t.Array(t.Union([t.Literal('realm'), t.Literal('global')]), { maxItems: 2 }),
  value: t.Nullable(fraction), numericValue: t.Nullable(t.Number()),
  components: t.Object({ realm: t.Object(component('realm')), global: t.Object(component('global')) }),
  sourcePosition,
});
