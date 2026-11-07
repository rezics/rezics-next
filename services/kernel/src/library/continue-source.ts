import type { Pool, PoolClient } from 'pg';
import { ProblemError } from '../http/problem-error.ts';
import { routeOf } from '../route/route.ts';
import { readRelease } from '../semantic/definitions.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import { progressUnit, resolveLibraryProfilePin, type LibraryProfilePin } from './profile.ts';
import { currentOwnerState, readOwnerOriginalTruth } from './owner-index.ts';
import type { ShelfSession } from './shelf-contract.ts';
import { createShelfActiveReader } from './shelf-active.ts';

type Client = Pick<PoolClient, 'query'>;
export type ContinueActiveSession = ShelfSession;

/** One original's actual state and bounded top active session. No entry is required for session support. */
export async function readContinueOriginalFacts(client: Client, accountId: string, original: string) {
  const truth = await readOwnerOriginalTruth(client, accountId, original);
  const sessions = await createShelfActiveReader().sessions(client, routeOf(accountId)!, accountId, [original]);
  const session = sessions.get(original) ?? null;
  const pin =
    session === null
      ? null
      : (
          await client.query<{ pin: unknown; lastChangedAt: string }>(
            `SELECT library_profile_pin AS pin,
       to_char(last_changed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastChangedAt"
     FROM library.progress_session
      WHERE route=$1 AND account_id=$2 AND session_id=$3 AND subject_id=$4 AND state='active'`,
            [routeOf(accountId), accountId, session.id, original],
          )
        ).rows[0];
  if (session !== null && pin === undefined) throw new ProblemError('semantic_not_ready');
  const activity = (
    await client.query<{ lastActivityAt: string | null; unknown: boolean }>(
      `SELECT to_char(activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActivityAt",
      activity_unknown AS unknown FROM library.owner_original_activity($1,$2,$3)`,
      [routeOf(accountId), accountId, original],
    )
  ).rows[0];
  if (!activity || activity.unknown) throw new ProblemError('semantic_not_ready');
  return {
    truth,
    session,
    sessionPin: pin === null || pin === undefined ? null : decodeLibraryProfilePin(pin.pin),
    sessionLastChangedAt: pin?.lastChangedAt ?? null,
    lastActivityAt: activity.lastActivityAt,
  };
}

async function acceptedProfile(pool: Pool, pin: LibraryProfilePin | null) {
  if (pin === null) throw new ProblemError('semantic_not_ready');
  const release = await readRelease(pool, pin.releaseDigest, { composed: false });
  const profile = release === null ? null : resolveLibraryProfilePin({ digest: pin.releaseDigest, release }, pin);
  if (profile === null) throw new ProblemError('semantic_not_ready');
  return profile;
}

/** Evaluate the shared canonical state winner and an independently selected native active session.
 * The shared owner plan owns original/terminal disclosure and complete alias/session coverage.
 * Resolve immutable releases only after releasing the owner snapshot; never infer history from today's profile.
 */
export async function evaluateContinueSupports(
  pool: Pool,
  state: ReturnType<typeof currentOwnerState>,
  session: ContinueActiveSession | null,
  sessionPin: LibraryProfilePin | null,
) {
  if (state.status !== 'complete') throw new ProblemError('semantic_not_ready');
  let activeState = false;
  if (state.state !== null) {
    const profile = await acceptedProfile(pool, state.state.pin);
    const meaning = profile.entryStateSet?.states.find((value) => value.id === state.state!.id);
    if (meaning === undefined) throw new ProblemError('semantic_not_ready');
    activeState = meaning.role === 'active';
  }
  if (session !== null) {
    const profile = await acceptedProfile(pool, sessionPin);
    if (session.state !== 'active' || progressUnit(profile, session.mode, session.unit) === null)
      throw new ProblemError('semantic_not_ready');
  }
  return { eligible: activeState || session !== null, state: state.state?.id ?? null, activeProgressSession: session };
}

export type ContinueOriginalFacts = Awaited<ReturnType<typeof readContinueOriginalFacts>>;

/**
 * Fold a complete, currently disclosed native canonical group from the SAME shared owner plan.
 * This does not resolve identity, enumerate aliases, grant disclosure or prove group completion.
 * Large groups remain that plan's retained preparation work rather than a per-page alias sweep.
 */
export async function evaluateContinueGroup(
  pool: Pool,
  subjectId: string,
  originals: readonly ContinueOriginalFacts[],
) {
  if (originals.length === 0 || originals.length > 100) throw new ProblemError('semantic_not_ready');
  const state = currentOwnerState(originals.map((original) => original.truth));
  let active: ContinueOriginalFacts | null = null;
  let lastActivityAt: string | null = null;
  for (const original of originals) {
    if (original.lastActivityAt !== null && (lastActivityAt === null || original.lastActivityAt > lastActivityAt))
      lastActivityAt = original.lastActivityAt;
    if (original.session === null) continue;
    if (original.sessionLastChangedAt === null) throw new ProblemError('semantic_not_ready');
    if (
      active === null ||
      original.sessionLastChangedAt > active.sessionLastChangedAt! ||
      (original.sessionLastChangedAt === active.sessionLastChangedAt && original.session.id < active.session!.id)
    )
      active = original;
  }
  // Validate every contributing session's accepted mode/unit, including an older support that is not displayed.
  for (const original of originals)
    if (original.session !== null)
      await evaluateContinueSupports(pool, { status: 'complete', state: null }, original.session, original.sessionPin);
  const supports = await evaluateContinueSupports(pool, state, active?.session ?? null, active?.sessionPin ?? null);
  if (!supports.eligible) return null;
  if (lastActivityAt === null) throw new ProblemError('semantic_not_ready');
  return { subjectId, state: supports.state, lastActivityAt, activeProgressSession: supports.activeProgressSession };
}
