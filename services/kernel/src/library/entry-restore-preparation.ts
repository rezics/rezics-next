import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { commandAttemptDeadline, type AuthoritativeTime, type CommandAttempt } from '../command/command.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  requireAccessDeadline,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import type { Access, Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { readRelease } from '../semantic/definitions.ts';
import { LibraryNotFoundError, requireRoute } from './collection-command-work.ts';
import { LibraryEntryLifecycleConflictError } from './entry-lifecycle-errors.ts';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import { readRetainedEntryDeletion, type RetainedEntryDeletion } from './entry-retention-store.ts';
import { hasEntryState, resolveLibraryProfilePin } from './profile.ts';
import { resolveSubject } from './subject-anchor.ts';

type Input = { subjectId: string; deletionId: string; revision: number };
type Reference = { releaseDigest: string; profileId: string; stateSetId: string; stateId: string };
export type EntryRestorationPreparation =
  | { kind: 'ready'; at: AuthoritativeTime; deletion: RetainedEntryDeletion; reference: Reference | null }
  | { kind: 'deferred'; at: AuthoritativeTime; error: unknown };

const boundedReadOptions = {
  deadlineError: () => new AccessUnavailableError('deadline'),
  mapError(error: unknown) {
    if (error instanceof CommandUnavailableError) return error;
    try {
      throwAccessUnavailable(error);
    } catch (mapped) {
      return mapped;
    }
    return error;
  },
  isUncertainError: (error: unknown) => classifyUnavailability(error) !== undefined,
  isUncertainSettledQueryError: () => true,
};

/** Invocation-local historical meaning, never authorization or a persisted membership witness. */
export async function prepareEntryRestoration(
  deps: { pool: Pool; access: Access; clock?: KernelClock },
  actor: Actor,
  input: Input,
  attempt: CommandAttempt,
  requestDeadline: number,
): Promise<EntryRestorationPreparation> {
  const deadline = Math.min(requestDeadline, commandAttemptDeadline(attempt));
  await admitEntryAttempt(deps, actor, 'library_entry:update', attempt, deadline);
  return withRequestDeadline(deadline, async () => {
    try {
      if (actor.kind !== 'account') throw new LibraryNotFoundError();
      const deletion = await withBoundedReadOnlyTransaction(
        deps.pool,
        deadline,
        (client) =>
          readRetainedEntryDeletion(client, {
            route: requireRoute(actor.accountId),
            accountId: actor.accountId,
            subjectId: input.subjectId,
            deletionId: input.deletionId,
          }),
        boundedReadOptions,
      );
      if (!deletion) throw new LibraryNotFoundError();
      if (deletion.deletedRevision !== input.revision) throw new (LibraryEntryLifecycleConflictError())('stale');
      // The owner checkout has ended before either immutable Global or source reads.
      requireAccessDeadline(deadline);
      let reference: Reference | null = null;
      const pin = deletion.libraryProfilePin;
      if (pin) {
        const release = await withBoundedReadConnection(
          deps.pool,
          deadline,
          (client) => readRelease(client, pin.releaseDigest),
          boundedReadOptions,
        );
        if (!release) throw new Error('Retained entry definition release is missing');
        const profile = resolveLibraryProfilePin({ digest: pin.releaseDigest, release }, pin);
        if (!profile) throw new Error('Retained entry profile is missing');
        if (profile.entryStateSet && hasEntryState(profile, deletion.state)) {
          reference = {
            releaseDigest: pin.releaseDigest,
            profileId: profile.id,
            stateSetId: profile.entryStateSet.id,
            stateId: deletion.state,
          };
        } else if (pin.provenance !== 'legacy') {
          throw new Error('Retained entry state is absent from its accepted profile');
        }
      }
      requireAccessDeadline(deadline);
      if (!(await resolveSubject(deps, actor, deletion.subjectId, attempt.time, { pool: deps.pool, deadline })))
        throw new LibraryNotFoundError();
      requireAccessDeadline(deadline);
      return { kind: 'ready', at: attempt.time, deletion, reference };
    } catch (error) {
      return { kind: 'deferred', at: attempt.time, error };
    }
  });
}
