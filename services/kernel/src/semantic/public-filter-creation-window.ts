import type { PoolClient } from 'pg';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';

type CreationReader = Pick<PoolClient, 'query'>;

/** A finite original outbox interval. This is retained inside the existing
 * immutable Source repair-step state, never supplied by a public caller.
 */
export type PublicFilterCreationWindow = Readonly<{
  partition: number;
  epoch: number;
  receipt: string;
  heldBirth?: string;
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
    (w.heldBirth === undefined || /^[1-9][0-9]{0,18}$/.test(w.heldBirth)) &&
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

// All three readers re-open the original authority in the event statement's
// snapshot. The third parameter is the retained protocol's own identity.
function creationAuthority(heldBirth: string | undefined) {
  return heldBirth !== undefined
    ? `SELECT epoch,command_head AS head,command_base AS base,receipt
       FROM semantic.subject_access_cut_v1($2::uuid,$1::integer) WHERE birth=$3::bigint`
    : `SELECT p.epoch,p.position AS head,e.creation_position AS base,e.receipt
       FROM semantic.public_filter_home_enrollment e
       JOIN core.partition p ON p.partition_no=e.partition_no
       JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
       WHERE (e.partition_no,e.bootstrap)=($1,$2) AND e.complete AND e.receipt IS NOT NULL
         AND e.creation_consumer=$3 AND p.write_state='active' AND p.epoch=e.owner_epoch
         AND c.position<=e.creation_position AND (c.epoch IS NULL OR c.epoch=p.epoch)`;
}

/** The baseline receipt and its still-retained pin are resolved by native keys.
 * Capturing through does not extend the original baseline or any served cut.
 */
export async function readPublicFilterCreationWindow(
  pool: CreationReader,
  input: Readonly<{ bootstrap: string; partition: number; heldBirth?: string | undefined }>,
  context: Readonly<{ deadline: number }>,
  retained?: PublicFilterCreationWindow,
): Promise<PublicFilterCreationWindow> {
  requireAccessDeadline(context.deadline);
  const consumer = input.heldBirth ?? publicFilterCreationConsumer(input.bootstrap);
  if (!Number.isInteger(input.partition) || input.partition < 0 || input.partition > 4095)
    throw new TypeError('Creation windows require one exact native home');
  const row = (
    await pool.query<NativeWindow>(
      `${input.heldBirth === undefined ? '' : '/* semantic.native-keyed:89:89 */ '}
       SELECT epoch,head::text,base::text,receipt FROM (${creationAuthority(input.heldBirth)}) cut`,
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
      retained.heldBirth !== input.heldBirth ||
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
    ...(input.heldBirth === undefined ? {} : { heldBirth: input.heldBirth }),
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
  pool: CreationReader,
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
    await readPublicFilterCreationWindow(
      pool,
      { bootstrap: input.bootstrap, partition: w.partition, heldBirth: w.heldBirth },
      context,
      w,
    );
    return { event: null, next: w };
  }
  if (w.heldBirth !== undefined)
    return readPublicFilterCreationEvents(
      pool,
      {
        ...input,
        accounts: false,
        inputLimit: 1,
        subjectRange: false,
      },
      context,
      { rows: 0, inputKeys: 0, dependencyPoints: 0 },
    );
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

type CreationEnvelope = Readonly<{
  position: string;
  event_seq: number;
  event_count: number;
  epoch: number;
  id: string;
  type: string;
  subject: string | null;
  data_digest?: string;
  transaction_id?: string | null;
}>;

type Meter = { inputKeys: number; rows: number; dependencyPoints: number };

/** Walk exact original event keys in one snapshot. A Subject range stops before
 * the first different repair identity, including that lookahead in the meter.
 * Legacy replay remains capped at its original retained count.
 */
export async function readPublicFilterCreationEvents(
  pool: CreationReader,
  input: Readonly<{
    bootstrap: string;
    window: PublicFilterCreationWindow;
    accounts: boolean;
    inputLimit: number;
    subjectRange: boolean;
    retainedCount?: number;
  }>,
  context: Readonly<{ deadline: number }>,
  cost: Meter,
): Promise<{
  event: CreationEnvelope;
  next: PublicFilterCreationWindow;
  envelopes: readonly CreationEnvelope[];
  packed: string | undefined;
}> {
  requireAccessDeadline(context.deadline);
  const w = input.window;
  const held = w.heldBirth !== undefined;
  const inputLimit = held ? Math.min(input.inputLimit, 32) : input.inputLimit;
  const limit = input.retainedCount ?? inputLimit;
  if (
    !validWindow(w) ||
    w.position > w.through ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > inputLimit ||
    (held && input.accounts) ||
    (input.subjectRange && (input.accounts || input.retainedCount !== undefined))
  )
    throw new TypeError('Invalid creation event range');

  const charge = (points: number) => {
    cost.inputKeys += points;
    cost.rows += points;
    cost.dependencyPoints += points;
  };
  // A held envelope seeks its command basis and checks the claimed group end. The cut
  // also checks the original closure (at most 65 keys), both pages and the native owners.
  const eventPoints = held ? 3 : 1;
  charge((held ? 89 : 3) + eventPoints * limit);
  const { rows } = await pool.query<CreationEnvelope>(
    `/* semantic.native-keyed:0:0 */
     WITH RECURSIVE events AS (
       SELECT 0 AS ordinal,$4::bigint AS next_position,$5::integer AS next_seq,false AS stop,NULL::text AS repair_subject,
              NULL::bigint AS position,NULL::integer AS event_seq,NULL::integer AS event_count,
              NULL::integer AS epoch,NULL::uuid AS id,NULL::text AS type,NULL::text AS subject
              ${held ? ',NULL::text AS data_digest,NULL::uuid AS transaction_id' : ''}
       FROM (${creationAuthority(w.heldBirth)}) cut
       WHERE cut.receipt=$6 AND cut.epoch=$7 AND cut.base=$8 AND cut.head>=$9
       UNION ALL
       SELECT e.ordinal+1,
              CASE WHEN o.event_seq+1<o.event_count THEN o.position
                   WHEN o.position<$9 THEN o.position+1 END,
              CASE WHEN o.event_seq+1=o.event_count THEN 0 ELSE o.event_seq+1 END,
              action.repair AND (NOT $14::boolean OR o.subject IS NULL OR
                (e.repair_subject IS NOT NULL AND o.subject IS DISTINCT FROM e.repair_subject)),
              CASE WHEN action.repair THEN coalesce(e.repair_subject,o.subject) ELSE e.repair_subject END,
              o.position,o.event_seq,o.event_count,o.epoch,o.id,o.type,o.subject
              ${held ? ',o.data_digest,basis.transaction_id' : ''}
       FROM events e
       JOIN LATERAL (
         SELECT o.position,o.event_seq,o.event_count,o.epoch,o.id,o.type,o.subject
           ${held ? ",encode(sha256(convert_to(o.data::text,'UTF8')),'hex') AS data_digest" : ''}
         FROM core.outbox o
         WHERE (o.partition_no,o.position,o.event_seq)=($1,e.next_position,e.next_seq)
           ${
             held
               ? `AND o.payload_state='present'
             AND (o.event_seq+1<o.event_count OR NOT EXISTS (
               SELECT 1 FROM core.outbox extra WHERE (extra.partition_no,extra.position)=(o.partition_no,o.position)
                 AND extra.event_seq>=o.event_count
             ))
             AND (o.type NOT IN ('com.rezics.subject.created.v1','com.rezics.subject.visibility_changed.v1')
               OR o.data->>'id'=o.subject)
             AND (o.type<>'com.rezics.subject.visibility_changed.v1'
               OR (o.data->>'visibility' IS NOT NULL AND o.data->>'security_revision' IS NOT NULL))`
               : ''
           }
         LIMIT 1
       ) o ON true
       ${
         held
           ? `LEFT JOIN editorial.write_basis basis
         ON (basis.partition_no,basis.position,basis.epoch)=($1,o.position,o.epoch)`
           : ''
       }
       CROSS JOIN LATERAL (
         SELECT starts_with(o.type,$11) OR starts_with(o.type,$12) OR o.type=ANY($13::text[]) AS repair
       ) action
       WHERE e.ordinal<$10 AND e.next_position<=$9 AND NOT e.stop
     )
     SELECT position::text,event_seq,event_count,epoch,id,type,subject ${held ? ',data_digest,transaction_id' : ''}
     FROM events WHERE ordinal>0 ORDER BY ordinal`,
    [
      w.partition,
      input.bootstrap,
      w.heldBirth ?? publicFilterCreationConsumer(input.bootstrap),
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
      input.subjectRange,
    ],
  );

  let next = w;
  let target: CreationEnvelope | undefined;
  const envelopes: CreationEnvelope[] = [];
  const packed: string[] = [];
  // Leave room in the 16 KiB native state for the original window and its
  // successor. The compact tuple list is stored as an escaped JSON string.
  let bytes = 2;
  let stopped = false;
  for (const row of rows) {
    if (
      (!input.subjectRange && target !== undefined) ||
      next.position > w.through ||
      BigInt(row.position) !== next.position ||
      row.event_seq !== next.sequence ||
      row.epoch !== w.epoch ||
      row.event_count <= next.sequence ||
      (held &&
        (row.type === 'com.rezics.subject.created.v1' || row.type === 'com.rezics.subject.visibility_changed.v1') &&
        (row.transaction_id == null || row.subject === null)) ||
      (next.eventCount !== null && row.event_count !== next.eventCount)
    )
      throw new CommandUnavailableError('contention', w.partition);
    const action = publicFilterCreationAction(row.type, input.accounts);
    if (input.subjectRange) {
      const tuple = JSON.stringify([
        row.position,
        row.event_seq,
        row.event_count,
        row.epoch,
        row.id,
        row.type,
        row.subject,
        ...(held ? [row.data_digest, row.transaction_id] : []),
      ]);
      bytes += Buffer.byteLength(JSON.stringify(tuple)) - 1;
      if ((target && action && row.subject !== target.subject) || bytes > 12 * 1024) {
        stopped = true;
        break;
      }
      packed.push(tuple);
    }
    if (action) target = row;
    envelopes.push(row);
    next = creationEventSuccessor(next, row.event_count);
  }
  if (stopped && !envelopes.length) {
    charge(eventPoints * (rows.length - limit));
    // A single oversized envelope still has the original digest-based replay.
    return readPublicFilterCreationEvents(pool, { ...input, subjectRange: false }, context, cost);
  }
  const event = target ?? envelopes.at(-1);
  if (
    !event ||
    rows.length > limit ||
    (input.retainedCount !== undefined && rows.length !== input.retainedCount) ||
    (rows.length < inputLimit &&
      next.position <= w.through &&
      (input.subjectRange ? !stopped && target?.subject !== null : !target))
  )
    throw new CommandUnavailableError('contention', w.partition);
  charge(eventPoints * (rows.length - limit));
  return {
    event,
    next,
    envelopes,
    packed: input.subjectRange && (target || stopped) ? `[${packed.join(',')}]` : undefined,
  };
}

/** Read every slot of small single-event command groups inside the caller's
 * held-page snapshot. A gap, extra slot, minimized payload or relevant event
 * leaves that entire home to the ordinary creation bridge. */
export async function readHeldQuietCommands(
  db: CreationReader,
  homes: readonly Readonly<{ partition: number; epoch: number; base: string; head: string }>[],
  eventLimit: number,
) {
  if (!Number.isInteger(eventLimit) || eventLimit < 1 || eventLimit > 32 || homes.length > 32)
    throw new TypeError('Invalid held creation window allowance');
  const positions: { home: number; position: string; epoch: number }[] = [];
  const quiet = new Map<number, string[]>();
  for (const home of homes) {
    const base = BigInt(home.base),
      head = BigInt(home.head);
    if (head - base > BigInt(eventLimit - positions.length)) break;
    quiet.set(home.partition, []);
    for (let position = base + 1n; position <= head; position++)
      positions.push({ home: home.partition, position: String(position), epoch: home.epoch });
  }
  if (!positions.length) return quiet;
  const points = positions.length * 3;
  const { rows } = await db.query<{
    home: number;
    position: string;
    epoch: number;
    id: string;
    type: string;
    subject: string | null;
    digest: string;
    basis: string | null;
  }>(
    `/* semantic.native-keyed:${points}:${points} */
    SELECT k.home,k.position::text,k.epoch,o.id,o.type,o.subject,
      encode(sha256(convert_to(o.data::text,'UTF8')),'hex') AS digest,b.transaction_id AS basis
    FROM jsonb_to_recordset($1::jsonb) k(home integer,position bigint,epoch integer)
    CROSS JOIN LATERAL (SELECT id,type,subject,data FROM core.outbox
      WHERE (partition_no,position,event_seq)=(k.home,k.position,0) AND epoch=k.epoch AND event_count=1 AND payload_state='present'
      LIMIT 1) o
    LEFT JOIN LATERAL (SELECT transaction_id FROM editorial.write_basis
      WHERE (partition_no,position,epoch)=(k.home,k.position,k.epoch) LIMIT 1) b ON true
    WHERE NOT EXISTS (SELECT FROM core.outbox WHERE (partition_no,position)=(k.home,k.position) AND event_seq>0)
    ORDER BY k.home,k.position`,
    [JSON.stringify(positions)],
  );
  for (const row of rows) {
    if (publicFilterCreationAction(row.type, false) !== null) quiet.delete(row.home);
    else
      quiet
        .get(row.home)
        ?.push(JSON.stringify([row.position, row.epoch, row.id, row.type, row.subject, row.digest, row.basis]));
  }
  for (const home of homes) {
    if (BigInt(quiet.get(home.partition)?.length ?? -1) !== BigInt(home.head) - BigInt(home.base))
      quiet.delete(home.partition);
  }
  return quiet;
}
