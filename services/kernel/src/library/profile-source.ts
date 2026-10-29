import type { Pool } from 'pg';
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
import { readItemTypes, type SubjectComponent } from '../semantic/subject.ts';
import { selectLibraryProfile, type LibraryProfileDescriptor, type LibraryProfilePin } from './profile.ts';
import { resolveSubject } from './subject-anchor.ts';

type Dependencies = { pool: Pool; access: Access; actor: Actor; at: AuthoritativeTime; deadline: number };
type Source = { subjectId: string; requestedSubjectId: string | null; component: SubjectComponent };
export type LibraryProfileSource =
  | (Source & {
      kind: 'supported';
      pin: Extract<LibraryProfilePin, { provenance: 'profile' }>;
      profile: LibraryProfileDescriptor;
    })
  | (Source & { kind: 'unsupported'; acceptingType: string })
  | null;

/** Private, current observations only: native T binds Access, not historical SQL snapshots. */
export function readLibraryProfileSource(deps: Dependencies, subjectId: string): Promise<LibraryProfileSource> {
  return withRequestDeadline(deps.deadline, () => readSource(deps, subjectId));
}

async function readSource(deps: Dependencies, subjectId: string): Promise<LibraryProfileSource> {
  const { pool, access, actor, at, deadline } = deps;
  authoritativeTimeValue(at);
  requireAccessDeadline(deadline);
  // A previously authenticated actor may have been suspended since admission.
  // Release this point read before checking out any subject or Global anchor.
  if (actor.kind === 'account') {
    const accountRoute = routeOf(actor.accountId);
    if (accountRoute === null) return null;
    const account = await readAccount(deadlineClient(pool, deadline), accountRoute, actor.accountId);
    if (
      !account || account.kind !== 'actor' || account.state !== 'active' || account.fenced ||
      actor.authnEpoch === undefined || BigInt(actor.authnEpoch) < account.minimumAuthnEpoch
    ) return null;
  }
  const visited = new Set<string>();
  while (true) {
    requireAccessDeadline(deadline);
    const resolved = await resolveSubject({ pool, access }, actor, subjectId, at);
    if (!resolved || visited.has(resolved.subjectId)) return null;
    visited.add(resolved.subjectId);
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
      { pool, deadline },
    );
    let acceptingType: string | undefined;
    try {
      const reference = await readSubjectReference(pool, resolved.subjectId, async (client) => {
        requireAccessDeadline(deadline);
        if (!(await check(client, at))) return false;
        acceptingType = (await readItemTypes(client, [resolved.subjectId])).get(resolved.subjectId);
        requireAccessDeadline(deadline);
        return acceptingType !== undefined;
      });
      if (!reference || acceptingType === undefined) return null;
      // The source RR has ended before Global's independently anchored observation.
      requireAccessDeadline(deadline);
      const active = await activeRelease(pool);
      requireAccessDeadline(deadline);
      if (!active) throw new ProblemError('semantic_not_ready');
      const source = { ...resolved, component: reference.component };
      const profile = selectLibraryProfile(active.release, acceptingType);
      if (!profile) return { ...source, kind: 'unsupported', acceptingType };
      const profileId = active.release.types[acceptingType]!.library!.profileId;
      return {
        ...source,
        kind: 'supported',
        profile,
        pin: {
          provenance: 'profile',
          releaseDigest: active.digest,
          acceptingType,
          profileId,
        },
      };
    } catch (error) {
      if (!(error instanceof SubjectRedirectError) || error.from !== resolved.subjectId) throw error;
      // Reuse the resolver, including its source/survivor authorization and cycle rules.
    }
  }
}
