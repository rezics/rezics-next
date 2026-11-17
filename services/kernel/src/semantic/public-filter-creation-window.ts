import type { Pool } from 'pg';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';

/** A finite original outbox interval. This is retained inside the existing
 * immutable Source repair-step state, never supplied by a public caller.
 */
export type PublicFilterCreationWindow = Readonly<{
  partition: number;
  epoch: number;
  receipt: string;
  base: bigint;
  through: bigint;
  position: bigint;
  sequence: number;
  eventCount: number | null;
}>;

type NativeWindow = {
  epoch: number;
  head: string;
  base: string;
  receipt: string;
};

function validWindow(w: PublicFilterCreationWindow): boolean {
  return (
    Number.isInteger(w.partition) &&
    w.partition >= 0 &&
    w.partition < 4096 &&
    Number.isInteger(w.epoch) &&
    w.epoch > 0 &&
    /^[0-9a-f]{64}$/.test(w.receipt) &&
    typeof w.base === 'bigint' &&
    w.base >= 0n &&
    typeof w.through === 'bigint' &&
    w.through >= w.base &&
    typeof w.position === 'bigint' &&
    w.position >= w.base + 1n &&
    w.position <= w.through + 1n &&
    Number.isSafeInteger(w.sequence) &&
    w.sequence >= 0 &&
    (w.eventCount === null || (Number.isSafeInteger(w.eventCount) && w.eventCount > w.sequence)) &&
    (w.sequence === 0) === (w.eventCount === null) &&
    (w.position <= w.through || w.sequence === 0)
  );
}

/** The baseline receipt and its still-retained pin are resolved by native keys.
 * Capturing through does not extend the original baseline or any served cut.
 */
export async function readPublicFilterCreationWindow(
  pool: Pool,
  input: Readonly<{ bootstrap: string; partition: number }>,
  context: Readonly<{ deadline: number }>,
  retained?: PublicFilterCreationWindow,
): Promise<PublicFilterCreationWindow> {
  requireAccessDeadline(context.deadline);
  const consumer = publicFilterCreationConsumer(input.bootstrap);
  if (!Number.isInteger(input.partition) || input.partition < 0 || input.partition > 4095)
    throw new TypeError('Creation windows require one exact native home');
  const row = (
    await pool.query<NativeWindow>(
      `SELECT p.epoch,p.position::text AS head,e.creation_position::text AS base,e.receipt
     FROM semantic.public_filter_home_enrollment e
     JOIN core.partition p ON p.partition_no=e.partition_no
     JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
     WHERE (e.partition_no,e.bootstrap)=($1,$2) AND e.complete AND e.receipt IS NOT NULL
       AND e.creation_consumer=$3 AND p.write_state='active' AND p.epoch=e.owner_epoch
       AND c.position<=e.creation_position AND (c.epoch IS NULL OR c.epoch=p.epoch)`,
      [input.partition, input.bootstrap, consumer],
    )
  ).rows[0];
  if (!row) throw new CommandUnavailableError('contention', input.partition);
  const base = BigInt(row.base),
    head = BigInt(row.head);
  if (head < base) throw new CommandUnavailableError('contention', input.partition);
  if (retained) {
    if (
      !validWindow(retained) ||
      retained.partition !== input.partition ||
      retained.epoch !== row.epoch ||
      retained.receipt !== row.receipt ||
      retained.base !== base ||
      retained.through < base ||
      retained.through > head ||
      retained.position < base + 1n
    )
      throw new CommandUnavailableError('contention', input.partition);
    return retained;
  }
  return Object.freeze({
    partition: input.partition,
    epoch: row.epoch,
    receipt: row.receipt,
    base,
    through: head,
    position: base + 1n,
    sequence: 0,
    eventCount: null,
  });
}

/** One exact (home, position, event_seq) point. Every event, including unrelated
 * events, advances the retained frontier. A pruned position or partial event
 * group is unknown; LIMIT/empty output cannot establish exhaustion.
 */
export async function readPublicFilterCreationEvent(
  pool: Pool,
  input: Readonly<{ bootstrap: string; window: PublicFilterCreationWindow }>,
  context: Readonly<{ deadline: number }>,
): Promise<
  Readonly<{
    event: Readonly<{ type: string; subject: string | null }> | null;
    next: PublicFilterCreationWindow;
  }>
> {
  requireAccessDeadline(context.deadline);
  const w = input.window;
  if (!validWindow(w)) throw new TypeError('Invalid original creation window');
  if (w.position > w.through) {
    await readPublicFilterCreationWindow(pool, { bootstrap: input.bootstrap, partition: w.partition }, context, w);
    return { event: null, next: w };
  }
  const row = (
    await pool.query<{
      owner_epoch: number;
      base: string;
      receipt: string;
      head: string;
      epoch: number | null;
      event_count: number | null;
      type: string | null;
      subject: string | null;
    }>(
      `SELECT p.epoch AS owner_epoch,e.creation_position::text AS base,e.receipt,p.position::text AS head,
       o.epoch,o.event_count,o.type,o.subject
     FROM semantic.public_filter_home_enrollment e
     JOIN core.partition p ON p.partition_no=e.partition_no
     JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
     LEFT JOIN core.outbox o ON (o.partition_no,o.position,o.event_seq)=($1,$4::bigint,$5)
     WHERE (e.partition_no,e.bootstrap)=($1,$2) AND e.complete AND e.receipt=$6
       AND e.creation_consumer=$3 AND p.write_state='active' AND p.epoch=e.owner_epoch
       AND c.position<=e.creation_position AND (c.epoch IS NULL OR c.epoch=p.epoch)`,
      [
        w.partition,
        input.bootstrap,
        publicFilterCreationConsumer(input.bootstrap),
        String(w.position),
        w.sequence,
        w.receipt,
      ],
    )
  ).rows[0];
  if (
    !row ||
    row.owner_epoch !== w.epoch ||
    BigInt(row.base) !== w.base ||
    BigInt(row.head) < w.through ||
    row.epoch !== w.epoch ||
    row.type === null ||
    row.event_count === null ||
    row.event_count <= w.sequence ||
    (w.eventCount !== null && row.event_count !== w.eventCount)
  )
    throw new CommandUnavailableError('contention', w.partition);
  return { event: { type: row.type, subject: row.subject }, next: creationEventSuccessor(w, row.event_count) };
}

function creationEventSuccessor(w: PublicFilterCreationWindow, count: number): PublicFilterCreationWindow {
  const last = w.sequence + 1 === count;
  return Object.freeze({
    ...w,
    position: last ? w.position + 1n : w.position,
    sequence: last ? 0 : w.sequence + 1,
    eventCount: last ? null : count,
  });
}

const subjectPrefix = 'com.rezics.subject.';
const statementPrefix = 'com.rezics.statement.';
const accountEvents = [
  'com.rezics.access.account-updated.v1',
  'com.rezics.access.account-tombstoned.v1',
  'com.rezics.access.account-discovery-changed.v1',
];

export function publicFilterCreationAction(type: string, accounts: boolean): 'semantic' | 'accounts' | null {
  if (type.startsWith(subjectPrefix) || type.startsWith(statementPrefix)) return 'semantic';
  return accounts && accountEvents.includes(type) ? 'accounts' : null;
}

type CreationEvent = Readonly<{
  position: string;
  event_seq: number;
  event_count: number;
  epoch: number;
  id: string;
  type: string;
  subject: string | null;
}>;

type Meter = { inputKeys: number; rows: number; dependencyPoints: number };

/** Walk exact original event keys in one snapshot, stopping at the first repair action.
 * Replay caps the read at the original event count and validates the same envelopes.
 */
export async function readPublicFilterCreationEvents(
  pool: Pool,
  input: Readonly<{
    bootstrap: string;
    window: PublicFilterCreationWindow;
    accounts: boolean;
    inputLimit: number;
    retainedCount?: number;
  }>,
  context: Readonly<{ deadline: number }>,
  cost: Meter,
) {
  requireAccessDeadline(context.deadline);
  const w = input.window;
  const limit = input.retainedCount ?? input.inputLimit;
  if (!validWindow(w) || w.position > w.through || !Number.isInteger(limit) || limit < 1 || limit > input.inputLimit)
    throw new TypeError('Invalid creation event range');

  const charge = (points: number) => {
    cost.inputKeys += points;
    cost.rows += points;
    cost.dependencyPoints += points;
  };
  charge(3 + limit);
  const { rows } = await pool.query<CreationEvent>(
    `/* semantic.native-keyed:0:0 */
     WITH RECURSIVE events AS (
       SELECT 0 AS ordinal,$4::bigint AS next_position,$5::integer AS next_seq,false AS repair,
              NULL::bigint AS position,NULL::integer AS event_seq,NULL::integer AS event_count,
              NULL::integer AS epoch,NULL::uuid AS id,NULL::text AS type,NULL::text AS subject
       FROM semantic.public_filter_home_enrollment e
       JOIN core.partition p ON p.partition_no=e.partition_no
       JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
       WHERE (e.partition_no,e.bootstrap)=($1,$2) AND e.complete AND e.receipt=$6
         AND e.creation_consumer=$3 AND p.write_state='active' AND p.epoch=e.owner_epoch
         AND c.position<=e.creation_position AND (c.epoch IS NULL OR c.epoch=p.epoch)
         AND p.epoch=$7 AND e.creation_position=$8 AND p.position>=$9
       UNION ALL
       SELECT e.ordinal+1,
              CASE WHEN o.event_seq+1<o.event_count THEN o.position
                   WHEN o.position<$9 THEN o.position+1 END,
              CASE WHEN o.event_seq+1=o.event_count THEN 0 ELSE o.event_seq+1 END,
              starts_with(o.type,$11) OR starts_with(o.type,$12) OR o.type=ANY($13::text[]),
              o.position,o.event_seq,o.event_count,o.epoch,o.id,o.type,o.subject
       FROM events e
       JOIN LATERAL (
         SELECT o.position,o.event_seq,o.event_count,o.epoch,o.id,o.type,o.subject
         FROM core.outbox o
         WHERE (o.partition_no,o.position,o.event_seq)=($1,e.next_position,e.next_seq)
         LIMIT 1
       ) o ON true
       WHERE e.ordinal<$10 AND e.next_position<=$9 AND NOT e.repair
     )
     SELECT position::text,event_seq,event_count,epoch,id,type,subject
     FROM events WHERE ordinal>0 ORDER BY ordinal`,
    [
      w.partition,
      input.bootstrap,
      publicFilterCreationConsumer(input.bootstrap),
      String(w.position),
      w.sequence,
      w.receipt,
      w.epoch,
      String(w.base),
      String(w.through),
      limit,
      subjectPrefix,
      statementPrefix,
      input.accounts ? accountEvents : [],
    ],
  );

  let next = w;
  let action: ReturnType<typeof publicFilterCreationAction> = null;
  for (const row of rows) {
    if (
      action !== null ||
      next.position > w.through ||
      BigInt(row.position) !== next.position ||
      row.event_seq !== next.sequence ||
      row.epoch !== w.epoch ||
      row.event_count <= next.sequence ||
      (next.eventCount !== null && row.event_count !== next.eventCount)
    )
      throw new CommandUnavailableError('contention', w.partition);
    next = creationEventSuccessor(next, row.event_count);
    action = publicFilterCreationAction(row.type, input.accounts);
  }
  const event = rows.at(-1);
  if (
    !event ||
    rows.length > limit ||
    (input.retainedCount !== undefined && rows.length !== input.retainedCount) ||
    (rows.length < input.inputLimit && action === null && next.position <= w.through)
  )
    throw new CommandUnavailableError('contention', w.partition);
  charge(rows.length - limit);
  return { event, next, envelopes: rows };
}
