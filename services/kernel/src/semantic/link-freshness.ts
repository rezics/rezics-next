import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { lookupEventType } from '../events/catalogue.ts';
import { BATCH_ENVELOPES } from '../events/log.ts';
import { LINKS_PROJECTED, SUBJECT_PAGE_WORK_COMMITTED } from './events.ts';
import { SEMANTIC_LOCATOR_ADVANCED } from './erasure-locator-receipt.ts';
import readMaintenance from './link-checkpoint-maintenance.sql';
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
const tracedCheckpoints = new Set<string>();

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

type Behind = NonNullable<Awaited<ReturnType<typeof readLinkCheckpoint.run>>>;

const completionEvents = [
  LINKS_PROJECTED,
  SUBJECT_PAGE_WORK_COMMITTED,
  SEMANTIC_LOCATOR_ADVANCED,
  'com.rezics.semantic.provider-review.projected.v1',
];

async function coversSubjectAnchor(client: PoolClient, behind: Behind, anchor: SessionComponent): Promise<boolean> {
  if (
    behind.partition_no !== anchor.partition ||
    behind.epoch !== anchor.epoch ||
    behind.checkpoint_epoch !== anchor.epoch ||
    behind.checkpoint_position === null
  )
    return false;
  const checkpoint = BigInt(behind.checkpoint_position);
  const span = anchor.position - checkpoint;
  if (checkpoint <= 0n || span <= 0n || span > BigInt(BATCH_ENVELOPES)) return false;

  const { rows } = await client.query<{ kind: string; payload: unknown }>(readMaintenance.sql, [
    anchor.partition,
    anchor.epoch,
    checkpoint.toString(),
    anchor.position.toString(),
    completionEvents,
  ]);
  return rows.length === Number(span) && rows.every(({ kind, payload }) => lookupEventType(kind)?.Check(payload));
}

function checkpointWaitReason(row: Behind, subject: string): SubjectLinkWaitReason {
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
  anchor?: SessionComponent,
): Promise<boolean> {
  const requirementsFor = (components: readonly SessionComponent[]) => ({
    consumer: LINKS_CONSUMER,
    observe_missing: observeMissing,
    partitions: components.map((component) => component.partition),
    epochs: components.map((component) => component.epoch),
    positions: components.map((component) => component.position),
  });
  const requirements = requirementsFor(anchor ? [...seen, anchor] : seen);
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
          let behind = requirements.partitions.length ? await readLinkCheckpoint.run(client, requirements) : null;
          // Only the detail reader supplies its authorized Subject home anchor. A positive link
          // checkpoint plus a complete suffix of already committed maintenance has no link work left.
          if (
            behind &&
            anchor &&
            anchor.partition === partitionOf(routeOf(subject)!) &&
            (await coversSubjectAnchor(client, behind, anchor))
          ) {
            const otherRequirements = requirementsFor(
              seen.filter((component) =>
                component.partition !== anchor.partition ||
                component.epoch !== anchor.epoch ||
                component.position > anchor.position
              ),
            );
            behind = otherRequirements.partitions.length
              ? await readLinkCheckpoint.run(client, otherRequirements)
              : null;
          }
          if (behind) {
            lastObservation = checkpointWaitReason(behind, subject);
            if (observeMissing && lastObservation === 'foreign-checkpoint-position') {
              const key = [behind.partition_no, behind.epoch, behind.checkpoint_position, behind.position].join('/');
              if (tracedCheckpoints.size < 12 && !tracedCheckpoints.has(key)) {
                tracedCheckpoints.add(key);
                const events = await client.query(
                  `SELECT position::text, type, event_seq, event_count
                    FROM core.outbox WHERE partition_no=$1 AND epoch=$2 AND position > $3 AND position <= $4
                    ORDER BY position, event_seq LIMIT 20`,
                  [behind.partition_no, behind.epoch, behind.checkpoint_position, behind.position],
                );
                console.error('Reviewed checkpoint trace ' + JSON.stringify({ key, subjectHome: anchor?.partition, events: events.rows }));
              }
            }
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
  anchor?: SessionComponent,
): Promise<boolean> {
  const started = Date.now();
  // Leave at least half of the remaining request budget for authorization and the read.
  const waitUntil = Math.min(started + FRESHNESS_WAIT_MS, started + (deadline - started) / 2);
  return linksCaughtUp(pool, seen, subject, waitUntil, members, yieldAdmission, observeWait, observeMissing, anchor);
}
