import type { Pool, PoolClient } from 'pg';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor, Resource } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { itemFacts, resolveItem, type FactRow, type Item, type Statement } from './item.ts';
import insertFacts from './insert-facts.sql';
import insertSubject from './create-subject.sql';
import readLabelsStatement from './read-labels.sql';
import readSubjectStatement from './read-subject.sql';

export const CREATE_SUBJECT = 'subject.create';

/** Retries reach the partition holding their receipt while each attempt gets a new subject id. */
export function subjectTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource {
  const route = anchorRoute(routeKey, `${accountId}\n${CREATE_SUBJECT}\n${idempotencyKey}`);
  return { route, id: newId(route) };
}

export class SubjectAccessDeniedError extends Error {
  constructor() {
    super('Subject creation is not authorized');
    this.name = 'SubjectAccessDeniedError';
  }
}

export type SubjectComponent = { partition: number; epoch: number; position: bigint };
export type ResolvedItem = Item & {
  statements: Record<string, (Omit<Statement, 'id'> & { id: any })[]>;
};
export type CreateSubjectResult = { subject: ResolvedItem; component: SubjectComponent; replayed: boolean };

export async function createSubject(
  pool: Pool,
  options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    item: unknown;
    authorize: (tx: CommandTransaction) => Promise<boolean>;
    deadline?: number;
  },
): Promise<CreateSubjectResult> {
  const { route, id: subjectId } = options.target;
  if (routeOf(subjectId) !== route) throw new RangeError('Subject target id must carry its route');
  const facts = itemFacts(subjectId, options.item);
  const partition = partitionOf(route);
  const command = await runCommand(
    pool,
    {
      partition,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: CREATE_SUBJECT,
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
    },
    async (tx, { transactionId }) => {
      if (!(await options.authorize(tx))) throw new SubjectAccessDeniedError();
      await insertSubject.run(tx, { route, subject_id: subjectId, transaction_id: transactionId });
      await insertFacts.run(tx, {
        route,
        subject_id: subjectId,
        transaction_id: transactionId,
        facts,
      });
      return {
        value: resolveItem(subjectId, facts) as ResolvedItem,
        events: [{ type: 'com.rezics.subject.created.v1', subject: subjectId, data: { id: subjectId } }],
      };
    },
  );
  return {
    subject: command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

type SubjectReadRow = {
  id: string;
  slot_id: string | null;
  log_seq: number | null;
  operation: FactRow['operation'] | null;
  kind: FactRow['kind'] | null;
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};

function asFacts(rows: readonly SubjectReadRow[]): FactRow[] {
  return rows.flatMap((row) =>
    row.slot_id === null || row.log_seq === null || row.operation === null || row.kind === null
      ? []
      : [
          {
            slot_id: row.slot_id,
            log_seq: row.log_seq,
            operation: row.operation,
            kind: row.kind,
            language: row.language,
            property: row.property,
            statement_id: row.statement_id,
            body: row.body,
          },
        ],
  );
}

async function rollback(client: PoolClient, error: unknown): Promise<never> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    discardConnection(client, rollbackError as Error);
  }
  throw error;
}

export async function readSubject(
  pool: Pool,
  id: string,
  authorize: (client: PoolClient) => Promise<boolean>,
): Promise<{ subject: ResolvedItem; component: SubjectComponent } | null> {
  const route = routeOf(id);
  if (route === null) return null;
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300ms'");
      const partition = await readPartition(client, partitionOf(route));
      if (!partition) {
        await client.query('COMMIT');
        return null;
      }
      const rows = (await readSubjectStatement.run(client, { route, subject_id: id })) as SubjectReadRow[];
      if (!rows.length) {
        await client.query('COMMIT');
        return null;
      }
      const allowed = await authorize(client);
      await client.query('COMMIT');
      if (!allowed) return null;
      return {
        subject: resolveItem(id, asFacts(rows)) as ResolvedItem,
        component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
      };
    } catch (error) {
      return await rollback(client, error);
    }
  });
}

export async function readLabels(pool: Pool, ids: readonly string[]): Promise<Map<string, Item['labels']>> {
  const groups = new Map<number, Set<string>>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const subjectIds = groups.get(partition) ?? new Set<string>();
    subjectIds.add(id);
    groups.set(partition, subjectIds);
  }

  const labels = new Map<string, Item['labels']>();
  await Promise.all(
    [...groups].map(async ([partition_no, subjectIds]) => {
      const rows = (await readLabelsStatement.run(pool, {
        partition_no,
        subject_ids: [...subjectIds],
      })) as SubjectReadRow[];
      const bySubject = new Map<string, SubjectReadRow[]>();
      for (const row of rows) {
        const subjectRows = bySubject.get(row.id) ?? [];
        subjectRows.push(row);
        bySubject.set(row.id, subjectRows);
      }
      for (const [id, subjectRows] of bySubject) labels.set(id, resolveItem(id, asFacts(subjectRows)).labels);
    }),
  );
  return labels;
}
