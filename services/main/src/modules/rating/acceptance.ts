import { typeFrameDimensions } from '../../../../../packages/model/src/generated/types.ts';
import { dimensionOf, type FrameDimension } from '../projection/dimension.ts';
import { MAX_FRAMES } from '../projection/schema.ts';
import { MAX_TARGET_TYPES, type ResolvedTarget } from '../target/contract.ts';
import { resolveTargets, type TargetReadSession } from '../target/resolve.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';

export const ACCEPTED_FRAME_DIMENSIONS = [
  'work',
  'realization',
  'release',
  'position',
  ...typeFrameDimensions,
] as const;
export const CONTEXT_ACCEPTANCE_COST = {
  subjectTypes: 32,
  frameDimensions: 8,
  projectionParts: MAX_FRAMES + 1,
  policyRows: 40,
  projectionQueries: 1,
  partResolveBatches: 1,
} as const;
export interface ContextAcceptance {
  acceptedSubjectTypes?: readonly string[];
  acceptedFrameDimensions?: readonly FrameDimension[];
}
export interface AcceptanceTarget {
  types: readonly string[];
  dimensions: readonly FrameDimension[];
  subject?: string;
  frames?: readonly ResolvedTarget[];
}

export class RatingTargetNotAccepted extends Error {
  readonly status = 422;
  readonly code = 'rating_target_not_accepted';
  constructor() {
    super('The RatingContext does not accept this subject type or frame dimension');
  }
}

/** Types combine with OR. Every frame dimension must be permitted. No type
 * inference or subject roll-up: a projection uses its subject's recorded types. */
export function contextAccepts(policy: ContextAcceptance, target: AcceptanceTarget): boolean {
  return (
    (!policy.acceptedSubjectTypes ||
      policy.acceptedSubjectTypes.some((type) => target.types.includes(type))) &&
    (!policy.acceptedFrameDimensions ||
      target.dimensions.every((dimension) => policy.acceptedFrameDimensions!.includes(dimension)))
  );
}

export async function ratingAcceptanceTarget(
  session: TargetReadSession,
  target: ResolvedTarget,
): Promise<AcceptanceTarget> {
  if (target.base !== 'projection') return { types: target.types, dimensions: [] };
  const bound = MAX_FRAMES + MAX_TARGET_TYPES;
  const rows = await session.query(
    `SELECT ?subject ?frame ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(target.resource)} a rv:Projection ; rv:projectionOf ?subject ; rv:projectionHead ${iri(target.revision)} .
    { ${iri(target.resource)} rv:frame ?frame } UNION { ?subject a ?type }
  } } LIMIT ${bound + 1}`,
    bound,
  );
  const subjects = new Set(rows.map((row) => row.subject?.value));
  const frameIds = rows.flatMap((row) => (row.frame ? [row.frame.value] : []));
  const types = rows.flatMap((row) => (row.type ? [row.type.value] : []));
  if (
    !rows.length ||
    subjects.size !== 1 ||
    !rows[0]?.subject ||
    !frameIds.length ||
    frameIds.length > MAX_FRAMES ||
    !types.length ||
    types.length > MAX_TARGET_TYPES ||
    new Set(frameIds).size !== frameIds.length
  ) {
    throw new WorkReadUnavailable('Projection coordinates are unavailable');
  }
  // The projection summary has already disclosed its subject. Subjects need
  // recorded types, not an independent rating grain (an Agent may be a subject).
  const frames = await resolveTargets(session, frameIds, 'rating');
  const dimensions = frames.map(dimensionOf);
  if (
    types.includes('https://rezics.com/vocab/Projection') ||
    dimensions.some((dimension) => dimension === null) ||
    new Set(dimensions).size !== dimensions.length
  )
    throw new WorkReadUnavailable('Projection dimensions are unavailable');
  return {
    types,
    dimensions: dimensions as FrameDimension[],
    subject: rows[0].subject.value,
    frames,
  };
}

/** Separate UNION arms avoid a type × dimension Cartesian product. */
export async function readContextAcceptance(
  session: Pick<TargetReadSession, 'query'>,
  context: string,
): Promise<ContextAcceptance> {
  const rows = await session.query(
    `SELECT ?type ?dimension WHERE { GRAPH ${iri(GRAPHS.current)} {
    { ${iri(context)} rv:acceptedSubjectType ?type }
    UNION { ${iri(context)} rv:acceptedFrameDimension ?dimension }
  } } LIMIT ${CONTEXT_ACCEPTANCE_COST.policyRows + 1}`,
    CONTEXT_ACCEPTANCE_COST.policyRows,
  );
  const types = rows.flatMap((row) => (row.type ? [row.type.value] : [])).sort();
  const dimensions = rows.flatMap((row) => (row.dimension ? [row.dimension.value] : [])).sort();
  if (
    types.length > CONTEXT_ACCEPTANCE_COST.subjectTypes ||
    dimensions.length > CONTEXT_ACCEPTANCE_COST.frameDimensions ||
    types.some((type) => !validSubjectType(type)) ||
    dimensions.some(
      (dimension) => !(ACCEPTED_FRAME_DIMENSIONS as readonly string[]).includes(dimension),
    )
  ) {
    throw new WorkReadUnavailable('Context acceptance is unavailable');
  }
  return {
    ...(types.length ? { acceptedSubjectTypes: types } : {}),
    ...(dimensions.length ? { acceptedFrameDimensions: dimensions as FrameDimension[] } : {}),
  };
}

export function validSubjectType(type: string): boolean {
  return type.length <= 512 && /^https?:\/\/[^\s<>"{}|^`\\]+$/.test(type);
}
/** Subject types are vocabulary IRIs, not the native Resource addresses that
 * work/activate's narrower IRI formatter accepts. */
export function subjectTypeTerm(type: string): string {
  if (!validSubjectType(type)) throw new WorkReadUnavailable('Subject type IRI is invalid');
  return `<${type}>`;
}

/** Filter before P+1 selection, so rejected questions never consume a page. */
export function contextAcceptanceFilter(context: string, target: AcceptanceTarget): string {
  return `FILTER(NOT EXISTS { ${context} rv:acceptedSubjectType ?acceptedType }
    || EXISTS { ${context} rv:acceptedSubjectType ?matchedType .
      VALUES ?matchedType { ${target.types.map(subjectTypeTerm).join(' ')} } })
    ${target.dimensions
      .map(
        (
          dimension,
        ) => `FILTER(NOT EXISTS { ${context} rv:acceptedFrameDimension ?acceptedDimension }
      || EXISTS { ${context} rv:acceptedFrameDimension ${lit(dimension)} })`,
      )
      .join('\n')}`;
}

export async function assertRatingTargetAccepted(
  session: TargetReadSession,
  context: string,
  target: ResolvedTarget,
) {
  const policy = await readContextAcceptance(session, context);
  // Older questions have no acceptance declaration and pay no coordinate lookup.
  if (!policy.acceptedSubjectTypes && !policy.acceptedFrameDimensions) return;
  const resolved = await ratingAcceptanceTarget(session, target);
  if (!contextAccepts(policy, resolved)) throw new RatingTargetNotAccepted();
  return resolved;
}
