import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { deadlineClient } from '../access/authenticate.ts';
import { notificationAllowed } from '../access/preferences.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  noEffect,
  principalCommandIdentity,
  runCommand,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { requestDigest } from '../http/request.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessClient, Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS } from './events.ts';
import { writeNotices } from './notices.ts';
import type { ReportDependencies, ReportTarget } from './reports.ts';
import { ReportUnavailableError } from './reports.ts';
import type { RequestContext } from './model.ts';
import claimNotice from './claim-report-outcome-notice.sql';
import read from './read-report-outcome.sql';
import resolve from './resolve-report-outcome.sql';
import decision from './decision-report-outcome.sql';
import progress from './read-report-outcome-progress.sql';
import checkpoint from './checkpoint-report-outcome.sql';
import page from './page-target-reports.sql';
import sourceEvent from './read-outbox-event-index.sql';

const takedown = 'com.rezics.content.moderation.takedown.v1';
const resolved = 'com.rezics.content.report.resolved.v1';
const projected = 'com.rezics.content.report-target.projected.v1';
export const REPORT_OUTCOME_PAGE_SIZE = 100;
export class ReportResolvedError extends Error {}
type Decision = NonNullable<Awaited<ReturnType<typeof decision.run>>>;

/** Each checkout belongs to one independently anchored partition. */
async function atPartition<T>(
  pool: Pool,
  route: number,
  write: boolean,
  work: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, Date.now() + 30_000);
    await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const partitionNo = partitionOf(route);
      const partition = await readPartition(client, partitionNo);
      if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
      if (partition.writeState === 'moved' || (write && partition.writeState !== 'active'))
        throw new CommandUnavailableError(
          partition.writeState === 'moved' ? 'moved' : 'fenced',
          partitionNo,
          partition.movedTo,
        );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(connection, rollbackError as Error);
      }
      throw error;
    }
  });
}

async function report(pool: Pool, id: string) {
  const route = routeOf(id);
  if (route === null) throw new ReportUnavailableError();
  return atPartition(pool, route, false, (client) => read.run(client, { route, report_id: id }));
}

/** The immutable resolution and native event are committed together. A replay
 * after a recipient failure can safely retry the separate notice transaction. */
async function notify(pool: Pool, id: string) {
  const row = await report(pool, id);
  if (!row?.outcome || !row.reporter_account_id) return;
  const recipient = row.reporter_account_id;
  const route = routeOf(recipient)!;
  await atPartition(pool, route, true, async (client) => {
    if (!(await claimNotice.run(client, { route, recipient_id: recipient, report_id: id }))) return;
    if (await notificationAllowed(client, { recipient, kind: 'moderation_decision' }))
      await writeNotices(client, [
        {
          recipientId: recipient,
          noticeId: newId(route),
          kind: 'moderation_decision',
          actorId: null,
          threadId: null,
          postId: null,
          reportId: id,
          decisionId: row.decision_id,
          sourceId: id,
          createdAt: new Date(row.resolved_at!),
        },
      ]);
  });
}

export async function dismissReport(deps: ReportDependencies, actor: Actor, id: string, context: RequestContext) {
  if (actor.kind !== 'account') throw new ReportUnavailableError();
  const reference = await report(deps.pool, id);
  if (!reference) throw new ReportUnavailableError();
  const route = routeOf(id)!;
  const targetRoute = routeOf(reference.target_id)!;
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'moderation:takedown',
    anchor: {
      resource: { route: targetRoute, id: reference.target_id },
      async validate(client) {
        const partition = await readPartition(client, partitionOf(targetRoute));
        return !!partition && partition.writeState !== 'moved';
      },
    },
    context: { pool: deps.pool, partition: partitionOf(route), deadline: context.deadline },
  });
  const result = await runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      ...(deps.clock ? { clock: deps.clock } : {}),
      authorization,
      receipt: {
        kind: 'content.report.dismiss',
        key: context.idempotencyKey,
        digest: requestDigest('content.report.dismiss', actor, { reportId: id }),
      },
    },
    async (tx, command) => {
      const changed = await resolve.run(tx, {
        route,
        report_id: id,
        outcome: 'dismissed',
        resolved_at: authoritativeTimeValue(command.time),
        resolved_by: actor.accountId,
        decision_id: null,
      });
      if (!changed) throw new ReportResolvedError();
      return {
        value: { reportId: id, outcome: 'dismissed' as const },
        events: [{ type: resolved, subject: id, data: { reportId: id } }],
      };
    },
  );
  await notify(deps.pool, id);
  return result;
}

async function actionReport(pool: Pool, id: string, target: ReportTarget, chosen: Decision) {
  const route = routeOf(id)!;
  await runCommand(pool, { partition: partitionOf(route), deadline: Date.now() + 30_000 }, async (tx) => {
    const row = await read.run(tx, { route, report_id: id });
    if (
      !row ||
      row.target_kind !== target.kind ||
      row.target_id !== target.id ||
      row.outcome ||
      row.created_at! > chosen.decided_at!
    )
      return noEffect(null);
    await resolve.run(tx, {
      route,
      report_id: id,
      outcome: 'actioned',
      resolved_at: chosen.decided_at!,
      resolved_by: chosen.decider_account_id,
      decision_id: chosen.decision_id,
    });
    return { value: null, events: [{ type: resolved, subject: id, data: { reportId: id } }] };
  });
  await notify(pool, id);
}

/** The range is bounded even when every report in the page was already resolved. */
export async function reportOutcomePage(
  pool: Pool,
  target: ReportTarget,
  after?: { createdAt: string; reportId: string },
  limit = REPORT_OUTCOME_PAGE_SIZE,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_OUTCOME_PAGE_SIZE)
    throw new RangeError('Invalid report outcome page size');
  return atPartition(pool, routeOf(target.id)!, false, (client) =>
    page.run(client, {
      route: routeOf(target.id)!,
      target_kind: target.kind,
      target_id: target.id,
      created_at: after?.createdAt ?? 'infinity',
      report_id: after?.reportId ?? '00000000-0000-0000-0000-000000000000',
      limit,
    }),
  );
}

async function verifiedSource(pool: Pool, event: CloudEvent, id: string) {
  const route = routeOf(id);
  const match = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  if (route === null || !match || Number(match[1]) !== partitionOf(route) || !/^\d{19}$/.test(event.sequence))
    throw new TypeError('Invalid report outcome source');
  await atPartition(pool, route, false, async (client) => {
    const rows = await sourceEvent.run(client, {
      partition_no: partitionOf(route),
      epoch: Number(match[2]),
      position: event.sequence,
      id: event.id,
      type: event.type,
      subject: event.subject ?? null,
      data: event.data,
    });
    if (rows.length !== 1) throw new TypeError('Report outcome source missing');
  });
}

export function createReportOutcomeEffect(pool: Pool): Effect {
  return {
    name: 'content_report_outcome',
    types: [takedown, resolved, projected],
    async run(event) {
      if (
        ![takedown, resolved, projected].includes(event.type) ||
        !Value.Check(CONTENT_EVENTS[event.type as keyof typeof CONTENT_EVENTS], event.data)
      )
        throw new TypeError('Invalid report outcome event');
      const data = event.data as {
        reportId: string;
        targetKind: ReportTarget['kind'];
        targetId: string;
        securityRevision?: string;
      };
      await verifiedSource(pool, event, event.type === resolved ? data.reportId : data.targetId);
      if (event.type === resolved) return notify(pool, data.reportId);
      const target: ReportTarget = { kind: data.targetKind, id: data.targetId };
      const route = routeOf(target.id)!;
      const chosen = await atPartition(pool, route, false, (client) =>
        decision.run(client, {
          route,
          target_kind: target.kind,
          target_id: target.id,
          security_revision: data.securityRevision ?? null,
        }),
      );
      if (!chosen) {
        if (event.type === takedown) throw new Error('Report outcome decision missing');
        return;
      }
      // A late reverse projection must not fall behind a completed takedown cursor.
      if (event.type === projected) return actionReport(pool, data.reportId, target, chosen);
      const saved = await atPartition(pool, route, false, (client) =>
        progress.run(client, { route, decision_id: chosen.decision_id }),
      );
      if (saved?.done) return;
      let after = saved ? { createdAt: saved.after_at!, reportId: saved.after_id } : undefined;
      for (;;) {
        const rows = await reportOutcomePage(pool, target, after);
        for (const row of rows) await actionReport(pool, row.report_id, target, chosen);
        const last = rows.at(-1);
        if (last) after = { createdAt: last.created_at!, reportId: last.report_id };
        const done = rows.length < REPORT_OUTCOME_PAGE_SIZE;
        await atPartition(pool, route, true, (client) =>
          checkpoint.run(client, {
            route,
            decision_id: chosen.decision_id,
            after_at: after?.createdAt ?? 'infinity',
            after_id: after?.reportId ?? '00000000-0000-0000-0000-000000000000',
            done,
          }),
        );
        if (done) return;
      }
    },
  };
}
