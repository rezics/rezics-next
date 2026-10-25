import type { Pool, PoolClient } from 'pg';
import { withConnection, discardConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { FactRow, Item } from './item.ts';
import pageSubjectsStatement from './page-subjects.sql';

export const LIST_SUBJECTS = 'subject.list';
export const PAGE_SIZE = { default: 25, max: 100 } as const;

export class PageCursorError extends Error {
  readonly reason: 'expired' | 'invalid' | 'stale';

  constructor(reason: 'expired' | 'invalid' | 'stale') {
    super(`Page cursor is ${reason}`);
    this.name = 'PageCursorError';
    this.reason = reason;
  }
}

export type PageComponent = { partition: number; epoch: number; position: bigint };
export type SubjectPage = {
  subjects: Pick<Item, 'id' | 'labels'>[];
  next: string | null;
  component: PageComponent;
};

type PageRow = {
  route: number;
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

type Queryable = Pool | PoolClient;

async function rollback(client: PoolClient, error: unknown): Promise<never> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    discardConnection(client, rollbackError as Error);
  }
  throw error;
}

function isCanonicalSubjectId(id: unknown): id is string {
  return typeof id === 'string' && routeOf(id) !== null;
}

function facts(rows: readonly PageRow[]): FactRow[] {
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

function readRows(
  client: Queryable,
  parameters: {
    partition_no: number;
    after_route: number;
    after_id: string;
    limit: number;
  },
): Promise<PageRow[]> {
  return pageSubjectsStatement.run(client, parameters) as Promise<PageRow[]>;
}

export async function pageSubjects(
  pool: Pool,
  ring: KeyRing,
  options: { partition: number; size?: number; cursor?: string },
): Promise<SubjectPage | null> {
  const { partition } = options;
  const size = options.size ?? PAGE_SIZE.default;
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096)
    throw new RangeError('Partition must be an integer from 0 to 4095');
  if (!Number.isInteger(size) || size < 1 || size > PAGE_SIZE.max)
    throw new RangeError(`Page size must be an integer from 1 to ${PAGE_SIZE.max}`);

  const binding: CursorBinding = { operation: LIST_SUBJECTS, parameters: { partition } };
  let afterRoute = partition * 16;
  let afterId = '00000000-0000-0000-0000-000000000000';
  let cursorEpoch: number | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor);
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    const [route, id] = decoded.after;
    if (
      decoded.after.length !== 2 ||
      typeof route !== 'number' ||
      !Number.isInteger(route) ||
      route < partition * 16 ||
      route >= (partition + 1) * 16 ||
      !isCanonicalSubjectId(id) ||
      routeOf(id) !== route ||
      partitionOf(route) !== partition
    )
      throw new PageCursorError('invalid');
    afterRoute = route;
    afterId = id;
    cursorEpoch = decoded.epoch;
  }

  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300ms'");
      const partitionState = await readPartition(client, partition);
      if (!partitionState) {
        await client.query('COMMIT');
        return null;
      }
      if (cursorEpoch !== null && cursorEpoch !== partitionState.epoch) throw new PageCursorError('stale');

      const rows = await readRows(client, {
        partition_no: partition,
        after_route: afterRoute,
        after_id: afterId,
        limit: size + 1,
      });
      await client.query('COMMIT');

      const subjectRows = new Map<string, PageRow[]>();
      for (const row of rows) {
        const grouped = subjectRows.get(row.id) ?? [];
        grouped.push(row);
        subjectRows.set(row.id, grouped);
      }
      const groups = [...subjectRows.values()];
      const hasMore = groups.length > size;
      const shown = groups.slice(0, size);
      const subjects = shown.map((group) => ({
        id: group[0]!.id,
        labels: Object.fromEntries(
          facts(group)
            .filter((fact) => fact.kind === 'label' && fact.operation === 'assert')
            .map((fact) => [fact.language!, fact.body as string]),
        ),
      }));
      const last = shown.at(-1)?.[0];
      const next =
        hasMore && last
          ? encodeCursor(ring, binding, { epoch: partitionState.epoch, after: [last.route, last.id] })
          : null;
      return {
        subjects,
        next,
        component: {
          partition: partitionState.partitionNo,
          epoch: partitionState.epoch,
          position: partitionState.position,
        },
      };
    } catch (error) {
      return await rollback(client, error);
    }
  });
}
