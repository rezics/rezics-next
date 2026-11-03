import type { KernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { preparedRatingReader } from './subject-ratings';
import { isRecord } from './shared';

export const CLASSIFICATION_BALLOT_SET = 'classification_ballot:set';
export const CLASSIFICATION_BALLOT_READ_OWN = 'classification_ballot:read-own';
export const CLASSIFICATION_BALLOT_READ_AGGREGATE = 'classification_ballot:read-aggregate';
export const CLASSIFICATION_BALLOT_MINIMUM = 5;
export const CLASSIFICATION_ASSESSMENT_PROVIDERS = ['vndb', 'bangumi'] as const;
export const CONCEPT_TYPE = 'skos:Concept';

export type ClassificationAssessment = 'support' | 'oppose';
export type ClassificationProvider = (typeof CLASSIFICATION_ASSESSMENT_PROVIDERS)[number];
export type ClassificationQualifier = Readonly<{
  property: string;
  valueType: string;
  content: unknown;
}>;

/** Exact immutable association identity. Labels, redirects and a concept alone cannot identify a ballot. */
export type ClassificationAssociationIdentity = Readonly<{
  subjectId: string;
  associationId: string;
  property: string;
  targetId: string;
  contextId: string;
  qualifiersKey: string;
  spoilerLevel: number;
  release?: string;
  revision?: number;
}>;

export type DisclosedClassificationAssociation = ClassificationAssociationIdentity &
  Readonly<{
    propertyLabel: string;
    targetLabel: string;
    inspectHref: string;
    changesHref: string;
  }>;

export type ClassificationAssociationSelection =
  | ClassificationAssociationIdentity
  | { kind: 'unavailable'; reason: 'realm' | 'redirect' | 'not_classification' | 'concealed' };

export type ClassificationOwnState = Readonly<{
  associationId: string;
  hasBallot: boolean;
  assessment: ClassificationAssessment | null;
  falsePositive: boolean;
  revision: string | null;
  pending: boolean;
}>;

export type ClassificationSetResult = Readonly<{
  associationId: string;
  revision: string;
  delivery: 'enqueued' | 'unchanged';
}>;

export type ClassificationAggregate =
  | Readonly<{ associationId: string; state: 'suppressed'; pending: 'unknown' }>
  | Readonly<{
      associationId: string;
      state: 'published';
      pending: 'unknown';
      supportCount: number;
      opposeCount: number;
      falsePositiveCount: number;
      supportFraction: number | null;
      asOf: string;
      generation: string;
    }>;

export type ClassificationOwnOutcome =
  | { kind: 'preparing' }
  | { kind: 'signed-out' }
  | { kind: 'absent'; value: ClassificationOwnState }
  | { kind: 'acknowledged'; value: ClassificationOwnState }
  | { kind: 'pending'; value: ClassificationOwnState }
  | { kind: 'denied' }
  | { kind: 'concealed' }
  | { kind: 'unavailable' }
  | { kind: 'conflict' }
  | { kind: 'stale' };

export type ClassificationAggregateOutcome =
  | { kind: 'preparing' }
  | { kind: 'ready'; value: ClassificationAggregate }
  | { kind: 'denied' }
  | { kind: 'concealed' }
  | { kind: 'unavailable' }
  | { kind: 'stale' };

export type ClassificationAssessmentCost = Readonly<{
  nativeCalls: number;
  valuesProcessed: number;
  bytesRetained: number;
}>;

export type ClassificationVisit = Readonly<{
  subjectId: string;
  association: ClassificationAssociationIdentity | null;
  reader: string | null;
  session: string;
  incarnation: number;
}>;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revisionPattern = /^[1-9][0-9]*$/;
const digestPattern = /^[0-9a-f]{64}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isClassificationUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

export function classificationQualifiersKey(qualifiers: readonly ClassificationQualifier[]): string {
  return JSON.stringify(qualifiers.map((item) => [item.property, item.valueType, item.content]));
}

export function sameClassificationAssociation(
  left: ClassificationAssociationIdentity | null | undefined,
  right: ClassificationAssociationIdentity | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.subjectId === right.subjectId &&
    left.associationId === right.associationId &&
    left.property === right.property &&
    left.targetId === right.targetId &&
    left.contextId === right.contextId &&
    left.qualifiersKey === right.qualifiersKey &&
    left.spoilerLevel === right.spoilerLevel &&
    left.release === right.release &&
    left.revision === right.revision
  );
}

export function classificationAssociationKey(identity: ClassificationAssociationIdentity): string {
  return JSON.stringify([
    identity.subjectId,
    identity.associationId,
    identity.property,
    identity.targetId,
    identity.contextId,
    identity.qualifiersKey,
    identity.spoilerLevel,
    identity.release ?? '',
    identity.revision ?? 0,
  ]);
}

function qualifierFromSnak(value: unknown): ClassificationQualifier | null {
  if (!isRecord(value) || !isRecord(value.property) || !isRecord(value.value)) return null;
  if (typeof value.property.id !== 'string' || !value.property.id || typeof value.value.type !== 'string') return null;
  return {
    property: value.property.id,
    valueType: value.value.type,
    content: value.value.content,
  };
}

function spoilerFromQualifiers(qualifiers: readonly ClassificationQualifier[]): number {
  let level = 0;
  for (const qualifier of qualifiers) {
    if (qualifier.property !== 'rezics:spoilerLevel') continue;
    const amount = isRecord(qualifier.content) ? Number(qualifier.content.amount) : Number.NaN;
    level = Math.max(level, Number.isInteger(amount) ? Math.min(2, Math.max(0, amount)) : 2);
  }
  return level;
}

export function bindDisclosedClassificationAssociation(input: {
  subjectId: string;
  contextId: string;
  statement: {
    id: string;
    rank?: string;
    property: { id: string; data_type: string };
    value: { type: string; content?: unknown };
    qualifiers?: readonly unknown[];
  };
  related?: Record<string, { type?: string; redirect?: string } | undefined>;
  release?: string;
  revision?: number;
}): ClassificationAssociationSelection {
  if (!isClassificationUuid(input.subjectId) || !isClassificationUuid(input.statement.id))
    return { kind: 'unavailable', reason: 'not_classification' };
  if (input.contextId !== PAGE_GLOBAL_CONTEXT) return { kind: 'unavailable', reason: 'realm' };
  if (input.statement.property.data_type !== 'wikibase-item' || input.statement.value.type !== 'value')
    return { kind: 'unavailable', reason: 'not_classification' };
  const targetId = input.statement.value.content;
  if (!isClassificationUuid(targetId)) return { kind: 'unavailable', reason: 'not_classification' };
  const related = input.related?.[targetId];
  if (related?.redirect) return { kind: 'unavailable', reason: 'redirect' };
  if (related && related.type !== CONCEPT_TYPE) return { kind: 'unavailable', reason: 'not_classification' };
  const qualifiers = (input.statement.qualifiers ?? []).flatMap((item) => {
    const qualifier = qualifierFromSnak(item);
    return qualifier ? [qualifier] : [];
  });
  return {
    subjectId: input.subjectId,
    associationId: input.statement.id,
    property: input.statement.property.id,
    targetId,
    contextId: input.contextId,
    qualifiersKey: classificationQualifiersKey(qualifiers),
    spoilerLevel: spoilerFromQualifiers(qualifiers),
    ...(typeof input.release === 'string' && input.release ? { release: input.release } : {}),
    ...(typeof input.revision === 'number' && Number.isSafeInteger(input.revision) && input.revision >= 1
      ? { revision: input.revision }
      : {}),
  };
}

export function disclosedClassificationAssociations(input: {
  subjectId: string;
  contextId: string;
  statements: Record<string, readonly unknown[]>;
  related?: Record<string, { type?: string; redirect?: string; labels?: unknown } | undefined>;
  propertyLabel: (property: string) => string;
  targetLabel: (targetId: string) => string;
  inspectHref: (identity: ClassificationAssociationIdentity) => string;
  changesHref: string;
  release?: string;
}): DisclosedClassificationAssociation[] {
  const selected: DisclosedClassificationAssociation[] = [];
  for (const rows of Object.values(input.statements)) {
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.property) || !isRecord(row.value) || typeof row.id !== 'string') continue;
      const bound = bindDisclosedClassificationAssociation({
        subjectId: input.subjectId,
        contextId: input.contextId,
        statement: {
          id: row.id,
          property: { id: String(row.property.id), data_type: String(row.property.data_type) },
          value: { type: String(row.value.type), content: row.value.content },
          qualifiers: Array.isArray(row.qualifiers) ? row.qualifiers : [],
        },
        ...(input.related ? { related: input.related } : {}),
        ...(input.release ? { release: input.release } : {}),
      });
      if ('kind' in bound) continue;
      selected.push({
        ...bound,
        propertyLabel: input.propertyLabel(bound.property),
        targetLabel: input.targetLabel(bound.targetId),
        inspectHref: input.inspectHref(bound),
        changesHref: input.changesHref,
      });
    }
  }
  return selected;
}

type BallotCall = Promise<{ status: number; data?: unknown; headers?: unknown }>;
type BallotHandle = {
  assessment: {
    get: (options?: { headers?: Record<string, string> }) => BallotCall;
    put: (
      body: { assessment: ClassificationAssessment; falsePositive: boolean },
      options: { headers: Record<string, string> },
    ) => BallotCall;
    delete: (body: undefined, options: { headers: Record<string, string> }) => BallotCall;
  };
  aggregate: {
    get: (options?: { headers?: Record<string, string> }) => BallotCall;
  };
};

/** Installed native paths; generated KernelClient nested types do not yet export this handle. */
export function classificationBallotHandle(
  client: KernelClient,
  subjectId: string,
  associationId: string,
): BallotHandle | null {
  if (!isClassificationUuid(subjectId) || !isClassificationUuid(associationId)) return null;
  const subject = client.subjects({ id: subjectId }) as unknown as Record<string, unknown>;
  const nested = subject['classification-associations'];
  if (typeof nested !== 'function') return null;
  const handle = (nested as (params: { associationId: string }) => BallotHandle)({ associationId });
  if (
    !handle ||
    typeof handle.assessment?.get !== 'function' ||
    typeof handle.assessment?.put !== 'function' ||
    typeof handle.assessment?.delete !== 'function' ||
    typeof handle.aggregate?.get !== 'function'
  )
    return null;
  return handle;
}

export function classificationProducerAvailable(client: KernelClient, subjectId: string, associationId: string): boolean {
  return classificationBallotHandle(client, subjectId, associationId) !== null;
}

function isAssessment(value: unknown): value is ClassificationAssessment {
  return value === 'support' || value === 'oppose';
}

export function admitClassificationOwnState(value: unknown, associationId: string): ClassificationOwnState | null {
  if (!isRecord(value) || value.associationId !== associationId || typeof value.hasBallot !== 'boolean') return null;
  if (value.pending !== true && value.pending !== false) return null;
  if (value.falsePositive !== true && value.falsePositive !== false) return null;
  if (value.assessment !== null && !isAssessment(value.assessment)) return null;
  if (value.revision !== null && (typeof value.revision !== 'string' || !revisionPattern.test(value.revision)))
    return null;
  if (value.hasBallot && (value.assessment === null || value.revision === null)) return null;
  if (!value.hasBallot && value.assessment !== null) return null;
  return {
    associationId,
    hasBallot: value.hasBallot,
    assessment: value.assessment,
    falsePositive: value.hasBallot ? value.falsePositive : false,
    revision: value.revision,
    pending: value.pending,
  };
}

export function admitClassificationSetResult(value: unknown, associationId: string): ClassificationSetResult | null {
  if (!isRecord(value) || value.associationId !== associationId) return null;
  if (typeof value.revision !== 'string' || !revisionPattern.test(value.revision)) return null;
  if (value.delivery !== 'enqueued' && value.delivery !== 'unchanged') return null;
  return { associationId, revision: value.revision, delivery: value.delivery };
}

function hasNumericLeak(value: Record<string, unknown>): boolean {
  return [
    'supportCount',
    'opposeCount',
    'falsePositiveCount',
    'supportFraction',
    'count',
    'denominator',
    'generation',
    'asOf',
    'eligible',
    'remaining',
    'threshold',
  ].some((key) => key in value && value[key] !== undefined);
}

export function admitClassificationAggregate(value: unknown, associationId: string): ClassificationAggregate | null {
  if (!isRecord(value) || value.associationId !== associationId || value.pending !== 'unknown') return null;
  if (value.state === 'suppressed') {
    if (hasNumericLeak(value)) return null;
    return { associationId, state: 'suppressed', pending: 'unknown' };
  }
  if (value.state !== 'published') return null;
  if (
    !Number.isSafeInteger(value.supportCount) ||
    (value.supportCount as number) < 0 ||
    !Number.isSafeInteger(value.opposeCount) ||
    (value.opposeCount as number) < 0 ||
    !Number.isSafeInteger(value.falsePositiveCount) ||
    (value.falsePositiveCount as number) < 0
  )
    return null;
  const denominator = (value.supportCount as number) + (value.opposeCount as number);
  if (denominator < CLASSIFICATION_BALLOT_MINIMUM) return null;
  if (value.supportFraction !== null) {
    if (typeof value.supportFraction !== 'number' || !Number.isFinite(value.supportFraction)) return null;
    if (value.supportFraction < 0 || value.supportFraction > 1) return null;
    const expected = denominator === 0 ? null : (value.supportCount as number) / denominator;
    if (expected === null || Math.abs(value.supportFraction - expected) > 1e-9) return null;
  } else if (denominator !== 0) return null;
  if (typeof value.asOf !== 'string' || !dateTimePattern.test(value.asOf)) return null;
  if (typeof value.generation !== 'string' || !revisionPattern.test(value.generation)) return null;
  return {
    associationId,
    state: 'published',
    pending: 'unknown',
    supportCount: value.supportCount as number,
    opposeCount: value.opposeCount as number,
    falsePositiveCount: value.falsePositiveCount as number,
    supportFraction: value.supportFraction as number | null,
    asOf: value.asOf,
    generation: value.generation,
  };
}

export function ownOutcomeFromState(value: ClassificationOwnState): Extract<
  ClassificationOwnOutcome,
  { kind: 'absent' | 'acknowledged' | 'pending' }
> {
  if (value.pending) return { kind: 'pending', value };
  if (!value.hasBallot) return { kind: 'absent', value };
  return { kind: 'acknowledged', value };
}

export function ownOutcomeFromStatus(status: number): Extract<
  ClassificationOwnOutcome,
  { kind: 'denied' | 'concealed' | 'unavailable' | 'conflict' }
> {
  if (status === 404) return { kind: 'concealed' };
  if (status === 401 || status === 403) return { kind: 'denied' };
  if (status === 409) return { kind: 'conflict' };
  return { kind: 'unavailable' };
}

export function aggregateOutcomeFromStatus(status: number): Extract<
  ClassificationAggregateOutcome,
  { kind: 'denied' | 'concealed' | 'unavailable' }
> {
  if (status === 404) return { kind: 'concealed' };
  if (status === 401 || status === 403) return { kind: 'denied' };
  return { kind: 'unavailable' };
}

export function emptyAssessmentCost(): ClassificationAssessmentCost {
  return { nativeCalls: 0, valuesProcessed: 0, bytesRetained: 0 };
}

export function retainedAssessmentBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

export function addAssessmentCost(
  cost: ClassificationAssessmentCost,
  delta: Partial<ClassificationAssessmentCost>,
): ClassificationAssessmentCost {
  return {
    nativeCalls: cost.nativeCalls + (delta.nativeCalls ?? 0),
    valuesProcessed: cost.valuesProcessed + (delta.valuesProcessed ?? 0),
    bytesRetained: cost.bytesRetained + (delta.bytesRetained ?? 0),
  };
}

export async function readClassificationOwnBallot(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  identity: ClassificationAssociationIdentity,
  expectedReader?: string | null,
): Promise<{ outcome: ClassificationOwnOutcome; reader: string | null; cost: ClassificationAssessmentCost }> {
  let reader: string | null = null;
  const cost = { nativeCalls: 0, valuesProcessed: 1, bytesRetained: 0 };
  try {
    await prepareSession(request, env);
    const authorization = viewerCredential(request);
    reader = await preparedRatingReader(request, authorization);
    if (!authorization || (expectedReader !== undefined && reader !== expectedReader))
      return { outcome: { kind: 'unavailable' }, reader, cost };
    if (identity.contextId !== PAGE_GLOBAL_CONTEXT)
      return { outcome: { kind: 'unavailable' }, reader, cost };
    const handle = classificationBallotHandle(client, identity.subjectId, identity.associationId);
    if (!handle) return { outcome: { kind: 'unavailable' }, reader, cost };
    cost.nativeCalls += 1;
    const result = await handle.assessment.get({ headers: { authorization } });
    if (result.status !== 200) {
      const outcome = ownOutcomeFromStatus(result.status);
      cost.bytesRetained = retainedAssessmentBytes(outcome);
      return { outcome, reader, cost };
    }
    const value = admitClassificationOwnState(result.data, identity.associationId);
    if (!value) {
      const outcome = { kind: 'unavailable' as const };
      cost.bytesRetained = retainedAssessmentBytes(outcome);
      return { outcome, reader, cost };
    }
    const outcome = ownOutcomeFromState(value);
    cost.valuesProcessed += 1;
    cost.bytesRetained = retainedAssessmentBytes(outcome);
    return { outcome, reader, cost };
  } catch {
    const outcome = { kind: 'unavailable' as const };
    cost.bytesRetained = retainedAssessmentBytes(outcome);
    return { outcome, reader, cost };
  }
}

export async function readClassificationAggregate(
  client: KernelClient,
  identity: ClassificationAssociationIdentity,
  authorization?: string,
): Promise<{ outcome: ClassificationAggregateOutcome; cost: ClassificationAssessmentCost }> {
  const cost = { nativeCalls: 0, valuesProcessed: 1, bytesRetained: 0 };
  if (identity.contextId !== PAGE_GLOBAL_CONTEXT) {
    const outcome = { kind: 'unavailable' as const };
    return { outcome, cost: { ...cost, bytesRetained: retainedAssessmentBytes(outcome) } };
  }
  const handle = classificationBallotHandle(client, identity.subjectId, identity.associationId);
  if (!handle) {
    const outcome = { kind: 'unavailable' as const };
    return { outcome, cost: { ...cost, bytesRetained: retainedAssessmentBytes(outcome) } };
  }
  try {
    cost.nativeCalls += 1;
    const result = await handle.aggregate.get(authorization ? { headers: { authorization } } : undefined);
    if (result.status !== 200) {
      const outcome = aggregateOutcomeFromStatus(result.status);
      cost.bytesRetained = retainedAssessmentBytes(outcome);
      return { outcome, cost };
    }
    const value = admitClassificationAggregate(result.data, identity.associationId);
    if (!value) {
      const outcome = { kind: 'unavailable' as const };
      cost.bytesRetained = retainedAssessmentBytes(outcome);
      return { outcome, cost };
    }
    const outcome = { kind: 'ready' as const, value };
    cost.valuesProcessed += 1;
    cost.bytesRetained = retainedAssessmentBytes(publicAggregateProjection(value));
    return { outcome, cost };
  } catch {
    const outcome = { kind: 'unavailable' as const };
    cost.bytesRetained = retainedAssessmentBytes(outcome);
    return { outcome, cost };
  }
}

/** Published numbers stay; suppressed projections omit every count, fraction and progress hint. */
export function publicAggregateProjection(value: ClassificationAggregate): ClassificationAggregate {
  if (value.state === 'suppressed') return { associationId: value.associationId, state: 'suppressed', pending: 'unknown' };
  return {
    associationId: value.associationId,
    state: 'published',
    pending: 'unknown',
    supportCount: value.supportCount,
    opposeCount: value.opposeCount,
    falsePositiveCount: value.falsePositiveCount,
    supportFraction: value.supportFraction,
    asOf: value.asOf,
    generation: value.generation,
  };
}

export function aggregateLeaksCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.state === 'suppressed') return hasNumericLeak(value);
  return false;
}

export type ClassificationWriteIntent = 'set' | 'withdraw';

export async function writeClassificationBallot(
  client: KernelClient,
  identity: ClassificationAssociationIdentity,
  authorization: string,
  idempotencyKey: string,
  intent: { kind: 'set'; assessment: ClassificationAssessment; falsePositive: boolean } | { kind: 'withdraw' },
): Promise<
  | { kind: 'accepted'; result: ClassificationSetResult | null }
  | { kind: 'conflict' }
  | { kind: 'denied' }
  | { kind: 'concealed' }
  | { kind: 'unavailable' }
  | { kind: 'uncertain' }
> {
  const handle = classificationBallotHandle(client, identity.subjectId, identity.associationId);
  if (!handle || identity.contextId !== PAGE_GLOBAL_CONTEXT) return { kind: 'unavailable' };
  const headers = { authorization, 'idempotency-key': JSON.stringify(idempotencyKey) };
  try {
    if (intent.kind === 'withdraw') {
      const result = await handle.assessment.delete(undefined, { headers });
      if (result.status === 204) return { kind: 'accepted', result: null };
      if (result.status === 409) return { kind: 'conflict' };
      if (result.status === 404) return { kind: 'concealed' };
      if (result.status === 401 || result.status === 403) return { kind: 'denied' };
      if (result.status >= 500 || result.status === 0) return { kind: 'uncertain' };
      return { kind: 'unavailable' };
    }
    const result = await handle.assessment.put(
      { assessment: intent.assessment, falsePositive: intent.falsePositive },
      { headers },
    );
    if (result.status === 200) {
      const accepted = admitClassificationSetResult(result.data, identity.associationId);
      return accepted ? { kind: 'accepted', result: accepted } : { kind: 'unavailable' };
    }
    if (result.status === 409) return { kind: 'conflict' };
    if (result.status === 404) return { kind: 'concealed' };
    if (result.status === 401 || result.status === 403) return { kind: 'denied' };
    if (result.status >= 500 || result.status === 0) return { kind: 'uncertain' };
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'uncertain' };
  }
}

export function isUnversionedObservation(
  value: unknown,
): value is { kind: 'unversioned'; digest: string } {
  return (
    isRecord(value) &&
    value.kind === 'unversioned' &&
    typeof value.digest === 'string' &&
    digestPattern.test(value.digest)
  );
}

export function isClassificationProvider(value: unknown): value is ClassificationProvider {
  return value === 'vndb' || value === 'bangumi';
}

export function providerRecordIsSafe(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    !/^https?:/i.test(value)
  );
}

export function bangumiRecordId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

export function vndbRecordId(value: string): boolean {
  return /^[vc][1-9][0-9]*$/i.test(value);
}

export function admitSourceObservationDate(value: unknown): value is string {
  if (typeof value !== 'string' || !datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function sessionActor(request: Request): { reader: string | null; subject: string | null } {
  return { reader: sessionSubject(request), subject: sessionSubject(request) };
}
