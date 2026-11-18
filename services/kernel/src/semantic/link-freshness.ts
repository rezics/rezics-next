import type { Pool } from 'pg';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { MissingCheckpointOwner, SubjectLinkWaitReason } from './contract/subject-errors.ts';
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

function checkpointWaitReason(
  row: NonNullable<Awaited<ReturnType<typeof readLinkCheckpoint.run>>>,
  subject: string,
): SubjectLinkWaitReason {
  const home = row.partition_no === partitionOf(routeOf(subject)!) ? 'local' : 'foreign';
  if (row.checkpoint_epoch === null && String(row.position) === '0') return `${home}-checkpoint-zero-position`;
  if (home === 'foreign' && row.first_present !== null && row.checkpoint_position === null) {
    let owner: MissingCheckpointOwner;
    if (row.owner_state === null) owner = 'absent';
    else if (row.owner_state !== 'active') owner = 'inactive';
    else if (row.owner_epoch !== row.epoch) owner = 'epoch';
    else if (String(row.owner_position) === '0') owner = 'empty';
    else owner = row.owner_behind ? 'behind' : 'covers';
    const source = row.partition_no === 0 ? 'global' : 'nonroot';
    const first = row.first_present ? 'present' : 'absent';
    const scan = row.scan_since_first === null
      ? (row.scan_recorded ? 'recorded' : 'unseen')
      : (row.scan_since_first ? 'since-first' : 'before-first');
    const effects = row.effects_covers ? 'covers' : row.effects_registered ? 'behind' : 'absent';
    return `foreign-checkpoint-missing/${source}/required-positive/owner-${owner}/first-${first}/scan-${scan}/effects-${effects}`;
  }
  if (row.checkpoint_position === null) return `${home}-checkpoint-missing`;
  if (row.checkpoint_epoch === null) return `${home}-checkpoint-uninitialized`;
  if (row.checkpoint_epoch !== row.epoch) return `${home}-checkpoint-epoch`;
  return `${home}-checkpoint-position`;
}

export async function linksCaughtUp(
  pool: Pool,
  seen: readonly SessionComponent[],
  subject: string,
  deadline = deadlineFor(FRESHNESS_WAIT_MS),
  members: readonly string[] = [],
  yieldAdmission?: YieldAdmission,
  observeWait?: (reason: SubjectLinkWaitReason) => void,
  observeMissing = false,
): Promise<boolean> {
  const requirements = {
    consumer: LINKS_CONSUMER,
    observe_missing: observeMissing,
    partitions: seen.map((component) => component.partition),
    epochs: seen.map((component) => component.epoch),
    positions: seen.map((component) => component.position),
  };
  let lastObservation: SubjectLinkWaitReason = 'deadline';
  const unfinished = () => {
    observeWait?.(lastObservation);
    return false;
  };
  try {
    while (Date.now() < deadline) {
      const covered = await withReadTransaction(
        pool,
        async (client) => {
          lastObservation = 'checkpoint-deadline';
          const behind = seen.length ? await readLinkCheckpoint.run(client, requirements) : null;
          if (behind) {
            lastObservation = checkpointWaitReason(behind, subject);
            return false;
          }
          lastObservation = 'merge-deadline';
          const pending = await readPendingMember.run(client, { route: routeOf(subject)!, subject_id: subject });
          lastObservation = pending === null ? 'deadline' : 'merge';
          return pending === null;
        },
        deadline,
      );
      const pendingMembers = covered && members.length ? await pendingMergeSources(pool, members, deadline) : [];
      if (covered && pendingMembers.length === 0) return true;
      if (pendingMembers.length) lastObservation = 'merge';
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
  observeWait?: (reason: SubjectLinkWaitReason) => void,
  observeMissing = false,
): Promise<boolean> {
  const started = Date.now();
  // Leave at least half of the remaining request budget for authorization and the read.
  const waitUntil = Math.min(started + FRESHNESS_WAIT_MS, started + (deadline - started) / 2);
  return linksCaughtUp(pool, seen, subject, waitUntil, members, yieldAdmission, observeWait, observeMissing);
}
