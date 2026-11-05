import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { noEffect, runCommand } from '../command/command.ts';
import { recordLateErasureItem, resolveLateErasureItem } from '../access/erasure.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { REPORT_EVENTS, type ReportEventData } from './report-events.ts';
import { lockErasureFence } from './erasure-fence.ts';
import { eraseAccountReportItem } from './account-erasure-reactions.ts';
import { markAccountErasureFound } from './account-erasure-progress.ts';
import read from './report-locator-source.sql';
import insert from './report-locator-upsert.sql';

const created = 'com.rezics.content.report.created.v1';

/** The report lives in a key-derived home, independently of the reporter. Read
 * only its current ownership reference, release it, then write the reporter home.
 * Replaying after minimization sees no reporter and adds no locator. */
export function createReportLocatorEffect(pool: Pool): Effect {
  return {
    name: 'content_report_reporter',
    types: [created],
    async run(event) {
      if (event.type !== created || !Value.Check(REPORT_EVENTS[created], event.data))
        throw new TypeError('Invalid report reporter locator event');
      const data = event.data as ReportEventData<typeof created>;
      const reportRoute = routeOf(data.reportId);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      const epoch = Number(source?.[2]);
      const position = /^\d{19}$/.test(event.sequence) ? BigInt(event.sequence) : 0n;
      if (
        reportRoute === null ||
        !source ||
        Number(source[1]) !== partitionOf(reportRoute) ||
        !Number.isSafeInteger(epoch) ||
        epoch > 2147483647 ||
        position <= 0n ||
        position > 9223372036854775807n ||
        event.subject !== data.reportId
      )
        throw new TypeError('Invalid report reporter locator envelope');
      const retained = await withConnection(pool, async (client) => {
        // One partition command/read at a time, including when both homes share a database.
        const anchor = await readPartition(client, partitionOf(reportRoute));
        if (
          !anchor ||
          anchor.writeState === 'moved' ||
          epoch > anchor.epoch ||
          (epoch === anchor.epoch && position > anchor.position)
        )
          throw new Error('Report source partition unavailable');
        const report = await read.run(client, { route: reportRoute, report_id: data.reportId });
        if (
          !report ||
          report.target_kind !== data.targetKind ||
          report.target_id !== data.targetId ||
          report.revision_id !== (data.revisionId ?? null)
        )
          throw new Error('Report source reference mismatch');
        return report;
      });
      await deliverReportReporter(pool, data.reportId, reportRoute, retained);
    },
  };
}

/** Installation reads the current native source, never a copied reporter identity.
 * The migration journal supplies exact IDs; no source checkout survives delivery. */
export async function installReportReporter(pool: Pool, reportId: string): Promise<void> {
  const reportRoute = routeOf(reportId);
  if (reportRoute === null) throw new TypeError('Invalid report identity');
  const retained = await withConnection(pool, async (client) => {
    const anchor = await readPartition(client, partitionOf(reportRoute));
    if (!anchor || anchor.writeState === 'moved') throw new Error('Report source partition unavailable');
    return read.run(client, { route: reportRoute, report_id: reportId });
  });
  await deliverReportReporter(pool, reportId, reportRoute, retained);
}

async function deliverReportReporter(
  pool: Pool,
  reportId: string,
  reportRoute: number,
  retained: Awaited<ReturnType<typeof read.run>>,
) {
  const reporter = retained?.reporter_account_id;
  if (!reporter) return;
  const createdAt = retained.created_at;
  if (!createdAt) throw new Error('Report source received time unavailable');
  const home = routeOf(reporter);
  if (home === null) throw new TypeError('Invalid reporter identity');
  const locator = `report:${reportRoute}:${reportId}`;
  const result = await runCommand<{ late: boolean }>(pool, { partition: partitionOf(home) }, async (tx) => {
    if (await lockErasureFence(tx, reporter)) {
      await recordLateErasureItem(tx, { accountId: reporter, participant: 'content', locator });
      await markAccountErasureFound(tx, reporter, 'content');
      return {
        value: { late: true as const },
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: reporter,
            data: { accountId: reporter },
          },
        ],
      };
    }
    const added = await insert.run(tx, {
      route: home,
      actor_id: reporter,
      report_route: reportRoute,
      report_id: reportId,
      created_at: createdAt,
    });
    if (!added) return noEffect({ late: false as const });
    return {
      value: { late: false as const },
      events: [
        {
          type: 'com.rezics.content.report-reporter.projected.v1',
          subject: reportId,
          data: { reportId },
        },
      ],
    };
  });
  if (result.value.late) {
    await eraseAccountReportItem({ pool }, reporter, reportRoute, reportId);
    await resolveLateErasureItem({ pool }, { accountId: reporter, participant: 'content', locator });
  }
}
