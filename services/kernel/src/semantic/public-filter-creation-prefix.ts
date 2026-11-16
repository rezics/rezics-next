import type { Pool } from 'pg';
import { requireAccessDeadline } from '../access/unavailable.ts';
import type { PublicFilterCost } from './public-filter-source-contract.ts';
import { publicFilterCreationConsumer } from './public-filter-creation-consumer.ts';
import type { PublicFilterCreationWindow } from './public-filter-creation-window.ts';

type Meter = {
  -readonly [Key in 'inputKeys' | 'rows' | 'dependencyPoints']: PublicFilterCost[Key];
};
type EventPoint = {
  position: string;
  epoch: number;
  event_seq: number;
  event_count: number;
  repairs_subject: boolean;
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
  input: Readonly<{ bootstrap: string; from: number; inputLimit: number; through?: readonly string[] }>,
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
      await pool.query<{
        home: number;
        epoch: number | null;
        base: string | null;
        head: string | null;
        receipt: string | null;
      }>(
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
      if (
        row.home !== from + offset ||
        row.epoch === null ||
        row.epoch < 1 ||
        row.base === null ||
        row.head === null ||
        row.receipt === null ||
        !/^[0-9a-f]{64}$/.test(row.receipt)
      )
        return prefix;
      const base = BigInt(row.base);
      const head = BigInt(row.head);
      const through = input.through === undefined ? head : BigInt(input.through[row.home - input.from]!);
      if (base < 0n || through < base || through > head) return prefix;
      const window: PublicFilterCreationWindow = {
        partition: row.home,
        epoch: row.epoch,
        receipt: row.receipt,
        base,
        through,
        position: base + 1n,
        sequence: 0,
        eventCount: null,
      };
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
