import type { Pool } from 'pg';
import { AccessUnavailableError } from '../access/unavailable.ts';
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
type YieldAdmission = <T>(wait: () => Promise<T>) => Promise<T>;

export async function pendingMergeSources(
  pool: Pool,
  members: readonly string[],
  deadline = deadlineFor(FRESHNESS_WAIT_MS),
): Promise<string[]> {
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
    const found = await withReadTransaction(
      pool,
      async (client) => readProjectionPending.run(client, { partition_no: partition, members: group }),
      deadline,
    );
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
  yieldAdmission?: YieldAdmission,
): Promise<boolean> {
  const requirements = {
    consumer: LINKS_CONSUMER,
    partitions: seen.map((component) => component.partition),
    epochs: seen.map((component) => component.epoch),
    positions: seen.map((component) => component.position),
  };
  const trace = process.env.REZICS_WALK_IMPORT_CATALOGUE === '1';
  let lastObservation = 'deadline';
  const unfinished = () => {
    if (trace) console.warn(`Semantic links wait home=${partitionOf(routeOf(subject)!)} ${lastObservation}`);
    return false;
  };
  try {
    while (Date.now() < deadline) {
      const covered = await withReadTransaction(
        pool,
        async (client) => {
          const behind = seen.length ? await readLinkCheckpoint.run(client, requirements) : null;
          if (behind) {
            if (trace)
              lastObservation =
                `partition=${behind.partition_no} required=${behind.epoch}/${behind.position} ` +
                `checkpoint=${behind.checkpoint_epoch ?? 'none'}/${behind.checkpoint_position ?? 'none'}`;
            return false;
          }
          const pending = await readPendingMember.run(client, { route: routeOf(subject)!, subject_id: subject });
          if (trace) lastObservation = pending === null ? 'deadline' : 'merge';
          return pending === null;
        },
        deadline,
      );
      const pendingMembers = covered && members.length ? await pendingMergeSources(pool, members, deadline) : [];
      if (covered && pendingMembers.length === 0) return true;
      if (pendingMembers.length && trace) lastObservation = 'merge';
      if (deadline - Date.now() < FRESHNESS_POLL_MS) return unfinished();
      // The database connection is released before this wait; yield the request's admission permit too.
      await (yieldAdmission ? yieldAdmission(() => sleep(FRESHNESS_POLL_MS)) : sleep(FRESHNESS_POLL_MS));
    }
    return unfinished();
  } catch (error) {
    if (error instanceof AccessUnavailableError && error.reason === 'deadline') return unfinished();
    throw error;
  }
}

export function waitForSubjectLinks(
  pool: Pool,
  seen: readonly SessionComponent[],
  subject: string,
  deadline: number,
  members: readonly string[] = [],
  yieldAdmission?: YieldAdmission,
): Promise<boolean> {
  const started = Date.now();
  // Leave at least half of the remaining request budget for authorization and the read.
  const waitUntil = Math.min(started + FRESHNESS_WAIT_MS, started + (deadline - started) / 2);
  return linksCaughtUp(pool, seen, subject, waitUntil, members, yieldAdmission);
}
