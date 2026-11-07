import type { Pool } from 'pg';
import { readAccount, deadlineClient } from './access-port.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { accessCheck } from '../request/access-check.ts';
import type { Access, Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem-error.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { NativeCopyDefinitions } from './copy-model.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { readSubjectReference } from '../semantic/references.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import { readItemTypes, type SubjectComponent } from '../semantic/subject.ts';
import { selectLibraryProfile, type LibraryProfileDescriptor, type LibraryProfilePin } from './profile.ts';
import { resolveSubject } from './subject-anchor.ts';
import { currentCommandWorkAssociation } from '../command/work-context.ts';

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
export function readLibraryProfileSourceObservation(
  deps: LibraryProfileSourceDependencies,
  subjectId: string,
  definitions: Pick<NativeCopyDefinitions, 'active'> = { active: activeRelease },
) {
  return withRequestDeadline(deps.deadline, () => readSource(deps, subjectId, definitions));
}

async function readSource(
  deps: LibraryProfileSourceDependencies,
  subjectId: string,
  definitions: Pick<NativeCopyDefinitions, 'active'>,
): Promise<{
  source: NonNullable<LibraryProfileSource>;
  anchor: LibraryProfileAnchor;
} | null> {
  const anchor = await readLibraryProfileAnchor(deps, subjectId);
  if (!anchor) return null;
  const { acceptingType, identityEpoch: _identityEpoch, ...source } = anchor;
  // The source RR has ended before Global's independently anchored observation.
  requireAccessDeadline(deps.deadline);
  const active = await definitions.active(deps.pool);
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
    const account = await readAccount(
      deadlineClient(pool, deadline),
      accountRoute,
      actor.accountId,
      currentCommandWorkAssociation()?.access,
    );
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
  const before = await identityEpochStore().readMapping(pool, subjectId);
  if (before.state !== 'mapped') return null;
  const work = currentCommandWorkAssociation()?.access;
  const context = { pool, deadline, time: at, ...(work ? { work } : {}) };
  const resolved = await resolveSubject({ pool, access }, actor, subjectId, at, context);
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
    context,
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
    const after = await identityEpochStore().readMapping(pool, subjectId);
    requireAccessDeadline(deadline);
    if (after.state !== 'mapped' || after.epoch !== before.epoch || after.terminal !== before.terminal) return null;
    return { ...resolved, component: reference.component, identityEpoch: after.epoch, acceptingType };
  } catch (error) {
    if (error instanceof SubjectRedirectError) return null;
    throw error;
  }
}

export { sameCopyProfileAnchor as sameLibraryProfileAnchor } from './copy-model.ts';

export { assertPreProfileLibraryRead } from './profile-read-gate.ts';
