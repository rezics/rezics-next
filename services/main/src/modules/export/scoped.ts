import { t } from 'elysia';
import { readId } from '../work/read-contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable } from '../work/read-session.ts';
import { resolveVisibleTargets, type TargetReadSession } from '../target/resolve.ts';
import { coordinateOf, type Coordinate } from '../projection/dimension.ts';
import type { queryTargetRatingAggregate } from '../rating/target-aggregate.ts';
import type { queryRatingRollup } from '../rating/rollup-read.ts';

export const SCOPED_EXPORT_COST = {
  frames: 8,
  revisionQueries: 1,
  revisionRows: 9,
  rollupMembers: 200,
} as const;
export const scopedSelectionSchemas = (position: ReturnType<typeof t.Object>) => [
  t.Object(
    {
      kind: t.Literal('projection-revision'),
      reference: readId,
      resource: readId,
      expectedPosition: position,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      kind: t.Literal('rating-aggregate'),
      reference: readId,
      target: readId,
      expectedPosition: position,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      kind: t.Literal('rating-rollup'),
      reference: readId,
      targets: t.Array(readId, {
        minItems: 1,
        maxItems: SCOPED_EXPORT_COST.rollupMembers,
        uniqueItems: true,
      }),
      formula: t.Union([t.Literal('pooled'), t.Literal('mean-of-means')]),
      expectedPosition: position,
    },
    { additionalProperties: false },
  ),
];

/** Fixed vocabulary context only; no runtime expansion or negotiation is needed. */
export const scopedContext = {
  '@vocab': 'https://rezics.com/vocab/',
  prov: 'http://www.w3.org/ns/prov#',
  dqv: 'http://www.w3.org/ns/dqv#',
  rv: 'https://rezics.com/vocab/',
  oa: 'http://www.w3.org/ns/oa#',
  id: '@id',
  type: '@type',
} as const;
const ref = (id: string) => ({ id });
export function projectionResource(id: string, subject: string, frames: readonly Coordinate[], revision?: string) {
  return {
    '@context': scopedContext,
    id,
    type: 'prov:Entity',
    'prov:specializationOf': ref(subject),
    ...(revision ? { 'rv:projectionRevision': ref(revision) } : {}),
    'rv:frame': frames.map((frame) => ({
      'rv:coordinate': ref(frame.iri),
      'rv:dimension': frame.dimension,
    })),
  };
}

/** Resolve disclosure for every part, then read only the retained projection revision.
 * Current triples cannot supply the meaning of a requested historical revision. */
export async function readProjectionResource(
  session: TargetReadSession,
  resource: string,
  revision?: string,
) {
  const [projection] = await resolveVisibleTargets(session, [resource], 'report');
  if (!projection || projection.base !== 'projection')
    throw new WorkReadMissing('Projection unavailable');
  const exact = revision ?? projection.revision;
  const rows = await session.query(
    `SELECT ?subject ?frame ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(exact)} a rv:ProjectionRevision ; rv:component ${iri(resource)} ;
      rv:projectionOf ?subject ; rv:frame ?frame ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(exact)} a rv:ErasedRevision } }
  } LIMIT ${SCOPED_EXPORT_COST.revisionRows}`,
    SCOPED_EXPORT_COST.revisionRows,
  );
  if (!rows.length) throw new WorkReadMissing('Projection revision unavailable');
  const first = rows[0];
  if (
    !first?.subject ||
    !first.epoch ||
    !first.sequence ||
    !rows.length ||
    rows.length > SCOPED_EXPORT_COST.frames ||
    rows.some(
      (row) =>
        !row.frame ||
        row.subject?.value !== first.subject!.value ||
        row.epoch?.value !== first.epoch!.value ||
        row.sequence?.value !== first.sequence!.value,
    )
  ) {
    throw new WorkReadUnavailable('Exact projection revision unavailable');
  }
  const references = rows.map((row) => row.frame!.value).sort();
  const parts = await resolveVisibleTargets(
    session,
    [first.subject.value, ...references],
    'report',
  );
  if (parts.length !== references.length + 1)
    throw new WorkReadMissing('Projection parts unavailable');
  const frames = references.map((reference) =>
    coordinateOf(parts.find((part) => part.resource === reference)!),
  );
  if (
    frames.some((frame) => !frame) ||
    new Set(frames.map((frame) => frame!.dimension)).size !== frames.length
  ) {
    throw new WorkReadUnavailable('Projection frame dimensions unavailable');
  }
  return {
    resource,
    revision: exact,
    subject: first.subject.value,
    sourcePosition: { dataEpoch: first.epoch.value, sequence: first.sequence.value },
    representation: projectionResource(resource, first.subject.value, frames as Coordinate[], exact),
  };
}

type Aggregate = Awaited<ReturnType<typeof queryTargetRatingAggregate>>;
type Rollup = Awaited<ReturnType<typeof queryRatingRollup>>;
const metric = (context: string, question: string, language: string, scale: unknown) => ({
  id: `${context}#question`,
  type: 'dqv:Metric',
  'rv:ratingContext': ref(context),
  'rv:question': { '@value': question, '@language': language },
  'rv:scale': scale,
});
export function aggregateMeasurement(aggregate: Aggregate) {
  return {
    '@context': scopedContext,
    type: 'dqv:QualityMeasurement',
    'dqv:computedOn': ref(aggregate.target),
    'dqv:isMeasurementOf': metric(
      aggregate.context,
      aggregate.scope.question,
      aggregate.scope.language,
      aggregate.scale,
    ),
    'rv:origin': 'native',
    'rv:population': aggregate.populationPolicy,
    'rv:cadence': aggregate.cadence,
    'rv:aggregationPolicy': aggregate.aggregationPolicy,
    'rv:count': aggregate.count,
    'rv:sum': aggregate.sum,
    'rv:histogram': { '@list': aggregate.histogram },
    'rv:displayThreshold': aggregate.displayThreshold,
    'rv:meanDisplay': aggregate.meanDisplay,
    ...(aggregate.meanDisplay === 'shown' && aggregate.mean !== null
      ? { 'dqv:value': aggregate.mean }
      : {}),
  };
}
export function rollupMeasurement(rollup: Rollup) {
  return {
    '@context': scopedContext,
    type: 'dqv:QualityMeasurement',
    'dqv:computedOn': rollup.members.map((member) => ref(member.target)),
    'dqv:isMeasurementOf': {
      ...metric(rollup.context, rollup.scope.question, rollup.scope.language, rollup.scale),
      id: `${rollup.context}#rollup-${rollup.formula}`,
      'prov:wasDerivedFrom': ref(`${rollup.context}#question`),
    },
    'rv:origin': 'derived',
    'rv:formula': rollup.formula,
    'rv:coverage': rollup.coverage,
    'rv:displayThreshold': rollup.displayThreshold,
    'rv:memberCount': rollup.memberCount,
    'rv:members': rollup.members.map((member) =>
      member.status === 'available'
        ? {
            target: ref(member.target),
            status: member.status,
            ...member.components,
            histogram: { '@list': member.components.histogram },
            meanDisplay: member.meanDisplay,
            ...(member.meanDisplay === 'shown' ? { mean: member.mean } : {}),
          }
        : { target: ref(member.target), status: member.status, reason: member.reason },
    ),
    'rv:valueWithheld': rollup.valueWithheld,
    ...(rollup.valueWithheld === null && rollup.value !== null
      ? { 'dqv:value': rollup.value }
      : {}),
  };
}

export function ratingAnnotation(input: {
  observation: string;
  revision: string;
  target: string | Record<string, unknown>;
  context: string;
  question: string;
  language: string;
  value: number;
  scale: { min: number; max: number; step: number };
}) {
  return {
    '@context': scopedContext,
    id: input.revision,
    type: 'oa:Annotation',
    'oa:motivatedBy': ref('http://www.w3.org/ns/oa#assessing'),
    'oa:hasTarget': typeof input.target === 'string' ? ref(input.target) : input.target,
    'prov:wasRevisionOf': ref(input.observation),
    'oa:hasBody': {
      type: 'rv:RatingValue',
      'rv:value': input.value,
      'rv:scale': input.scale,
      'rv:question': { '@value': input.question, '@language': input.language },
      'rv:ratingContext': ref(input.context),
      'rv:origin': 'native',
    },
  };
}
