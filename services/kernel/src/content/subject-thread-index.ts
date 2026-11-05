import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { runCommand, type CommandReceipt } from '../command/command.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS } from '../events/contracts/content.ts';
import upsert from './subject-thread-upsert.sql';

const sourceTypes = [
  'com.rezics.content.thread.created.v1',
  'com.rezics.content.post.created.v1',
  'com.rezics.content.revision.created.v1',
] as const;
const projected = 'com.rezics.content.subject-thread.projected.v1';
const projectorId = '00000000-0000-4000-8000-000000000001';
const maxPosition = 9_223_372_036_854_775_807n;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/;

type IndexEventData = Readonly<{
  threadId: string;
  itemId: string;
  revisionId: string;
  actorId: string;
  placeId: string;
  kind: 'discussion' | 'review';
  subjectIds: readonly string[];
  previousSubjectIds?: readonly string[];
  activityAt: string;
}>;

type Change = Readonly<{
  data: IndexEventData;
  threadRoute: number;
  epoch: number;
  position: bigint;
  previousSubjectIds: readonly string[];
}>;

class UnchangedSubjectThread extends Error {}

function requiredRoute(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Invalid routed subject thread identity');
  return value;
}

function parse(event: CloudEvent): Change {
  if (!sourceTypes.includes(event.type as (typeof sourceTypes)[number]))
    throw new TypeError('Unsupported subject thread source event');
  const type = event.type as (typeof sourceTypes)[number];
  if (!Value.Check(CONTENT_EVENTS[type], event.data)) throw new TypeError('Invalid subject thread source payload');
  const data = event.data as IndexEventData;
  const threadRoute = requiredRoute(data.threadId);
  const itemRoute = requiredRoute(data.itemId);
  const revisionRoute = requiredRoute(data.revisionId);
  const placeRoute = requiredRoute(data.placeId);
  const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  const sourcePartition = Number(source?.[1]);
  const epoch = Number(source?.[2]);
  if (
    !source ||
    sourcePartition < 0 ||
    sourcePartition > 4095 ||
    sourcePartition !== partitionOf(threadRoute) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    epoch > 2_147_483_647 ||
    !/^\d{19}$/.test(event.sequence) ||
    BigInt(event.sequence) <= 0n ||
    BigInt(event.sequence) > maxPosition ||
    (event.subject !== data.threadId && event.subject !== data.itemId) ||
    itemRoute !== threadRoute ||
    revisionRoute !== threadRoute ||
    placeRoute === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.id) ||
    !timestampPattern.test(data.activityAt) ||
    !Number.isFinite(Date.parse(data.activityAt)) ||
    data.subjectIds.some((id) => routeOf(id) === null) ||
    (data.previousSubjectIds ?? []).some((id) => routeOf(id) === null)
  )
    throw new TypeError('Invalid subject thread source envelope');

  return {
    data,
    threadRoute,
    epoch,
    position: BigInt(event.sequence),
    previousSubjectIds: data.previousSubjectIds ?? [],
  };
}

function subjectGroups(change: Change): Map<number, { current: string[]; previous: string[] }> {
  const groups = new Map<number, { current: string[]; previous: string[] }>();
  const add = (id: string, field: 'current' | 'previous') => {
    const group = partitionOf(requiredRoute(id));
    const current = groups.get(group) ?? { current: [], previous: [] };
    current[field].push(id);
    groups.set(group, current);
  };
  for (const id of change.data.subjectIds) add(id, 'current');
  for (const id of change.previousSubjectIds) add(id, 'previous');
  for (const group of groups.values()) {
    group.current = [...new Set(group.current)].sort();
    group.previous = [...new Set(group.previous)].sort();
  }
  return groups;
}

async function applyChange(pool: Pool, event: CloudEvent, change: Change): Promise<void> {
  const groups = subjectGroups(change);
  const identity = JSON.stringify([event.source, event.sequence, event.id, event.type, event.data]);
  for (const [partition, group] of [...groups].sort(([left], [right]) => left - right)) {
    const affected = [...group.current, ...group.previous].sort();
    const subjectId = affected[0];
    if (!subjectId) continue;
    const digest = createHash('sha256').update(`${identity}\n${partition}`).digest();
    const receipt: CommandReceipt = {
      actorAccountId: projectorId,
      kind: 'content.subject-thread.project',
      key: `${event.id}:${partition}`,
      digest,
    };
    // Keep one command per partition, with an explicit route binding for each statement.
    const updates = [...new Set(affected.map(requiredRoute))].map((route) => ({
      route,
      thread_route: change.threadRoute,
      thread_id: change.data.threadId,
      place_id: change.data.placeId,
      kind: change.data.kind,
      subject_ids: group.current.filter((id) => requiredRoute(id) === route),
      previous_subject_ids: group.previous.filter((id) => requiredRoute(id) === route),
      activity_at: change.data.activityAt,
      source_epoch: change.epoch,
      source_position: change.position.toString(),
    }));
    try {
      await runCommand(pool, { partition, receipt }, async (tx) => {
        let changed = 0;
        for (const parameters of updates) {
          const result = await tx.query<{ changed: string | number }>(
            upsert.sql,
            upsert.params.map((name) => parameters[name as keyof typeof parameters]),
          );
          changed += Number(result.rows[0]?.changed ?? 0);
        }
        if (changed === 0) throw new UnchangedSubjectThread();
        return {
          value: null,
          events: [
            {
              type: projected,
              subject: subjectId,
              data: {
                subjectId,
                threadId: change.data.threadId,
                sourceEpoch: change.epoch,
                sourcePosition: change.position.toString(),
              },
            },
          ],
        };
      });
    } catch (error) {
      if (!(error instanceof UnchangedSubjectThread)) throw error;
    }
  }
}

/** Projects each source event through one idempotent command per subject partition. */
export function createSubjectThreadEffect(pool: Pool): Effect {
  return {
    name: 'content_subject_thread',
    types: [...sourceTypes],
    async run(event) {
      await applyChange(pool, event, parse(event));
    },
  };
}
