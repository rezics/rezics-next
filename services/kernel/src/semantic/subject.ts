import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessCheck, AccountActor, Resource } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import { SubjectInputError } from './item.ts';
import { checkTyped } from './rules.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import createRevision from './create-revision.sql';
import insertFacts from './insert-facts.sql';
import insertSubject from './create-subject.sql';
import readLabelsStatement from './read-labels.sql';
import readSubjectStatement from './read-subject.sql';
import readTypesStatement from './read-item-types.sql';
import { readRelease as getRelease } from './definitions.ts';

export const CREATE_SUBJECT = 'subject.create';
const CONTEXT = GLOBAL_CONTEXT;
export const subjectParent = {
  resource: { route: 0, id: GLOBAL_CONTEXT },
  async validate(client: Pick<PoolClient, 'query'>) {
    const result = await client.query(
      "SELECT 1 FROM semantic.context WHERE route = 0 AND context_id = $1::uuid AND kind = 'global'",
      [GLOBAL_CONTEXT],
    );
    return result.rowCount === 1;
  },
};
export const subjectCreation = {
  async validate(tx: CommandTransaction, resource: Resource) {
    const result = await tx.query(
      `SELECT 1 FROM semantic.subject s
       JOIN semantic.revision r ON r.route = s.route AND r.subject_id = s.subject_id AND r.revision = 1
       WHERE s.route = $1 AND s.subject_id = $2::uuid
         AND s.recorded_transaction_id = r.recorded_transaction_id AND r.kind = 'create'`,
      [resource.route, resource.id],
    );
    return result.rowCount === 1;
  },
};

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
export type CreateSubjectResult = { subject: Item; component: SubjectComponent; replayed: boolean };

export async function createSubject(
  pool: Pool,
  options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    item: unknown;
    release: { digest: string; release: Release };
    authorize: AccessCheck;
    authorization?: CommandAuthorization;
    deadline?: number;
  },
): Promise<CreateSubjectResult> {
  const { route, id: subjectId } = options.target;
  if (routeOf(subjectId) !== route) throw new RangeError('Subject target id must carry its route');
  const input = options.item as Record<string, unknown>;
  let facts: FactRow[];
  let structural: SubjectInputError | undefined;
  try {
    facts = itemFacts(subjectId, options.item, typeof input?.type === 'string' ? input.type : undefined);
  } catch (error) {
    if (!(error instanceof SubjectInputError)) throw error;
    structural = error;
    facts = [];
  }
  const typed = checkTyped(options.release.release, options.release.digest, options.item);
  if (structural || typed.violations.length) {
    throw new SubjectInputError([...(structural?.violations ?? []), ...typed.violations]);
  }
  const dataTypes = Object.fromEntries(
    Object.entries(options.release.release.properties).map(([id, property]) => [id, property.datatype]),
  );
  const grouped = new Map<number, Set<string>>();
  for (const item of typed.items) {
    const itemRoute = routeOf(item.id);
    if (itemRoute === null) continue;
    const itemPartition = partitionOf(itemRoute);
    const ids = grouped.get(itemPartition) ?? new Set<string>();
    ids.add(item.id);
    grouped.set(itemPartition, ids);
  }
  const itemTypes = new Map<string, string>();
  await Promise.all(
    [...grouped].map(async ([partition_no, ids]) => {
      const rows = (await readTypesStatement.run(pool, { partition_no, subject_ids: [...ids] })) as {
        id: string;
        type: string;
      }[];
      for (const row of rows) itemTypes.set(row.id, row.type);
    }),
  );
  const targetErrors = typed.items.flatMap((item) => {
    const targetType = itemTypes.get(item.id);
    return targetType && item.targets.includes(targetType)
      ? []
      : [{ pointer: item.pointer, code: 'out_of_range' as const }];
  });
  if (targetErrors.length) throw new SubjectInputError(targetErrors);
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
      authorization: options.authorization ?? {
        action: 'subject:create',
        resource: options.target,
        denied: () => new SubjectAccessDeniedError(),
        async authorize(tx, attempt) {
          if (!(await options.authorize(tx, attempt.time))) throw new SubjectAccessDeniedError();
          return 'execute';
        },
      },
    },
    async (tx, { transactionId }) => {
      await insertSubject.run(tx, {
        route,
        subject_id: subjectId,
        type: String(input.type),
        transaction_id: transactionId,
      });
      await createRevision.run(tx, {
        route,
        subject_id: subjectId,
        release: options.release.digest,
        transaction_id: transactionId,
      });
      await insertFacts.run(tx, {
        route,
        subject_id: subjectId,
        transaction_id: transactionId,
        facts,
      });
      return {
        value: resolveItem(subjectId, facts, String(input.type), dataTypes, {
          revision: 1,
          release: options.release.digest,
          context: CONTEXT,
        }),
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
  type: string;
  revision: number;
  release: string;
  fact_revision: number | null;
  fact_release: string | null;
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
            fact_revision: row.fact_revision,
            fact_release: row.fact_release,
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
): Promise<{ subject: Item; component: SubjectComponent } | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const snapshot = await withConnection(pool, async (client) => {
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
        rows,
        component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
      };
    } catch (error) {
      return await rollback(client, error);
    }
  });
  if (!snapshot) return null;
  const { rows, component } = snapshot;
  const release = await getRelease(pool, rows[0]!.release);
  if (!release) throw new Error('Subject revision release is missing');
  const dataTypes = Object.fromEntries(
    Object.entries(release.properties).map(([property, definition]) => [property, definition.datatype]),
  );
  return {
    subject: resolveItem(id, asFacts(rows), rows[0]!.type, dataTypes, {
      revision: rows[0]!.revision,
      release: rows[0]!.release,
      context: CONTEXT,
    }),
    component,
  };
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
      })) as { id: string; labels: Record<string, string> }[];
      for (const row of rows) labels.set(row.id, row.labels);
    }),
  );
  return labels;
}
