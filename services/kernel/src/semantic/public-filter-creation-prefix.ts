import type { Pool } from 'pg';
import { requireAccessDeadline } from '../access/unavailable.ts';
import type { PublicFilterCost } from './public-filter-source-contract.ts';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import { publicFilterCreationAction, type PublicFilterCreationWindow } from './public-filter-creation-window.ts';

type Meter = {
  -readonly [Key in 'inputKeys' | 'dependencyPoints']: PublicFilterCost[Key];
} & {
  rows: number;
};
type EventPoint = {
  position: string;
  epoch: number;
  event_seq: number;
  event_count: number;
  repairs_subject: boolean;
};
type CreationHome = {
  home: number;
  epoch: number | null;
  base: string | null;
  head: string | null;
  receipt: string | null;
};

function completeWindow(events: readonly EventPoint[], window: PublicFilterCreationWindow): boolean {
  let { position, sequence, eventCount } = window;
  for (const row of events) {
    if (
      row.repairs_subject ||
      row.epoch !== window.epoch ||
      BigInt(row.position) !== position ||
      row.event_seq !== sequence ||
      row.event_count <= sequence ||
      (eventCount !== null && row.event_count !== eventCount)
    )
      return false;
    if (sequence + 1 === row.event_count) {
      position++;
      sequence = 0;
      eventCount = null;
    } else {
      sequence++;
      eventCount = row.event_count;
    }
  }
  return position === window.through + 1n && sequence === 0;
}

/** Close a contiguous prefix only when every retained outbox position and event
 * is present under its original pin and epoch, with no Subject work to dispatch.
 * A relevant event, gap or oversized window returns that home to ordinary repair.
 */
export async function readPublicFilterCreationPrefix(
  pool: Pool,
  input: Readonly<{
    bootstrap: string;
    from: number;
    inputLimit: number;
    through?: readonly string[];
    accounts?: true;
  }>,
  context: Readonly<{ deadline: number }>,
  cost: Meter,
) {
  const homes = Math.min(input.inputLimit, 4096 - input.from);
  const exact = input.through?.length;
  if (homes < 1 || (exact !== undefined && (exact < 1 || exact > homes))) return [];
  const charge = (keys: number, rows = keys) => {
    cost.inputKeys += keys;
    cost.rows += rows;
    cost.dependencyPoints += rows;
  };
  async function readHomes(from: number, count: number) {
    requireAccessDeadline(context.deadline);
    // Range reads reserve their own footprints so refunds never depend on
    // whether the caller's original Pool also installs query accounting.
    charge(count, 3 * count);
    return (
      await pool.query<CreationHome>(
        `/* semantic.native-keyed:0:0 */
     SELECT h.home,p.epoch,e.creation_position::text AS base,p.position::text AS head,e.receipt
     FROM generate_series($1::integer,$2::integer) h(home)
     JOIN LATERAL (
       SELECT owner_epoch,creation_position,receipt
       FROM semantic.public_filter_home_enrollment
       WHERE (partition_no,bootstrap)=(h.home,$3) AND complete AND creation_consumer=$4
       LIMIT 1
     ) e ON true
     JOIN LATERAL (
       SELECT epoch,position FROM core.partition
       WHERE partition_no=h.home AND write_state='active' AND epoch=e.owner_epoch
       LIMIT 1
     ) p ON true
     JOIN LATERAL (
       SELECT 1 FROM core.consumer_checkpoint
       WHERE (partition_no,consumer)=(h.home,$4) AND position<=e.creation_position
         AND (epoch IS NULL OR epoch=p.epoch)
       LIMIT 1
     ) c ON true
     ORDER BY h.home`,
        [from, from + count - 1, input.bootstrap, publicFilterCreationConsumer(input.bootstrap)],
      )
    ).rows;
  }
  const prefix: { window: PublicFilterCreationWindow; events: readonly EventPoint[] }[] = [];
  const readWindow = (row: CreationHome, home: number): PublicFilterCreationWindow | null => {
    if (
      row.home !== home ||
      row.epoch === null ||
      row.epoch < 1 ||
      row.base === null ||
      row.head === null ||
      row.receipt === null ||
      !/^[0-9a-f]{64}$/.test(row.receipt)
    )
      return null;
    const base = BigInt(row.base);
    const head = BigInt(row.head);
    const through = input.through === undefined ? head : BigInt(input.through[home - input.from]!);
    if (base < 0n || through < base || through > head) return null;
    return {
      partition: home,
      epoch: row.epoch,
      receipt: row.receipt,
      base,
      through,
      position: base + 1n,
      sequence: 0,
      eventCount: null,
    };
  };
  if (input.accounts) {
    const count = exact ?? Math.min(16, homes, Math.max(1, Math.floor(input.inputLimit / 2)));
    const windows: PublicFilterCreationWindow[] = [];
    const ranges: { home: number; epoch: number; receipt: string; base: string; through: string; points: number }[] =
      [];
    let points = 0;
    const homesInOrder = await readHomes(input.from, count);
    for (const [offset, row] of homesInOrder.entries()) {
      const window = readWindow(row, input.from + offset);
      if (!window) break;
      const width = window.through - window.base;
      const required = width === 0n ? 0n : width + 1n;
      if (required > BigInt(input.inputLimit - count - points)) break;
      windows.push(window);
      if (width === 0n) continue;
      ranges.push({
        home: window.partition,
        epoch: window.epoch,
        receipt: window.receipt,
        base: String(window.base),
        through: String(window.through),
        points: Number(width),
      });
      points += Number(required);
    }
    const eventsByHome = new Map<number, EventPoint[]>();
    if (points) {
      requireAccessDeadline(context.deadline);
      charge(points, points + 2 * ranges.length);
      // One native event per position fits this page. A gap, multi-event
      // position or relevant event leaves that home to the ordinary bridge.
      const { rows } = await pool.query<Omit<EventPoint, 'repairs_subject'> & { home: number; type: string }>(
        `/* semantic.native-keyed:0:0 */
         SELECT x.home,o.position::text,o.epoch,o.event_seq,o.event_count,o.type
         FROM jsonb_to_recordset($1::jsonb) x(home integer,epoch integer,receipt text,base bigint,through bigint,points integer)
         CROSS JOIN LATERAL (
           SELECT event.position,event.epoch,event.event_seq,event.event_count,event.type
           FROM semantic.public_filter_home_enrollment e
           JOIN core.partition p ON p.partition_no=e.partition_no AND p.epoch=e.owner_epoch
           JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
           CROSS JOIN LATERAL (
             SELECT position,epoch,event_seq,event_count,type FROM core.outbox
             WHERE partition_no=e.partition_no AND position>x.base AND position<=x.through
             ORDER BY position,event_seq LIMIT x.points
           ) event
           WHERE (e.partition_no,e.bootstrap)=(x.home,$2::uuid) AND e.complete AND e.receipt=x.receipt
             AND e.creation_consumer=$3 AND e.creation_position=x.base AND p.write_state='active'
             AND p.epoch=x.epoch AND p.position>=x.through
             AND c.position<=e.creation_position AND (c.epoch IS NULL OR c.epoch=p.epoch)
         ) o ORDER BY x.home,o.position::bigint,o.event_seq`,
        [JSON.stringify(ranges), input.bootstrap, publicFilterCreationConsumer(input.bootstrap)],
      );
      for (const { home, type, ...point } of rows) {
        let events = eventsByHome.get(home);
        if (!events) eventsByHome.set(home, (events = []));
        events.push({ ...point, repairs_subject: publicFilterCreationAction(type, true) !== null });
      }
    }
    for (const window of windows) {
      const events = eventsByHome.get(window.partition) ?? [];
      if (!completeWindow(events, window)) break;
      prefix.push({ window, events });
    }
    return prefix;
  }
  let remaining = input.inputLimit;
  let group = 16;
  while (prefix.length < (exact ?? homes) && remaining > 0) {
    // Spend unused event capacity on more metadata points, and give quiet
    // ranges larger reads after a group closed without any outbox work.
    const from = input.from + prefix.length;
    const count = exact ?? Math.min(group, homes - prefix.length, Math.ceil(remaining / 2));
    remaining -= count;
    const eventBudget = remaining;
    const rows = await readHomes(from, count);
    for (const [offset, row] of rows.entries()) {
      const window = readWindow(row, from + offset);
      if (!window) return prefix;
      const { base, through } = window;
      let events: readonly EventPoint[] = [];
      if (through > base) {
        if (through - base > BigInt(remaining)) return prefix;
        requireAccessDeadline(context.deadline);
        // Reserve the whole bounded range read. A dispatched query only refunds
        // unused points after its original result has returned.
        charge(remaining);
        const result = await pool.query<EventPoint>(
          `/* semantic.native-keyed:0:0 */
         SELECT o.position::text,epoch,event_seq,event_count,
           (starts_with(type,'com.rezics.subject.') OR starts_with(type,'com.rezics.statement.')) AS repairs_subject
         FROM core.outbox o WHERE partition_no=$1 AND o.position>$2::bigint AND o.position<=$3::bigint
         ORDER BY o.position,o.event_seq LIMIT $4`,
          [row.home, String(base), String(through), remaining],
        );
        const unused = remaining - result.rows.length;
        charge(-unused);
        remaining = unused;
        events = result.rows;
        if (!completeWindow(events, window)) return prefix;
      }
      prefix.push({ window, events });
    }
    if (rows.length !== count) return prefix;
    if (remaining === eventBudget) group *= 2;
  }
  return prefix;
}
