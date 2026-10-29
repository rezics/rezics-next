import type { Pool } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { SessionComponent } from '../tokens/session.ts';
import readLinkCheckpoint from './read-link-checkpoint.sql';
import readPendingMember from './links-read-pending-member.sql';
import readProjectionPending from './merge-read-projection-pending.sql';
import { withReadTransaction } from './read.ts';

export const FRESHNESS_WAIT_MS = 2_000;
export const FRESHNESS_POLL_MS = 100;
const LINKS_CONSUMER = 'semantic_links';

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

export async function pendingMergeSources(pool: Pool, members: readonly string[]): Promise<string[]> {
  const groups = new Map<number, string[]>();
  for (const id of new Set(members)) {
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(id);
    groups.set(partition, group);
  }
  const pending: string[] = [];
  for (const [partition, group] of groups) {
    const found = await withReadTransaction(pool, async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      return readProjectionPending.run(client, { partition_no: partition, members: group });
    });
    pending.push(...found.map((row) => row.member_id));
  }
  return pending;
}

export async function linksCaughtUp(
  pool: Pool,
  seen: readonly SessionComponent[],
  subject: string,
  deadline = deadlineFor(FRESHNESS_WAIT_MS),
  members: readonly string[] = [],
): Promise<boolean> {
  while (Date.now() < deadline) {
    const covered = await withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await client.query('SET LOCAL enable_seqscan = off');
        let caughtUp = true;
        for (const component of seen) {
          const row = await readLinkCheckpoint.run(client, {
            partition_no: component.partition,
            consumer: LINKS_CONSUMER,
          });
          if (!covers(row, component)) {
            caughtUp = false;
            break;
          }
        }
        if (caughtUp) {
          const pending = await readPendingMember.run(client, { route: routeOf(subject)!, subject_id: subject });
          caughtUp = pending === null;
        }
        await client.query('COMMIT');
        return caughtUp;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(client, rollbackError as Error);
        }
        throw error;
      }
    });
    const pendingMembers = covered && members.length ? await pendingMergeSources(pool, members) : [];
    if (covered && pendingMembers.length === 0) return true;
    if (deadline - Date.now() < FRESHNESS_POLL_MS) return false;
    await sleep(FRESHNESS_POLL_MS);
  }
  return false;
}

export function waitForSubjectLinks(
  pool: Pool,
  seen: readonly SessionComponent[],
  subject: string,
  deadline: number,
  members: readonly string[] = [],
): Promise<boolean> {
  const started = Date.now();
  // Leave at least half of the remaining request budget for authorization and the read.
  const waitUntil = Math.min(started + FRESHNESS_WAIT_MS, started + (deadline - started) / 2);
  return linksCaughtUp(pool, seen, subject, waitUntil, members);
}
