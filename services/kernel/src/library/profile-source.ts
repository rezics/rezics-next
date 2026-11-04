import type { Pool, PoolClient } from 'pg';
import migrationProgress from './profile-migration-progress.sql';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { readSubjectReference } from '../semantic/references.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import { readItemTypes, type SubjectComponent } from '../semantic/subject.ts';
import { selectLibraryProfile, type LibraryProfileDescriptor, type LibraryProfilePin } from './profile.ts';
import { resolveSubject } from './subject-anchor.ts';

export type LibraryProfileSourceDependencies = {
  pool: Pool;
  access: Access;
  actor: Actor;
  at: AuthoritativeTime;
  deadline: number;
};
type Source = { subjectId: string; requestedSubjectId: string | null; component: SubjectComponent };
export type LibraryProfileAnchor = Source & { acceptingType: string; identityEpoch: bigint };
export type LibraryProfileSource =
  | (Source & {
      kind: 'supported';
      pin: Extract<LibraryProfilePin, { provenance: 'profile' }>;
      profile: LibraryProfileDescriptor;
    })
  | (Source & { kind: 'unsupported'; acceptingType: string })
  | null;

/** Private, current observations only: native T binds Access, not historical SQL snapshots. */
export async function readLibraryProfileSource(
  deps: LibraryProfileSourceDependencies,
  subjectId: string,
): Promise<LibraryProfileSource> {
  return (await readLibraryProfileSourceObservation(deps, subjectId))?.source ?? null;
}

/** The same source producer with its private before/final fence retained for a bounded detail. */
export function readLibraryProfileSourceObservation(deps: LibraryProfileSourceDependencies, subjectId: string) {
  return withRequestDeadline(deps.deadline, () => readSource(deps, subjectId));
}

async function readSource(
  deps: LibraryProfileSourceDependencies,
  subjectId: string,
): Promise<{
  source: NonNullable<LibraryProfileSource>;
  anchor: LibraryProfileAnchor;
} | null> {
  const anchor = await readLibraryProfileAnchor(deps, subjectId);
  if (!anchor) return null;
  const { acceptingType, identityEpoch: _identityEpoch, ...source } = anchor;
  // The source RR has ended before Global's independently anchored observation.
  requireAccessDeadline(deps.deadline);
  const active = await activeRelease(deps.pool);
  requireAccessDeadline(deps.deadline);
  if (!active) throw new ProblemError('semantic_not_ready');
  const profile = selectLibraryProfile(active.release, acceptingType);
  if (!profile) return { anchor, source: { ...source, kind: 'unsupported', acceptingType } };
  const profileId = active.release.types[acceptingType]!.library!.profileId;
  return {
    anchor,
    source: {
      ...source,
      kind: 'supported',
      profile,
      pin: { provenance: 'profile', releaseDigest: active.digest, acceptingType, profileId },
    },
  };
}

/** Current source/type/disclosure only. No profile or release lookup; each foreign home is released. */
export async function readLibraryProfileAnchor(
  deps: LibraryProfileSourceDependencies,
  subjectId: string,
): Promise<LibraryProfileAnchor | null> {
  const { pool, access, actor, at, deadline } = deps;
  authoritativeTimeValue(at);
  requireAccessDeadline(deadline);
  if (actor.kind === 'account') {
    const accountRoute = routeOf(actor.accountId);
    if (accountRoute === null) return null;
    const account = await readAccount(deadlineClient(pool, deadline), accountRoute, actor.accountId);
    if (
      !account ||
      account.kind !== 'actor' ||
      account.state !== 'active' ||
      account.fenced ||
      !Number.isSafeInteger(actor.authnEpoch) ||
      actor.authnEpoch < 1 ||
      BigInt(actor.authnEpoch) < account.minimumAuthnEpoch
    )
      return null;
  }
  const before = await identityEpochStore.readMapping(pool, subjectId);
  if (before.state !== 'mapped') return null;
  const resolved = await resolveSubject({ pool, access }, actor, subjectId, at, { pool, deadline, time: at });
  if (!resolved || resolved.subjectId !== before.terminal) return null;
  const route = routeOf(resolved.subjectId)!;
  const check = await accessCheck(
    access,
    actor,
    'subject:read',
    {
      route,
      id: resolved.subjectId,
      eligibility: subjectReadEligibility({ route, id: resolved.subjectId }),
    },
    { pool, deadline, time: at },
  );
  let acceptingType: string | undefined;
  try {
    const reference = await readSubjectReference(pool, resolved.subjectId, async (client) => {
      requireAccessDeadline(deadline);
      if (!(await check(client, at))) return false;
      acceptingType = (await readItemTypes(deadlineClient(client, deadline), [resolved.subjectId])).get(
        resolved.subjectId,
      );
      return acceptingType !== undefined;
    });
    if (!reference || acceptingType === undefined) return null;
    const after = await identityEpochStore.readMapping(pool, subjectId);
    requireAccessDeadline(deadline);
    if (after.state !== 'mapped' || after.epoch !== before.epoch || after.terminal !== before.terminal) return null;
    return { ...resolved, component: reference.component, identityEpoch: after.epoch, acceptingType };
  } catch (error) {
    if (error instanceof SubjectRedirectError) return null;
    throw error;
  }
}

export function sameLibraryProfileAnchor(before: LibraryProfileAnchor, after: LibraryProfileAnchor | null): boolean {
  return (
    after !== null &&
    before.subjectId === after.subjectId &&
    before.requestedSubjectId === after.requestedSubjectId &&
    before.acceptingType === after.acceptingType &&
    before.identityEpoch === after.identityEpoch &&
    before.component.partition === after.component.partition &&
    before.component.epoch === after.component.epoch &&
    before.component.position === after.component.position
  );
}

/** Read-only rollout boundary. Existing fixed-contract DTOs can expose an unpinned
 * historical fact only before that owner's live-fact cutover. A missing job never
 * prevents reading a current pinned fact, and reads never create owner metadata.
 */
export async function assertPreProfileLibraryRead(client: Pick<PoolClient, 'query'>, accountId: string): Promise<void> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid Library owner');
  const migration = await migrationProgress.run(client, { route, account_id: accountId });
  if (migration?.phase === 'ready') throw new Error('Unpinned Library fact after owner cutover');
}
