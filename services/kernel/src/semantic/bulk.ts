import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import {
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
  type CommandOutcome,
} from '../command/command.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { requestDigest } from '../http/request.ts';
import type { AccountActor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { EditorialConflictError, SubjectNotFoundError, writeProposal } from './candidates.ts';
import { redirectOf, SubjectRedirectError } from './merges.ts';
import { writeSubject, type SubjectComponent } from './subject.ts';
import { SUBJECT_REVISED } from './events.ts';
import updateSubjectRelease from './update-subject-release.sql';

export type BulkValue =
  | { id: string; revision: number }
  | { candidate: string; revision: number }
  | { revision: number };
type Value = { status: 200 | 201; value: BulkValue };

/** A resolving write records its receipt at the existing fence, without a revision or an event. */
class Resolved extends Error {
  constructor(readonly outcome: CommandOutcome<Value>) {
    super('Source record already resolved');
  }
}

export function batchRoute(routeKey: Uint8Array, command: BatchCommand): number | null {
  const tuple = tupleRoute(routeKey, command.source.source, command.source.external_id);
  return command.op === 'create' ? tuple : routeOf(command.subject);
}

/** The canonical semantic statement identity excludes evidence and editorial rank. */
export function statementDigest(statement: Extract<BatchCommand, { op: 'propose' }>['statement']): string {
  return createHash('sha256')
    .update(
      canonicalize({ property: statement.property, value: statement.value, qualifiers: statement.qualifiers ?? [] })!,
    )
    .digest('hex');
}

async function visibleSubject(tx: CommandTransaction, route: number, id: string) {
  const result = await tx.query<{ type: string; revision: number }>(
    `SELECT s.type, r.revision FROM semantic.subject s
     JOIN LATERAL (SELECT revision FROM semantic.revision WHERE route = s.route AND subject_id = s.subject_id
       ORDER BY revision DESC LIMIT 1) r ON true
     WHERE s.route = $1 AND s.subject_id = $2 AND s.visibility = 'visible'`,
    [route, id],
  );
  const subject = result.rows[0];
  if (!subject) throw new SubjectNotFoundError();
  const redirect = await redirectOf(tx, id);
  if (redirect) throw new SubjectRedirectError(id, redirect);
  return subject;
}

export async function batchCommand(
  pool: Pool,
  options: {
    command: BatchCommand;
    route: number;
    actor: AccountActor;
    authorization: CommandAuthorization;
    release: { digest: string; release: Release };
    deadline: number;
  },
): Promise<Value & { component: SubjectComponent }> {
  const { command, actor, route } = options;
  const partition = partitionOf(route);
  const kind = `subject.batch_${command.op}`;
  const digest = requestDigest(kind, actor, command);
  try {
    const outcome = await runCommand<Value>(
      pool,
      {
        partition,
        deadline: options.deadline,
        authorization: options.authorization,
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        receipt: { actorAccountId: actor.accountId, kind, key: command.key, digest },
      },
      async (tx, { transactionId }) => {
        try {
          // runCommand has already reauthorized and probed the receipt. A no-op has no
          // outbox envelope to fence, so finish only its receipt in this transaction.
          const resolve = async (value: BulkValue): Promise<never> => {
            const state = await readPartition(tx, partition);
            if (!state) throw new SubjectNotFoundError();
            const result: Value = { status: 200, value };
            await tx
              .query(
                `INSERT INTO core.receipt
             (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
              epoch, position, transaction_id, response)
             SELECT partition_no, 'account', $2, $3, $4, $5, epoch, position, $6, $7
             FROM core.partition WHERE partition_no = $1 AND write_state = 'active' AND epoch = $8 AND position = $9`,
                [
                  partition,
                  actor.accountId,
                  kind,
                  command.key,
                  digest,
                  transactionId,
                  JSON.stringify(result),
                  state.epoch,
                  state.position,
                ],
              )
              .then((inserted) => {
                if (inserted.rowCount !== 1)
                  throw Object.assign(new Error('Partition fence changed'), { code: '40001' });
              });
            await tx.query('COMMIT AND CHAIN');
            // This sentinel bypasses the event-producing completion. The runner's
            // rollback closes the empty chained transaction and still releases its gate and time.
            throw new Resolved({ ...state, partition, transactionId, replayed: false, value: result });
          };
          const source = command.source;
          if (command.op === 'create') {
            const claim = await tx.query<{ subject_id: string }>(
              `SELECT subject_id FROM semantic.external_claim WHERE route = $1 AND source = $2 AND external_id = $3`,
              [route, source.source, source.external_id],
            );
            const id = claim.rows[0]?.subject_id;
            if (id) {
              const subject = await visibleSubject(tx, route, id);
              if (subject.type !== command.subject.type) throw new EditorialConflictError();
              return resolve({ id, revision: subject.revision });
            }
            const target = { route, id: newId(route) };
            const written = await writeSubject(tx, transactionId, {
              target,
              item: command.subject,
              release: options.release,
              source,
            });
            await tx.query(
              `INSERT INTO semantic.external_claim (route, source, external_id, subject_id, recorded_transaction_id)
             VALUES ($1, $2, $3, $4, $5)`,
              [route, source.source, source.external_id, target.id, transactionId],
            );
            return { value: { status: 201, value: { id: written.value.id, revision: 1 } }, events: written.events };
          }
          const subject = await visibleSubject(tx, route, command.subject);
          if (command.op === 'propose') {
            const hash = statementDigest(command.statement);
            const key = [route, command.subject, source.source, source.external_id, source.field_group, hash];
            const existing = await tx.query<{ candidate_id: string }>(
              `SELECT candidate_id FROM semantic.source_candidate
             WHERE route = $1 AND subject_id = $2 AND source = $3 AND external_id = $4 AND field_group = $5 AND statement_digest = $6`,
              key,
            );
            if (existing.rows[0])
              return resolve({ candidate: existing.rows[0].candidate_id, revision: subject.revision });
            const written = await writeProposal(tx, transactionId, {
              subject: command.subject,
              statement: command.statement,
              release: options.release,
              source,
            });
            await tx.query(
              `INSERT INTO semantic.source_candidate
             (route, subject_id, source, external_id, field_group, statement_digest, candidate_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [...key, written.value.candidate],
            );
            return { value: { status: 201, value: written.value }, events: written.events };
          }
          const proposed = await tx.query<{ source: Source | null }>(
            `SELECT r.source FROM semantic.candidate c JOIN semantic.revision r
           ON r.route = c.route AND r.subject_id = c.subject_id AND r.revision = c.revision
           WHERE c.route = $1 AND c.subject_id = $2 AND c.candidate_id = $3`,
            [route, command.subject, command.candidate],
          );
          if (!proposed.rows[0]) {
            // Compact single-route candidates exist virtually before slot expansion.
            // Their proposing revision has no imported source, so they cannot be retracted here.
            const compact = await tx.query(
              `SELECT 1 FROM semantic.fact WHERE route = $1 AND subject_id = $2 AND statement_id = $3
             AND kind = 'statement' AND operation = 'assert' AND statement_id IS NOT NULL LIMIT 1`,
              [route, command.subject, command.candidate],
            );
            if (compact.rows.length) throw new EditorialConflictError();
            throw new SubjectNotFoundError();
          }
          const origin = proposed.rows[0].source;
          if (
            !origin ||
            origin.source !== source.source ||
            origin.external_id !== source.external_id ||
            origin.field_group !== source.field_group
          )
            throw new EditorialConflictError();
          const revision = subject.revision + 1;
          await tx.query(
            `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id, source)
           VALUES ($1, $2, $3, 'retract', $4, $5, $6)`,
            [route, command.subject, revision, options.release.digest, transactionId, source],
          );
          await updateSubjectRelease.run(tx, {
            route,
            subject_id: command.subject,
            release: options.release.digest,
          });
          await tx.query(
            `INSERT INTO semantic.retraction (route, subject_id, candidate_id, revision, "references") VALUES ($1, $2, $3, $4, $5)`,
            [route, command.subject, command.candidate, revision, JSON.stringify(command.references)],
          );
          await tx.query(
            `DELETE FROM semantic.source_candidate WHERE route = $1 AND subject_id = $2 AND source = $3
           AND external_id = $4 AND field_group = $5 AND candidate_id = $6`,
            [route, command.subject, source.source, source.external_id, source.field_group, command.candidate],
          );
          return {
            value: { status: 200, value: { revision } },
            events: [
              {
                type: SUBJECT_REVISED,
                subject: command.subject,
                data: { id: command.subject, revision, kind: 'retract' },
              },
              {
                type: 'com.rezics.statement.retracted.v1',
                subject: command.subject,
                data: { candidate: command.candidate, revision },
              },
            ],
          };
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23505' &&
            'constraint' in error &&
            [
              'external_claim_pkey',
              'source_candidate_pkey',
              'receipt_pkey',
              'revision_pkey',
              'candidate_pkey',
            ].includes(String(error.constraint))
          )
            error.code = '40001';
          throw error;
        }
      },
    );
    return {
      ...outcome.value,
      component: { partition: outcome.partition, epoch: outcome.epoch, position: outcome.position },
    };
  } catch (error) {
    if (error instanceof Resolved) {
      const outcome = error.outcome;
      return {
        ...outcome.value,
        component: { partition: outcome.partition, epoch: outcome.epoch, position: outcome.position },
      };
    }
    throw error;
  }
}
