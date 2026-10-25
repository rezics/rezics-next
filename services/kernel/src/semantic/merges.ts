import type { Pool } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { EditorialConflictError, SubjectNotFoundError } from './candidates.ts';
import { LINKS_CHANGED, SUBJECT_MERGED } from './events.ts';
import { factDataTypes } from './item.ts';
import { linkChanges } from './link-changes.ts';
import { slotView } from './slots.ts';
import type { Release } from '@rezics/definitions';
import readRedirect from './read-redirect.sql';

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
  const result = await client.query<{ type: string }>(
    `SELECT type FROM semantic.subject WHERE route = $1 AND subject_id = $2 AND visibility = 'visible'`,
    [routeOf(id), id],
  );
  if (!result.rows[0]) throw new SubjectNotFoundError();
  if (await redirectOf(client, id)) throw new EditorialConflictError();
  return result.rows[0];
}

export async function mergeSubjects(
  pool: Pool,
  options: {
    subjects: string[];
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    release: { digest: string; release: Release };
    authorization: CommandAuthorization;
    deadline: number;
  },
) {
  const [survivor, redirected] = [...options.subjects].sort() as [string, string];
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
    },
    async (tx, { transactionId }) => {
      if (kept instanceof Error) throw kept;
      const gone = await mergeSubject(tx, redirected);
      if (gone.type !== kept.type) throw new EditorialConflictError();
      const latest = await tx.query<{ revision: number; security_revision: string }>(
        `SELECT latest.revision, s.security_revision::text AS security_revision
         FROM semantic.subject s
         JOIN LATERAL (
           SELECT revision FROM semantic.revision
           WHERE route = s.route AND subject_id = s.subject_id
           ORDER BY revision DESC LIMIT 1
         ) latest ON true
         WHERE s.route = $1 AND s.subject_id = $2`,
        [route, redirected],
      );
      const revision = latest.rows[0]!.revision + 1;
      const securityRevision = Number(latest.rows[0]!.security_revision);
      await tx.query(
        `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
      VALUES ($1, $2, $3, 'merge', $4, $5)`,
        [route, redirected, revision, options.release.digest, transactionId],
      );
      await tx.query(
        `INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id)
      VALUES ($1, $2, 1, $3, $4)`,
        [route, redirected, survivor, transactionId],
      );
      const facts = [];
      for (const property of options.release.release.types[gone.type]?.properties ?? []) {
        facts.push(...(await slotView(tx, redirected, property)).facts);
      }
      const changes = linkChanges(facts, [], factDataTypes(options.release.release, facts));
      const events: { type: string; subject: string; data: unknown }[] = [
        { type: SUBJECT_MERGED, subject: redirected, data: { id: redirected, survivor } },
      ];
      if (changes.length)
        events.push({
          type: LINKS_CHANGED,
          subject: redirected,
          data: { subject: redirected, revision, security_revision: securityRevision, changes },
        });
      return { value: { survivor, redirected, revision }, events };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}
