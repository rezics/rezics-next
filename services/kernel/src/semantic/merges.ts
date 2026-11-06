import { guardReviewedPersonIdentity, type ReviewedPersonExpectation } from './reviewed-person-identity.ts';
import { admitIdentityTerminalCapture, runIdentityTerminalCommand } from './identity-terminal-closure-command.ts';
import { retainSubjectPageContinuation } from './subject-page-publication-store.ts';
import { invalidateSubjectPage } from './subject-page-publication-native.ts';
import { identityEpochStore, identityJobPartition } from './identity-adapters/index.ts';
import selectJobById from './identity-epoch-store-select-job-by-id.sql';
import type { Pool } from 'pg';
import { type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { EditorialConflictError, SubjectNotFoundError } from './candidates.ts';
import { SUBJECT_MERGED } from './events.ts';
import type { Release } from '@rezics/definitions';
import readRedirect from './read-redirect.sql';
import changePartitionSubjectCount from './change-partition-subject-count.sql';
import updateSubjectRelease from './update-subject-release.sql';
import insertRedirect from './merges-insert-redirect.sql';
import insertRevision from './merges-insert-revision.sql';
import readLatestRevision from './merges-read-latest-revision.sql';
import readVisible from './merges-read-visible.sql';
import { AccountAgentVerificationError, accountAgentsForSubjects } from './agents.ts';
import markProjectionPending from './merge-mark-projection-pending.sql';

export class SubjectRedirectError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super('Subject has been redirected');
  }
}

export async function redirectOf(client: CommandTransaction, id: string): Promise<string | null> {
  const row = await readRedirect.run(client, { route: routeOf(id)!, subject_id: id });
  return row?.target ?? null;
}

async function mergeSubject(client: CommandTransaction, id: string) {
  const row = await readVisible.run(client, { route: routeOf(id)!, subject_id: id });
  if (!row) throw new SubjectNotFoundError();
  if (await redirectOf(client, id)) throw new EditorialConflictError();
  return row;
}

export async function mergeSubjects(
  pool: Pool,
  options: {
    subjects: string[];
    survivor?: string;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    release: { digest: string; release: Release };
    authorization: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
  } & (
    | { expectedIdentity: ReviewedPersonExpectation; routeKey: Uint8Array }
    | { expectedIdentity?: undefined; routeKey?: Uint8Array }
  ),
) {
  const requestedSurvivor = options.survivor;
  if (requestedSurvivor !== undefined && !options.subjects.includes(requestedSurvivor))
    throw new EditorialConflictError();
  const [defaultSurvivor, defaultRedirected] = [...options.subjects].sort() as [string, string];
  const survivor = requestedSurvivor ?? defaultSurvivor;
  const redirected = options.subjects.find((subject) => subject !== survivor) ?? defaultRedirected;
  if (survivor === redirected) throw new EditorialConflictError();
  // Preserve the preflight result until after receipt lookup so a later merge cannot invalidate a replay.
  const kept = await withConnection(pool, (client) => mergeSubject(client, survivor)).catch((error: unknown) => {
    if (error instanceof SubjectNotFoundError || error instanceof EditorialConflictError) return error;
    throw error;
  });
  const route = routeOf(redirected);
  if (route === null) throw new SubjectNotFoundError();
  const command = await runIdentityTerminalCommand(
    pool,
    {
      partition: partitionOf(route),
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: 'subject.merge',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
      clock: options.clock,
    },
    async (tx, { transactionId }) => {
      if (kept instanceof Error) throw kept;
      if (options.expectedIdentity) {
        await guardReviewedPersonIdentity(tx, options.expectedIdentity, options.routeKey, options.release.release);
      }
      return mergeSubjectsInCommand(tx, transactionId, {
        survivor,
        redirected,
        release: options.release,
      });
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

export type SubjectMergeAdmission = { operation: { id: string } };

/** Ordinary HTTP admission. Completes the catalogue redirect in the persist command;
 * callers observe publication through GET /v1/subjectIdentityOperations/{id}. */
export async function admitMergeSubjects(
  pool: Pool,
  options: {
    subjects: string[];
    survivor?: string;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    release: { digest: string; release: Release };
    /** The redirect command's authorization, prepared for the redirected Subject's partition. */
    authorization: CommandAuthorization;
    /** Authorizations for the admission's own partitions; the store asks for each one it runs on. */
    authorizationFor: (partition: number) => Promise<CommandAuthorization>;
    deadline?: number;
    clock?: () => Date;
  } & (
    | { expectedIdentity: ReviewedPersonExpectation; routeKey: Uint8Array }
    | { expectedIdentity?: undefined; routeKey?: Uint8Array }
  ),
) {
  const requestedSurvivor = options.survivor;
  if (requestedSurvivor !== undefined && !options.subjects.includes(requestedSurvivor))
    throw new EditorialConflictError();
  const [defaultSurvivor, defaultRedirected] = [...options.subjects].sort() as [string, string];
  const survivor = requestedSurvivor ?? defaultSurvivor;
  const redirected = options.subjects.find((subject) => subject !== survivor) ?? defaultRedirected;
  if (survivor === redirected) throw new EditorialConflictError();
  // The reviewed admission checks live identities on first execution. A completed
  // receipt must remain replayable after its original has been redirected.
  if (!options.expectedIdentity) {
    const kept = await withConnection(pool, (client) => mergeSubject(client, survivor));
    const gone = await withConnection(pool, (client) => mergeSubject(client, redirected));
    if (kept.type !== gone.type) throw new EditorialConflictError();
  }
  const route = routeOf(redirected);
  if (route === null) throw new SubjectNotFoundError();
  const receipt = {
    kind: 'subject.merge' as const,
    command: {
      actorAccountId: options.actor.accountId,
      kind: 'subject.merge',
      key: options.idempotencyKey,
      digest: options.digest,
    },
  };
  const job = await identityEpochStore().prepareAdmission(
    pool,
    {
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorizationFor: options.authorizationFor,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    },
    {
      intent: { kind: 'merge', survivor, redirected, release: options.release.digest },
      receipt,
      ...(options.expectedIdentity
        ? {
            reviewedPerson: {
              expected: options.expectedIdentity,
              routeKey: options.routeKey,
              release: options.release.release,
            },
          }
        : {}),
    },
  );
  const command = await runIdentityTerminalCommand(
    pool,
    {
      partition: partitionOf(route),
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      receipt: receipt.command,
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    },
    async (tx, { transactionId }) => {
      // prepareAdmission already compared and locked the paired evidence in its
      // authorized first-effect transaction. Do not compare it again after admission.
      const merged = await mergeSubjectsInCommand(tx, transactionId, {
        survivor,
        redirected,
        release: options.release,
      });
      return { value: { operation: { id: job.jobId } }, events: merged.events };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}

export type SubjectIdentityOperation =
  | { id: string; done: false }
  | { id: string; done: true; result: { survivor: string; redirected: string; revision: number } };

/** Effects-free observation of one ordinary merge job. Caller already authorized merge and disclosure. */
export async function observeSubjectIdentityOperation(
  tx: CommandTransaction,
  id: string,
): Promise<{
  operation: SubjectIdentityOperation;
  original: string;
  terminal: string;
} | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const found = (await tx.query(selectJobById.sql, [partitionOf(route), id])).rows[0] as
    | { job_id: string; epoch: string }
    | undefined;
  if (!found) return null;
  const job = await identityEpochStore().readJob(tx, { jobId: found.job_id, epoch: BigInt(found.epoch) });
  if (!job || identityJobPartition(job.ref) !== partitionOf(route)) return null;
  if (job.intent.kind !== 'merge' || job.receipt.kind !== 'subject.merge') return null;
  const complete =
    job.state === 'published' &&
    job.mapping?.state === 'complete' &&
    job.participants['search-canonical-index']?.state === 'complete' &&
    job.participants['library-private-follow-counts']?.state === 'complete';
  if (!complete) {
    return {
      operation: { id: job.ref.jobId, done: false },
      original: job.intent.redirected,
      terminal: job.intent.survivor,
    };
  }
  const redirectedRoute = routeOf(job.intent.redirected);
  if (redirectedRoute === null) return null;
  const latest = await readLatestRevision.run(tx, {
    route: redirectedRoute,
    subject_id: job.intent.redirected,
  });
  if (!latest) return null;
  return {
    operation: {
      id: job.ref.jobId,
      done: true,
      result: {
        survivor: job.intent.survivor,
        redirected: job.intent.redirected,
        revision: latest.revision,
      },
    },
    original: job.intent.redirected,
    terminal: job.intent.survivor,
  };
}

/** The redirect and revision work shared by ordinary and verified account-agent merges. */
export async function mergeSubjectsInCommand(
  tx: CommandTransaction,
  transactionId: string,
  options: {
    survivor: string;
    redirected: string;
    release: { digest: string; release: Release };
    verificationReceiptId?: string;
    allowAccountAgent?: boolean;
  },
) {
  await admitIdentityTerminalCapture(tx, [options.redirected]);
  if (options.survivor === options.redirected) throw new EditorialConflictError();
  const kept = await mergeSubject(tx, options.survivor);
  const gone = await mergeSubject(tx, options.redirected);
  const linked = await accountAgentsForSubjects(tx, [options.survivor, options.redirected]);
  if (options.allowAccountAgent) {
    if (gone.type !== 'schema:Person' && gone.type !== 'schema:Organization')
      throw new AccountAgentVerificationError('Only person and organization account agents can be verified');
    if (gone.type !== kept.type)
      throw new AccountAgentVerificationError('The catalogue subject must match the account agent kind');
    if (linked.has(options.survivor))
      throw new AccountAgentVerificationError('The catalogue subject is already an account agent');
  } else {
    if (linked.has(options.survivor) || linked.has(options.redirected)) throw new EditorialConflictError();
    if (gone.type !== kept.type) throw new EditorialConflictError();
  }
  const route = routeOf(options.redirected);
  if (route === null) throw new SubjectNotFoundError();
  const latest = (await readLatestRevision.run(tx, { route, subject_id: options.redirected }))!;
  const revision = latest.revision + 1;
  await insertRevision.run(tx, {
    route,
    subject_id: options.redirected,
    revision,
    release: options.release.digest,
    transaction_id: transactionId,
    verification_receipt_id: options.verificationReceiptId ?? null,
  });
  await updateSubjectRelease.run(tx, {
    route,
    subject_id: options.redirected,
    release: options.release.digest,
  });
  await changePartitionSubjectCount.run(tx, { partition_no: partitionOf(route), delta: -1 });
  await insertRedirect.run(tx, {
    route,
    subject_id: options.redirected,
    target: options.survivor,
    transaction_id: transactionId,
  });
  await markProjectionPending.run(tx, { route, subject_id: options.redirected });
  const events: { type: string; subject: string; data: unknown }[] = [
    { type: SUBJECT_MERGED, subject: options.redirected, data: { id: options.redirected, survivor: options.survivor } },
  ];
  await retainSubjectPageContinuation(tx, {
    subject: { route, id: options.redirected },
    kind: 'merge',
    changeId: transactionId,
  });
  await invalidateSubjectPage(tx, options.redirected, transactionId, events);
  return { value: { survivor: options.survivor, redirected: options.redirected, revision }, events };
}
