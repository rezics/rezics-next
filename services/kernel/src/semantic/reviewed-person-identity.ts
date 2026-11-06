import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { Release } from '@rezics/definitions';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../access/unavailable.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { importedTupleRouteOf } from './adapters/imported-route.ts';
import { EditorialConflictError } from './candidates.ts';
import { effectiveGlobalSlotFacts } from './slots.ts';
import readClaim from './reviewed-person-identity-read-claim.sql';
import lockClaim from './reviewed-person-identity-lock-claims.sql';
import lockSubject from './reviewed-person-identity-lock-subjects.sql';
import readVisible from './merges-read-visible.sql';
import readLatestRevision from './merges-read-latest-revision.sql';
import readRedirect from './read-redirect.sql';

export type ReviewedPersonEndpoint = {
  subject: string;
  revision: number;
  securityRevision: string;
  source: 'bangumi' | 'vndb' | 'bangumi_cross_media' | 'vndb_cross_media';
  externalId: string;
  claimTransactionId: string;
  property: 'wdt:P6298' | 'wdt:P3180';
  value: string;
};
export type ReviewedPersonSource = Pick<ReviewedPersonEndpoint, 'source' | 'externalId'>;
export type ReviewedPersonExpectation = { endpoints: [ReviewedPersonEndpoint, ReviewedPersonEndpoint] };

export const ReviewedPersonEndpointSchema = t.Object(
  {
    subject: t.String({ format: 'uuid' }),
    revision: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    securityRevision: t.String({ pattern: String.raw`^[1-9][0-9]*$(?![\s\S])` }),
    source: t.Union([
      t.Literal('bangumi'),
      t.Literal('vndb'),
      t.Literal('bangumi_cross_media'),
      t.Literal('vndb_cross_media'),
    ]),
    externalId: t.String({ maxLength: 255 }),
    claimTransactionId: t.String({ format: 'uuid' }),
    property: t.Union([t.Literal('wdt:P6298'), t.Literal('wdt:P3180')]),
    value: t.String({ maxLength: 255 }),
  },
  { additionalProperties: false },
);
export const ReviewedPersonExpectationSchema = t.Object(
  {
    endpoints: t.Tuple([ReviewedPersonEndpointSchema, ReviewedPersonEndpointSchema]),
  },
  { additionalProperties: false },
);

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
/** Cross-field validation at the public request boundary, before digesting the unchanged body. */
export function isReviewedPersonSource(value: ReviewedPersonSource): boolean {
  return (
    bytes(value.externalId) <= 255 &&
    (value.source === 'bangumi' || value.source === 'bangumi_cross_media'
      ? /^person:[1-9][0-9]*$(?![\s\S])/.test(value.externalId)
      : /^s[1-9][0-9]*$(?![\s\S])/.test(value.externalId))
  );
}
export function reviewedPersonIdentifier(source: ReviewedPersonSource) {
  return source.source === 'bangumi' || source.source === 'bangumi_cross_media'
    ? { property: 'wdt:P6298' as const, value: source.externalId.slice(7) }
    : { property: 'wdt:P3180' as const, value: source.externalId };
}
export function validReviewedPersonExpectation(
  subjects: readonly string[],
  expected: ReviewedPersonExpectation,
): boolean {
  return (
    bytes(JSON.stringify(expected)) <= 4096 &&
    expected.endpoints.every((endpoint, index) => {
      const identifier = reviewedPersonIdentifier(endpoint);
      return (
        endpoint.subject === subjects[index] &&
        isReviewedPersonSource(endpoint) &&
        endpoint.property === identifier.property &&
        endpoint.value === identifier.value &&
        bytes(endpoint.value) <= 255
      );
    })
  );
}

/** Existing native unavailable classification, with a stable internal reason for unsupported coverage. */
export function ReviewedPersonGuardUnavailableError() {
  return memoizedValue(
    ReviewedPersonGuardUnavailableError,
    () =>
      class ReviewedPersonGuardUnavailableError extends CommandUnavailableError {
        readonly code = 'atomic_guard_unavailable';
        constructor(partition: number) {
          super('fenced', partition);
          this.message = 'atomic_guard_unavailable';
        }
      },
  );
}
export type ReviewedPersonGuardUnavailableError = InstanceType<ReturnType<typeof ReviewedPersonGuardUnavailableError>>;

/** Caller has already authorized this original in its final read transaction. Never follows redirects. */
export async function observeReviewedPersonIdentity(
  tx: CommandTransaction,
  subject: string,
  source: ReviewedPersonSource,
  routeKey: Uint8Array,
  release: Release,
  lockSelected = false,
): Promise<ReviewedPersonEndpoint | null> {
  const route = routeOf(subject)!;
  const identity = reviewedPersonIdentifier(source);
  if (
    !release.types['schema:Person']?.properties.includes(identity.property) ||
    release.properties[identity.property]?.datatype !== 'external-id'
  )
    return null;
  const visible = await readVisible.run(tx, { route, subject_id: subject });
  if (visible?.type !== 'schema:Person') return null;
  if ((await readRedirect.run(tx, { route, subject_id: subject }))?.target) return null;
  const claim = await readClaim.run(tx, {
    route: importedTupleRouteOf()(routeKey, source.source, source.externalId),
    source: source.source,
    external_id: source.externalId,
  });
  if (claim?.subject !== subject) return null;
  const latest = await readLatestRevision.run(tx, { route, subject_id: subject });
  if (!latest) return null;
  let selected: Awaited<ReturnType<typeof effectiveGlobalSlotFacts>>;
  try {
    selected = await effectiveGlobalSlotFacts(tx, subject, identity.property, undefined, lockSelected);
  } catch (error) {
    if (lockSelected && error instanceof AccessUnavailableError)
      throw new (ReviewedPersonGuardUnavailableError())(currentCommand(tx).partition);
    throw error;
  }
  // Hidden or missing selected rows cannot be filtered into an apparently agreeing identity.
  const basis = selected.basis as { selection: unknown[] } | unknown[] | null;
  const count = Array.isArray(basis) ? basis.length : (basis?.selection.length ?? 0);
  if (count === 0 || count > 32 || selected.facts.length !== count) {
    if (lockSelected) throw new (ReviewedPersonGuardUnavailableError())(currentCommand(tx).partition);
    return null;
  }
  let strings = 0;
  for (const fact of selected.facts) {
    const statement = fact.body as { rank?: string; value: { type: string; content?: unknown } };
    if (statement.rank === 'deprecated') continue;
    if (
      statement.value.type !== 'value' ||
      typeof statement.value.content !== 'string' ||
      statement.value.content !== identity.value
    )
      return null;
    strings++;
  }
  if (!strings) return null;
  return {
    subject,
    revision: latest.revision,
    securityRevision: latest.security_revision,
    source: source.source,
    externalId: source.externalId,
    claimTransactionId: claim.transaction,
    ...identity,
  };
}

/** Runs only inside the authorized first-effect callback; every restarted callback reacquires exclusions. */
export async function guardReviewedPersonIdentity(
  tx: CommandTransaction,
  expected: ReviewedPersonExpectation,
  routeKey: Uint8Array,
  release: Release,
): Promise<void> {
  const partition = currentCommand(tx).partition;
  const keys = expected.endpoints.map((endpoint) => ({
    endpoint,
    route: routeOf(endpoint.subject),
    claimRoute: importedTupleRouteOf()(routeKey, endpoint.source, endpoint.externalId),
  }));
  if (
    keys.some(
      ({ route, claimRoute }) =>
        route === null || partitionOf(route) !== partition || partitionOf(claimRoute) !== partition,
    )
  )
    throw new (ReviewedPersonGuardUnavailableError())(partition);
  const home = await readPartition(tx, partition);
  if (home?.writeState !== 'active') throw new (ReviewedPersonGuardUnavailableError())(partition);
  // Lock exact positive keys only. Missing claims need no gap exclusion: no effect can follow.
  for (const { endpoint, claimRoute } of [...keys].sort(
    (a, b) =>
      a.claimRoute - b.claimRoute ||
      a.endpoint.source.localeCompare(b.endpoint.source) ||
      a.endpoint.externalId.localeCompare(b.endpoint.externalId),
  )) {
    const claim = await lockClaim.run(tx, {
      route: claimRoute,
      source: endpoint.source,
      external_id: endpoint.externalId,
    });
    if (claim?.subject !== endpoint.subject || claim.transaction !== endpoint.claimTransactionId)
      throw new EditorialConflictError();
  }
  for (const { endpoint, route } of [...keys].sort((a, b) => a.endpoint.subject.localeCompare(b.endpoint.subject))) {
    const locked = await lockSubject.run(tx, { route: route!, subject_id: endpoint.subject });
    if (!locked) throw new EditorialConflictError();
    // Installed closure incarnations require the concurrent admission owner; this native
    // first-effect path can establish only an unpending legacy self mapping.
    if (
      locked.owner_epoch !== home.epoch ||
      locked.group_owner_epoch !== home.epoch ||
      locked.control_partition !== partition ||
      locked.terminal !== endpoint.subject ||
      locked.closure_state !== 'legacy' ||
      locked.pending_job ||
      locked.pending_epoch !== null
    )
      throw new (ReviewedPersonGuardUnavailableError())(partition);
  }
  for (const { endpoint } of keys) {
    const observed = await observeReviewedPersonIdentity(tx, endpoint.subject, endpoint, routeKey, release, true);
    if (
      !observed ||
      observed.revision !== endpoint.revision ||
      observed.securityRevision !== endpoint.securityRevision ||
      observed.claimTransactionId !== endpoint.claimTransactionId ||
      observed.property !== endpoint.property ||
      observed.value !== endpoint.value
    )
      throw new EditorialConflictError();
  }
}
