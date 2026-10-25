import type { Pool, PoolClient } from 'pg';
import { runCommand } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { projectBatch, type Envelope } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorKey } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SessionComponent } from '../tokens/session.ts';
import { SubjectNotFoundError } from './candidates.ts';
import { LINKS_CHANGED, LINKS_PROJECTED } from './events.ts';
import listInboundLinksByProperty from './list-inbound-links-by-property.sql';
import listInboundLinks from './list-inbound-links.sql';
import { PageCursorError } from './page.ts';
import readLinkCheckpoint from './read-link-checkpoint.sql';
import subjectExists from './subject-exists.sql';
import upsertInboundLinks from './upsert-inbound-links.sql';

export const LINKS_CONSUMER = 'semantic_links';
const FRESHNESS_TARGET_SECONDS = 10;
const FRESHNESS_WAIT_MS = 2_000;
const FRESHNESS_POLL_MS = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type LinkChangeRow = { property: string; statement: string; target: string; present: boolean };
type LinksChanged = { subject: string; revision: number; changes: LinkChangeRow[] };
type StoredChange = {
  route: number;
  subjectId: string;
  property: string;
  sourceSubjectId: string;
  statementId: string;
  sourceRevision: number;
  present: boolean;
  position: bigint;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function covers(
  row: { epoch: number | null; position: string | number | bigint } | null,
  component: SessionComponent,
): boolean {
  if (!row || row.epoch === null) return false;
  const epoch = typeof row.epoch === 'number' ? row.epoch : Number(row.epoch);
  const position = typeof row.position === 'bigint' ? row.position : BigInt(row.position);
  return epoch > component.epoch || (epoch === component.epoch && position >= component.position);
}

async function linksCaughtUp(pool: Pool, seen: readonly SessionComponent[]): Promise<boolean> {
  if (seen.length === 0) return true;
  const deadline = performance.now() + FRESHNESS_WAIT_MS;
  for (;;) {
    const covered = await withConnection(pool, async (client) => {
      for (const component of seen) {
        const row = await readLinkCheckpoint.run(client, {
          partition_no: component.partition,
          consumer: LINKS_CONSUMER,
        });
        if (!covers(row, component)) return false;
      }
      return true;
    });
    if (covered) return true;
    if (performance.now() + FRESHNESS_POLL_MS > deadline) return false;
    await sleep(FRESHNESS_POLL_MS);
  }
}

function newestChanges(envelopes: readonly Envelope[]): Map<number, StoredChange[]> {
  const newest = new Map<string, StoredChange>();
  for (const envelope of envelopes) {
    for (const event of envelope.events) {
      if (event.type !== LINKS_CHANGED) continue;
      const data = event.data as LinksChanged;
      for (const change of data.changes) {
        const route = routeOf(change.target);
        if (route === null) continue;
        const key = `${route}\0${change.target}\0${change.property}\0${data.subject}\0${change.statement}`;
        const current = newest.get(key);
        if (
          current &&
          (data.revision < current.sourceRevision ||
            (data.revision === current.sourceRevision && envelope.position < current.position))
        ) {
          continue;
        }
        newest.set(key, {
          route,
          subjectId: change.target,
          property: change.property,
          sourceSubjectId: data.subject,
          statementId: change.statement,
          sourceRevision: data.revision,
          present: change.present,
          position: envelope.position,
        });
      }
    }
  }
  const grouped = new Map<number, StoredChange[]>();
  for (const change of newest.values()) {
    const partition = partitionOf(change.route);
    const list = grouped.get(partition) ?? [];
    list.push(change);
    grouped.set(partition, list);
  }
  return grouped;
}

async function applyLinkBatch(pool: Pool, envelopes: readonly Envelope[]): Promise<void> {
  const grouped = newestChanges(envelopes);
  for (const partition of [...grouped.keys()].sort((left, right) => left - right)) {
    const changes = grouped.get(partition)!;
    const subjects = [...new Set(changes.map((change) => change.subjectId))].sort();
    await runCommand(pool, { partition }, async (tx, { transactionId }) => {
      await upsertInboundLinks.run(tx, {
        transaction_id: transactionId,
        changes: changes.map((change) => ({
          route: change.route,
          subject_id: change.subjectId,
          property: change.property,
          source_subject_id: change.sourceSubjectId,
          statement_id: change.statementId,
          source_revision: change.sourceRevision,
          present: change.present,
        })),
      });
      return { value: null, events: [{ type: LINKS_PROJECTED, data: { subjects } }] };
    });
  }
}

export function linkProjection(pool: Pool): Relay {
  return {
    consumer: LINKS_CONSUMER,
    run: (partition) =>
      projectBatch(pool, {
        consumer: LINKS_CONSUMER,
        partition,
        apply: (envelopes) => applyLinkBatch(pool, envelopes),
      }),
  };
}

export type SubjectLink = { subject: string; property: string; statement: string };
export type SubjectLinksPage = {
  links: SubjectLink[];
  freshness: { consistency: 'eventual'; target_seconds: 10; caught_up: boolean };
  next: string | null;
  component: { partition: number; epoch: number; position: bigint };
};

function validAfter(after: CursorKey[], property: string | null): boolean {
  if (after.length !== 3) return false;
  const [cursorProperty, source, statement] = after;
  if (typeof cursorProperty !== 'string' || cursorProperty.length < 1) return false;
  if (typeof source !== 'string' || typeof statement !== 'string') return false;
  if (!UUID.test(source) || !UUID.test(statement)) return false;
  return property === null || cursorProperty === property;
}

export async function listSubjectLinks(
  pool: Pool,
  ring: KeyRing,
  options: {
    subject: string;
    property: string | null;
    limit: number;
    cursor?: string;
    authorize: (client: PoolClient) => Promise<boolean>;
    seen: readonly SessionComponent[];
  },
): Promise<SubjectLinksPage> {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  const binding = {
    operation: 'subject.links',
    parameters: { subject: options.subject, property: options.property },
  };
  let cursor: { epoch: number; after: CursorKey[] } | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor);
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    if (!validAfter(decoded.after, options.property)) throw new PageCursorError('invalid');
    cursor = decoded;
  }
  const caughtUp = await linksCaughtUp(pool, options.seen);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300ms'");
      const partition = await readPartition(client, partitionOf(route));
      const exists = await subjectExists.run(client, { route, subject_id: options.subject });
      if (!partition || exists === null || !(await options.authorize(client))) throw new SubjectNotFoundError();
      if (cursor && cursor.epoch !== partition.epoch) throw new PageCursorError('stale');
      const afterSource = typeof cursor?.after[1] === 'string' ? cursor.after[1] : NIL_UUID;
      const afterStatement = typeof cursor?.after[2] === 'string' ? cursor.after[2] : NIL_UUID;
      const rows =
        options.property === null
          ? await listInboundLinks.run(client, {
              route,
              subject_id: options.subject,
              after_property: typeof cursor?.after[0] === 'string' ? cursor.after[0] : '',
              after_source: afterSource,
              after_statement: afterStatement,
              page_limit: options.limit + 1,
            })
          : await listInboundLinksByProperty.run(client, {
              route,
              subject_id: options.subject,
              property: options.property,
              after_source: afterSource,
              after_statement: afterStatement,
              page_limit: options.limit + 1,
            });
      const links = rows.slice(0, options.limit);
      const last = links.at(-1);
      await client.query('COMMIT');
      return {
        links,
        freshness: {
          consistency: 'eventual',
          target_seconds: FRESHNESS_TARGET_SECONDS,
          caught_up: caughtUp,
        },
        next:
          rows.length > options.limit && last
            ? encodeCursor(ring, binding, {
                epoch: partition.epoch,
                after: [last.property, last.subject, last.statement],
              })
            : null,
        component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}
