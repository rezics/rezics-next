import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import { installReportReporter } from './report-locator.ts';
import { REPORT_EVENTS } from './report-events.ts';

export const REPORT_LOCATOR_INSTALLATION_PAGE = 100;
export const REPORT_LOCATOR_INSTALLED = 'com.rezics.content.report-locator.installed.v1';
type Cut = { epoch: number; position: string; expected: string; applied: string; notified: boolean };

/** Exact durable source cut. The caller releases this checkout before delivery. */
async function cut(pool: Pool, partition: number): Promise<Cut & { headEpoch: number; headPosition: bigint }> {
  return withConnection(pool, async (client) => {
    const anchor = await readPartition(client, partition);
    if (!anchor || anchor.writeState === 'moved') throw new Error('Report source partition unavailable');
    const row = (await client.query<Cut>(
      'SELECT epoch, position::text, expected::text, applied::text, notified FROM content.report_locator_cut WHERE partition_no=$1',
      [partition],
    )).rows[0];
    if (!row || row.epoch > anchor.epoch || (row.epoch === anchor.epoch && BigInt(row.position) > anchor.position))
      throw new Error('Report locator installation cut unavailable');
    return { ...row, headEpoch: anchor.epoch, headPosition: anchor.position };
  });
}

/** One resumable source page. Delivery precedes acknowledgement; a crash between
 * them replays the native idempotent locator and account-erasure protocol. */
export async function installReportLocatorPage(pool: Pool, partition: number): Promise<{ complete: boolean; examined: number }> {
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new TypeError('Invalid report source partition');
  const initial = await cut(pool, partition);
  if (initial.notified) return { complete: true, examined: 0 };
  const selected = await withConnection(pool, async (client) => {
    const anchor = await readPartition(client, partition);
    if (!anchor || anchor.writeState === 'moved') throw new Error('Report source partition unavailable');
    return (await client.query<{ report_id: string }>(
      'SELECT report_id FROM content.report_locator_pending WHERE partition_no=$1 ORDER BY report_id LIMIT $2',
      [partition, REPORT_LOCATOR_INSTALLATION_PAGE],
    )).rows;
  });
  for (const row of selected) await installReportReporter(pool, row.report_id);
  const result = await runCommand(pool, { partition }, async (tx) => {
    const current = (await tx.query<Cut>(
      'SELECT epoch, position::text, expected::text, applied::text, notified FROM content.report_locator_cut WHERE partition_no=$1 FOR UPDATE',
      [partition],
    )).rows[0];
    if (!current) throw new Error('Report locator installation cut unavailable');
    if (current.notified) return noEffect({ complete: true, examined: selected.length });
    const removed = await tx.query(
      'DELETE FROM content.report_locator_pending WHERE partition_no=$1 AND report_id=ANY($2::uuid[]) RETURNING report_id',
      [partition, selected.map((row) => row.report_id)],
    );
    const applied = BigInt(current.applied) + BigInt(removed.rowCount ?? 0);
    const complete = applied === BigInt(current.expected);
    // An unexplained empty journal must not certify a different expected cut.
    if (!complete && selected.length === 0) throw new Error('Report locator installation journal incomplete');
    if (!removed.rowCount && !complete) return noEffect({ complete: false, examined: selected.length });
    await tx.query('UPDATE content.report_locator_cut SET applied=$2, notified=$3 WHERE partition_no=$1',
      [partition, applied.toString(), complete]);
    return {
      value: { complete, examined: selected.length },
      events: [{
        type: REPORT_LOCATOR_INSTALLED,
        data: { partition, epoch: current.epoch, position: current.position, expected: current.expected, applied: applied.toString(), complete },
      }],
    };
  });
  return result.value;
}

/** Only a committed, completely applied source cut can contribute to the global
 * certificate. The exact receiving key makes duplicate delivery harmless. */
export function createReportLocatorInstallationEffect(pool: Pool): Effect {
  return {
    name: 'content_report_locator_installation',
    types: [REPORT_LOCATOR_INSTALLED],
    async run(event) {
      if (event.type !== REPORT_LOCATOR_INSTALLED || !Value.Check(REPORT_EVENTS[REPORT_LOCATOR_INSTALLED], event.data))
        throw new TypeError('Invalid report locator installation event');
      const data = event.data as { partition: number; epoch: number; position: string; expected: string; applied: string; complete: boolean };
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (event.type !== REPORT_LOCATOR_INSTALLED || !data || !Number.isInteger(data.partition) ||
          data.partition < 0 || data.partition > 4095 || Number(source?.[1]) !== data.partition ||
          !/^\d{19}$/.test(event.sequence)) throw new TypeError('Invalid report locator installation event');
      const current = await cut(pool, data.partition);
      const epoch = Number(source?.[2]);
      const position = BigInt(event.sequence);
      if (!Number.isSafeInteger(epoch) || epoch > current.headEpoch || position <= 0n ||
          position > 9223372036854775807n || (epoch === current.headEpoch && position > current.headPosition))
        throw new TypeError('Invalid report locator installation envelope');
      if (!data.complete) return;
      if (!current.notified || current.expected !== current.applied || current.epoch !== data.epoch ||
          current.position !== data.position || current.expected !== data.expected || data.applied !== data.expected)
        throw new Error('Report locator installation certificate mismatch');
      await runCommand(pool, { partition: 0 }, async (tx) => {
        const added = await tx.query(
          `INSERT INTO content.report_locator_installed(route, source_partition, epoch, position, expected)
           VALUES (0,$1,$2,$3,$4) ON CONFLICT (route, source_partition) DO NOTHING RETURNING source_partition`,
          [data.partition, data.epoch, data.position, data.expected],
        );
        if (!added.rowCount) return noEffect(null);
        await tx.query('UPDATE content.report_locator_coverage SET installed=installed+1 WHERE route=0');
        return { value: null, events: [{ type: 'com.rezics.content.report-locator.coverage.v1', data: { partition: data.partition } }] };
      });
    },
  };
}
