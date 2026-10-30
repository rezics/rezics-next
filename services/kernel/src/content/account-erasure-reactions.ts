import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand, type CommandEvent } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import reactions from './account-erasure-reactions-page.sql';
import reports from './report-locator-page.sql';
import eraseReport from './account-erasure-reactions-report.sql';
import removeLocators from './report-locator-delete.sql';
import clear from './reaction-slot.sql';
import deleteLikedVersion from './account-erasure-reactions-version-delete.sql';
import { noteAccountErasureFound } from './account-erasure-progress.ts';

export type ReactionErasureCursor = Readonly<{ phase: 'reactions' | 'reports'; after: string | null }>;
const first = '00000000-0000-0000-0000-000000000000';
const pageSize = 50;

async function eraseReportCopy(pool: Pool, accountId: string, reportRoute: number, reportId: string): Promise<void> {
  await runCommand(pool, { partition: partitionOf(reportRoute) }, async (tx) => {
    const changed = await eraseReport.run(tx, { route: reportRoute, report_id: reportId, actor_id: accountId });
    if (!changed) return noEffect(null);
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.content.report.evidence-erased.v1',
          subject: reportId,
          data: { reportId },
        },
      ],
    };
  });
}

/** Applies the report disposition for a locator effect that reaches a closed fence. */
export async function eraseAccountReportItem(
  deps: { pool: Pool },
  accountId: string,
  reportRoute: number,
  reportId: string,
): Promise<void> {
  await eraseReportCopy(deps.pool, accountId, reportRoute, reportId);
  const home = route(accountId);
  await runCommand(deps.pool, { partition: partitionOf(home) }, async (tx) => {
    const removed = await removeLocators.run(tx, { route: home, actor_id: accountId, report_ids: [reportId] });
    if (!removed.length) return noEffect(null);
    return {
      value: null,
      events: removed.map((report) => ({
        type: 'com.rezics.content.report-reporter.erased.v1',
        subject: report.report_id,
        data: { reportId: report.report_id },
      })),
    };
  });
}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Invalid account reaction erasure identity');
  return value;
}

/** Platform work under a committed erasure obligation. Each command owns just one
 * partition; no source checkout survives a report-partition command. Locators
 * committed after this phase's last page belong to the shared in-flight protocol. */
export async function eraseAccountReactionsPage(
  deps: { pool: Pool },
  accountId: string,
  cursor: ReactionErasureCursor | null,
): Promise<{ next: ReactionErasureCursor | null; found: number }> {
  const home = route(accountId);
  if (cursor && cursor.phase !== 'reactions' && cursor.phase !== 'reports')
    throw new TypeError('Invalid account reaction erasure phase');
  if (cursor?.after !== null && cursor?.after !== undefined) route(cursor.after);
  const parameters = { route: home, actor_id: accountId, after: cursor?.after ?? first };
  if (!cursor || cursor.phase === 'reactions') {
    const result = await runCommand(deps.pool, { partition: partitionOf(home) }, async (tx, command) => {
      const page = await reactions.run(tx, parameters);
      if (page.length)
        await tx.query(
          'UPDATE content.account_erasure_progress SET content_found=true WHERE route=$1 AND account_id=$2',
          [home, accountId],
        );
      const events: CommandEvent[] = [];
      for (const reaction of page) {
        const [changed] = await clear.run(tx, {
          route: home,
          actor_id: accountId,
          target_kind: reaction.target_kind,
          target_route: reaction.target_route,
          target_id: reaction.target_id,
          kind: null,
          at: authoritativeTimeValue(command.time),
        });
        if (changed)
          events.push({
            type: 'com.rezics.content.reaction.changed.v1',
            subject: reaction.target_id,
            data: {
              actorId: accountId,
              targetKind: reaction.target_kind,
              targetId: reaction.target_id,
              previousKind: changed.previous_kind,
              kind: null,
            },
          });
      }
      let removedLikedVersion = false;
      if (page.length < pageSize) {
        const removed = await deleteLikedVersion.run(tx, { route: home, actor_id: accountId });
        removedLikedVersion = removed.length > 0;
        if (removedLikedVersion)
          await tx.query(
            'UPDATE content.account_erasure_progress SET content_found=true WHERE route=$1 AND account_id=$2',
            [home, accountId],
          );
      }
      const value = {
        next:
          page.length === pageSize
            ? { phase: 'reactions' as const, after: page.at(-1)!.target_id }
            : { phase: 'reports' as const, after: null },
        found: page.length,
      };
      return events.length ? { value, events } : noEffect(value);
    });
    return result.value;
  }
  const { value: page } = await runCommand(deps.pool, { partition: partitionOf(home) }, async (tx) =>
    noEffect(await reports.run(tx, parameters)),
  );
  if (page.length) await noteAccountErasureFound(deps, accountId, 'content');
  for (const report of page) {
    await eraseReportCopy(deps.pool, accountId, report.report_route, report.report_id);
  }
  if (page.length)
    await runCommand(deps.pool, { partition: partitionOf(home) }, async (tx) => {
      const removed = await removeLocators.run(tx, {
        route: home,
        actor_id: accountId,
        report_ids: page.map((report) => report.report_id),
      });
      if (!removed.length) return noEffect(null);
      return {
        value: null,
        events: removed.map((report) => ({
          type: 'com.rezics.content.report-reporter.erased.v1',
          subject: report.report_id,
          data: { reportId: report.report_id },
        })),
      };
    });
  return {
    next: page.length === pageSize ? { phase: 'reports', after: page.at(-1)!.report_id } : null,
    found: page.length,
  };
}
