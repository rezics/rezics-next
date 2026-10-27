import type { Pool } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
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
  },
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
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
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
  return { value: { survivor: options.survivor, redirected: options.redirected, revision }, events };
}
