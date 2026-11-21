import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { withReadTransaction } from './read.ts';
import { publicFilterCreationAction } from './public-filter-creation-window.ts';
import { maxHeldQuietPages } from './public-filter-held-quiet-range.ts';

const pageHomes = 32;
const ackSpan = pageHomes * maxHeldQuietPages;
const positiveLimit = 96;
const commandLimit = 64;
type Meter = { inputKeys: number; rows: number; dependencyPoints: number };
type Head = { partition: number; epoch: number; base: string; head: string };
type Interval = { bootstrap: string; birth: string; start: number };
type Saved = { count: number; commandEnds: string };
const pageOf = (home: number) => Math.floor(home / pageHomes) * pageHomes;

// The sparse index includes commands already present at capture. Only the
// difference from the immutable cut needs outbox and write-basis comparison.
async function commandHeads(db: PoolClient, input: Interval, end: number, meter: Meter, saved?: Saved) {
  const values: unknown[] = [input.birth, input.start, end];
  let source: string;
  let limit: number;
  if (saved) {
    const ends: Record<string, string> = JSON.parse(saved.commandEnds);
    const entries = Object.entries(ends);
    if (
      entries.length > commandLimit ||
      entries.some(
        ([home, pos]) =>
          !/^(0|[1-9][0-9]*)$/.test(home) ||
          Number(home) < input.start ||
          Number(home) >= end ||
          typeof pos !== 'string' ||
          !/^[1-9][0-9]{0,18}$/.test(pos),
      )
    )
      throw new TypeError('Invalid retained Subject command ends');
    if (!entries.length) return { end, heads: [], points: 0 };
    limit = entries.length;
    values.push(saved.commandEnds);
    source = `SELECT x.key::int AS partition_no,x.value::bigint AS position FROM jsonb_each_text($4::jsonb) x
      CROSS JOIN LATERAL (SELECT FROM core.partition WHERE partition_no=x.key::int
        AND position>=x.value::bigint LIMIT 1) h`;
  } else {
    limit = positiveLimit + 1;
    source = `SELECT partition_no,position FROM core.partition WHERE partition_no>=$2 AND partition_no<$3
      AND position>0 ORDER BY partition_no LIMIT ${limit}`;
  }
  const pageLimit = Math.min(limit, (end - input.start) / pageHomes);
  const points = limit + pageLimit + 1;
  const { rows } = await db.query<Head>(
    `/* semantic.native-keyed:${points}:${points} */
     WITH heads AS MATERIALIZED (${source}), pages AS MATERIALIZED (
       SELECT wanted.page,p.cuts FROM (SELECT DISTINCT partition_no/32*32 AS page FROM heads) wanted
       LEFT JOIN LATERAL (SELECT cuts FROM semantic.subject_access_page_v1 p
         WHERE (p.birth,p.first_home,p.end_home)=($1,wanted.page,wanted.page+32) LIMIT 1) p ON true
     )
     SELECT h.partition_no AS partition,h.position::text AS head,(c.cut->>'epoch')::integer AS epoch,
       c.cut->>'command' AS base FROM heads h JOIN pages p ON p.page=h.partition_no/32*32
       CROSS JOIN LATERAL (SELECT p.cuts->(h.partition_no%32) AS cut) c
     WHERE h.partition_no >= $2 AND h.partition_no < $3 ORDER BY h.partition_no`,
    values,
  );
  if (saved && rows.length !== limit) throw new CommandUnavailableError('contention', input.start);
  const refund = limit - rows.length + pageLimit - new Set(rows.map((h) => pageOf(h.partition))).size;
  meter.inputKeys -= refund;
  meter.rows -= refund;
  meter.dependencyPoints -= refund;
  if (!saved && rows.length > positiveLimit) end = pageOf(rows[positiveLimit]!.partition);
  const heads: Head[] = [];
  let positions = 0n;
  for (const row of rows) {
    if (row.partition >= end) break;
    if (row.base === null || row.epoch === null || BigInt(row.head) < BigInt(row.base)) {
      end = pageOf(row.partition);
      break;
    }
    const count = BigInt(row.head) - BigInt(row.base);
    if (!count) continue;
    positions += count;
    if (positions > BigInt(commandLimit)) {
      end = pageOf(row.partition);
      break;
    }
    heads.push(row);
  }
  return { end, heads: heads.filter((h) => h.partition < end), points: points - refund };
}

// A position is closed only by its original singleton, payload digest and
// optional editorial basis. The two-slot seek detects a malformed extra row.
// Missing, relevant and multi-event groups stay on the ordinary bridge.
async function commandEnvelopes(db: PoolClient, heads: readonly Head[]) {
  const quiet = new Map<number, string[]>();
  if (!heads.length) return quiet;
  const slots = heads.reduce((n, h) => n + Number(BigInt(h.head) - BigInt(h.base)), 0);
  const points = 3 * slots;
  const { rows } = await db.query<{
    partition: number;
    position: string;
    epoch: number;
    id: string;
    type: string;
    subject: string | null;
    digest: string;
    basis: string | null;
  }>(
    `/* semantic.native-keyed:${points}:${points} */
     SELECT h.partition,pos::text AS position,h.epoch,slot.id,slot.type,slot.subject,slot.digest,
       b.transaction_id::text AS basis
     FROM jsonb_to_recordset($1) h(partition integer,epoch integer,base bigint,head bigint)
     CROSS JOIN LATERAL generate_series(h.base+1,h.head) pos
     CROSS JOIN LATERAL (SELECT g.*,count(*) OVER () AS slots FROM (
       SELECT o.id,o.type,o.subject,o.event_seq,o.event_count,o.epoch,
         CASE WHEN o.payload_state='present' THEN encode(sha256(convert_to(o.data::text,'UTF8')),'hex') END AS digest
       FROM core.outbox o WHERE (o.partition_no,o.position)=(h.partition,pos)
       ORDER BY o.event_seq LIMIT 2) g) slot
     LEFT JOIN LATERAL (SELECT transaction_id FROM editorial.write_basis
       WHERE (partition_no,position,epoch)=(h.partition,pos,h.epoch) LIMIT 1) b ON true
     WHERE slot.slots=1 AND slot.event_seq=0 AND slot.event_count=1 AND slot.epoch=h.epoch AND slot.digest IS NOT NULL
     ORDER BY h.partition,pos`,
    [JSON.stringify(heads)],
  );
  for (const row of rows) {
    if (publicFilterCreationAction(row.type, false)) continue;
    const events = quiet.get(row.partition) ?? [];
    events.push(JSON.stringify([row.position, row.epoch, row.id, row.type, row.subject, row.digest, row.basis]));
    quiet.set(row.partition, events);
  }
  for (const h of heads)
    if (quiet.get(h.partition)?.length !== Number(BigInt(h.head) - BigInt(h.base))) quiet.delete(h.partition);
  return quiet;
}

async function originalPages(client: PoolClient, input: Interval, end: number, meter: Meter) {
  const digests: string[] = [];
  let stale: number | undefined;
  const points = 98 + 5 * ((end - input.start) / pageHomes);
  const { rows } = await client.query<{
    first_home: number;
    digest: string | null;
    current: boolean;
    key_count: number;
  }>(
    `/* semantic.native-keyed:${points}:${points} */
           WITH anchor AS MATERIALIZED (
             SELECT m.birth,p.definition_digest,s.key_count FROM semantic.subject_access_cut_v1($1,$2) m
             JOIN core.subject_subscription_v1 s ON s.birth=m.birth
             JOIN semantic.subject_access_page_v1 p ON (p.birth,p.first_home)=(m.birth,$2) WHERE m.birth=$3
           )
           SELECT i AS first_home,anchor.key_count,coalesce(p.quiet_digest,CASE WHEN inventory.empty THEN
             encode(sha256(convert_to(p.cuts::text,'UTF8')),'hex') END) AS digest,
             semantic.subject_repair_page_current_v1(p) AS current
           FROM anchor CROSS JOIN generate_series($2::int,$4::int-32,32) i
           LEFT JOIN LATERAL (SELECT p.* FROM semantic.subject_access_page_v1 p
             JOIN core.subject_retention_page_v1 c USING(birth,first_home,end_home)
             WHERE (p.birth,p.first_home,p.end_home,p.definition_digest)=(anchor.birth,i,i+32,anchor.definition_digest)
             LIMIT 1) p ON true
           LEFT JOIN LATERAL (SELECT s.evidence->>'phase'='inventory' AND s.evidence->'obligations'='[]'::jsonb
             AND jsonb_array_length(s.evidence#>'{evidence,inventory}')=32
             AND NOT EXISTS (SELECT FROM jsonb_array_elements(s.evidence#>'{evidence,inventory}')
               WITH ORDINALITY item(home,ordinal)
               CROSS JOIN LATERAL (SELECT p.cuts->(item.ordinal::int-1) AS cut) original
               WHERE (item.home->>'partition',item.home->>'epoch',item.home->>'receipt',item.home->'originals',
                 item.home->'complete') IS DISTINCT FROM
                 (cut->>'home',cut->>'epoch',cut->>'receipt','[]'::jsonb,'true'::jsonb)) AS empty
             FROM semantic.subject_source_step_v1 s WHERE (s.birth,s.first_home,s.ordinal)=(p.birth,i,0)
               AND p.quiet_digest IS NULL LIMIT 1) inventory ON true ORDER BY i`,
    [input.bootstrap, input.start, input.birth, end],
  );
  if (rows.length) {
    const refund = 64 - rows[0]!.key_count;
    meter.inputKeys -= refund;
    meter.rows -= refund;
    meter.dependencyPoints -= refund;
  }
  for (const page of rows) {
    if (page.first_home !== input.start + digests.length * pageHomes || !page.digest) break;
    if (!page.current) {
      stale = page.first_home;
      break;
    }
    digests.push(page.digest);
  }

  return { digests, stale };
}

// The existing 768-input repair offer also pays the custody join, independent
// chain link and checkpoint. Admit both scans before reading the event groups.
function fundedEnd(start: number, end: number, heads: readonly Head[], probe: number, keyCount: number) {
  let changed = 0,
    slots = 0;
  for (let page = start; page < end; page += pageHomes) {
    while (changed < heads.length && heads[changed]!.partition < page + pageHomes) {
      const h = heads[changed++]!;
      slots += Number(BigInt(h.head) - BigInt(h.base));
    }
    const pages = (page + pageHomes - start) / pageHomes;
    const anchors = 2 * (34 + keyCount + 5 * pages);
    const reopen = changed ? 1 + changed + Math.min(pages, changed) : 0;
    if (probe + anchors + reopen + 6 * slots > 640) return page;
  }
  return end;
}

export async function readHeldCommandRange(db: Pool, input: Interval, deadline: number, meter: Meter, saved?: Saved) {
  const { start } = input;
  // End on a receiver tree boundary so the following verified range can form a single wide ACK.
  const width = saved?.count ?? ackSpan - (start % ackSpan);
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    start % pageHomes ||
    !Number.isInteger(width) ||
    width < pageHomes ||
    width > ackSpan ||
    width % pageHomes ||
    start + width > 4096
  )
    throw new TypeError('Invalid held Subject command interval');
  const result = await withReadTransaction(
    db,
    async (client) => {
      let end = start + width;
      let keyCount = 0;
      const empty = {
        digests: [] as string[],
        commandEnds: '{}',
        envelopes: [] as string[][],
        stale: undefined as number | undefined,
      };
      if (!saved) {
        const probe = await client.query<{ stop: number; key_count: number }>(
          `/* semantic.native-keyed:2:2 */
         SELECT least($2::int,(SELECT route/512*32 FROM semantic.subject WHERE route>=$1::int*16 AND route<$2::int*16
           ORDER BY route,subject_id LIMIT 1)) AS stop,key_count FROM core.subject_subscription_v1 WHERE birth=$3`,
          [start, end, input.birth],
        );
        if (!probe.rows[0] || probe.rows[0].stop === start) return empty;
        end = probe.rows[0].stop;
        keyCount = probe.rows[0].key_count;
      }
      // On replay, refuse a changed stamp before spending the command allowance.
      const retained = saved && (await originalPages(client, input, end, meter));
      if (retained && retained.digests.length * pageHomes !== width) return { ...empty, ...retained };
      const observed = await commandHeads(client, input, end, meter, saved);
      end = saved ? observed.end : fundedEnd(start, observed.end, observed.heads, 2 + observed.points, keyCount);
      if (end <= start) return empty;
      const originals = retained ?? (await originalPages(client, input, end, meter));
      end = start + originals.digests.length * pageHomes;
      const heads = observed.heads.filter((h) => h.partition < end);
      const quiet = await commandEnvelopes(client, heads);
      const changed = heads.find((h) => !quiet.has(h.partition));
      if (changed) end = pageOf(changed.partition);
      const ends: Record<string, string> = {};
      const envelopes: string[][] = [];
      for (const h of heads) {
        if (h.partition >= end) break;
        ends[h.partition] = h.head;
        envelopes.push(quiet.get(h.partition)!);
      }
      return {
        digests: originals.digests.slice(0, (end - start) / pageHomes),
        commandEnds: JSON.stringify(ends),
        envelopes,
        stale: originals.stale,
      };
    },
    deadline,
  );
  if (saved && (result.digests.length * pageHomes !== width || result.commandEnds !== saved.commandEnds)) {
    const { stale } = result;
    if (stale !== undefined)
      await db.query(
        `/* semantic.native-keyed:320:320:1 */
        MERGE INTO semantic.subject_quiet_recheck_v1 q USING (VALUES($1::bigint,$2::int)) i(birth,home)
        ON (q.birth,q.first_home)=(i.birth,i.home) WHEN MATCHED THEN UPDATE SET first_home=i.home
        WHEN NOT MATCHED THEN INSERT (birth,first_home) VALUES(i.birth,i.home)`,
        [input.birth, stale],
      );
    throw new CommandUnavailableError('contention', start);
  }
  return result;
}
