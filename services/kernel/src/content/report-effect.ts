import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { deadlineClient, within } from '../access/authenticate.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import read from './read-report.sql';
import { reportBoardPlacement } from './board-report-candidates.ts';
import boardUpsert from './board-report-upsert.sql';
import catalogueUpsert from './catalogue-report-upsert.sql';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { REPORT_EVENTS, type ReportEventData } from './report-events.ts';
import upsert from './upsert-report-target.sql';

const sourceType = 'com.rezics.content.report.created.v1';
const projectedType = 'com.rezics.content.report-target.projected.v1';
class AlreadyProjected extends Error {}

/** Register with the kernel's shared registerEffects/enqueue/relay composition. */
export function createReportEffect(pool: Pool): Effect {
  return { name: 'content_report_target', types: [sourceType], run: (event) => applyReportEffect(pool, event) };
}

/** Trusted delivery input only. The event is a reference; the immutable report
 * supplies the projection's identity and timestamp from its own partition. */
export async function applyReportEffect(pool: Pool, event: CloudEvent): Promise<void> {
  if (event.type !== sourceType || !Value.Check(REPORT_EVENTS[sourceType], event.data))
    throw new TypeError('Invalid report projection event');
  const data = event.data as ReportEventData<typeof sourceType>;
  const reportRoute = routeOf(data.reportId);
  const targetRoute = routeOf(data.targetId);
  const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  const epoch = Number(source?.[2]);
  if (
    reportRoute === null ||
    targetRoute === null ||
    !source ||
    Number(source[1]) !== partitionOf(reportRoute) ||
    !Number.isSafeInteger(epoch) ||
    epoch > 2147483647 ||
    !/^\d{19}$/.test(event.sequence) ||
    BigInt(event.sequence) <= 0n ||
    BigInt(event.sequence) > 9223372036854775807n ||
    event.subject !== data.reportId
  )
    throw new TypeError('Invalid report projection envelope');
  const deadline = Date.now() + 30_000;
  const report = await within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const anchor = await readPartition(client, partitionOf(reportRoute));
        if (
          !anchor ||
          anchor.writeState === 'moved' ||
          epoch > anchor.epoch ||
          (epoch === anchor.epoch && BigInt(event.sequence) > anchor.position)
        )
          throw new Error('Report source partition unavailable');
        const parameters = { route: reportRoute, report_id: data.reportId, include_private: false };
        const { rows } = await client.query<{
          target_kind: string;
          target_id: string;
          revision_id: string | null;
          created_at: string;
        }>(
          read.sql,
          read.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        const row = rows[0];
        if (
          !row ||
          row.target_kind !== data.targetKind ||
          row.target_id !== data.targetId ||
          row.revision_id !== (data.revisionId ?? null)
        )
          throw new Error('Report source reference mismatch');
        // Return references only; no evidence escapes this source checkout.
        const reference = { createdAt: row.created_at, targetKind: data.targetKind, targetId: data.targetId };
        await client.query('COMMIT');
        return reference;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
  // The source connection is released before checking out the target partition.
  try {
    await runCommand(pool, { partition: partitionOf(targetRoute), deadline }, async (tx) => {
      const parameters = {
        route: targetRoute,
        target_kind: report.targetKind,
        target_id: report.targetId,
        report_route: reportRoute,
        report_id: data.reportId,
        created_at: report.createdAt,
      };
      const { rows } = await tx.query(
        upsert.sql,
        upsert.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      // A replay has no mutation or new event; roll back before the kernel fence.
      if (rows.length === 0) throw new AlreadyProjected();
      return {
        value: null,
        events: [
          {
            type: projectedType,
            subject: report.targetId,
            data: { reportId: data.reportId, targetKind: report.targetKind, targetId: report.targetId },
          },
        ],
      };
    });
  } catch (error) {
    if (!(error instanceof AlreadyProjected)) throw error;
  }
  // Also runs after exact-target replay: a crash between the two partition writes is repairable.
  if (['subject', 'space', 'realm'].includes(report.targetKind)) {
    await runCommand(pool, { partition: partitionOf(0), deadline }, async (tx) => {
      const added = await catalogueUpsert.run(tx, {
        report_route: reportRoute,
        report_id: data.reportId,
        subject_id: report.targetId,
        target_kind: report.targetKind,
        created_at: report.createdAt,
      });
      if (!added) return noEffect(null);
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.content.catalogue-report.projected.v1',
            subject: GLOBAL_CONTEXT,
            data: { reportId: data.reportId },
          },
        ],
      };
    });
    return;
  }
  await projectBoardCandidate(
    pool,
    { kind: report.targetKind, id: report.targetId },
    reportRoute,
    data.reportId,
    report.createdAt,
    deadline,
  );
}

/** Release the native target snapshot before writing the board partition. */
async function projectBoardCandidate(
  pool: Pool,
  target: { kind: ReportEventData<typeof sourceType>['targetKind']; id: string },
  reportRoute: number,
  reportId: string,
  createdAt: string,
  deadline: number,
): Promise<void> {
  const boardId = await within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const anchor = await readPartition(client, partitionOf(routeOf(target.id)!));
        if (!anchor || anchor.writeState === 'moved') throw new Error('Report target partition unavailable');
        const board = await reportBoardPlacement(client, target);
        await client.query('COMMIT');
        return board;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
  if (!boardId) return;
  const route = routeOf(boardId)!;
  await runCommand(pool, { partition: partitionOf(route), deadline }, async (tx) => {
    const added = await boardUpsert.run(tx, {
      route,
      board_id: boardId,
      target_kind: target.kind,
      target_id: target.id,
      report_route: reportRoute,
      report_id: reportId,
      created_at: createdAt,
    });
    if (!added) return noEffect(null);
    return {
      value: null,
      events: [
        { type: projectedType, subject: boardId, data: { reportId, targetKind: target.kind, targetId: target.id } },
      ],
    };
  });
}
