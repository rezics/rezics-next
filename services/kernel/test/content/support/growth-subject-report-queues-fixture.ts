import { DBOS } from '@dbos-inc/dbos-sdk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createKernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { registerContent } from '../../../src/content/register.ts';
import { effectWorkflowId, type Effect } from '../../../src/events/effects.ts';
import { readBatch, type Envelope } from '../../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { openGrowthDatabase, seed, type Population } from '../../support/growth.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createNativeContentSystem } from './native-system.ts';
import { observeSql } from './sql-observer.ts';

export type QueueFixture = Awaited<ReturnType<typeof createQueueFixture>>;
export type QueueScope = 'catalogue' | 'subject';
export type QueueAxis = 'population' | 'history';
type Wire = { status: number; text: string; value: Record<string, any> };

/** Private fixture: real Auth, Access, commands, registered projection and mounted reads. */
export async function createQueueFixture() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createNativeContentSystem({ databaseUrl });
  const db = await openGrowthDatabase(system.database.pool.options.connectionString);
  let runtime: Awaited<ReturnType<typeof startProjection>> | undefined;
  const observer = observeSql(db.pool);
  let instant = Date.now();
  const kernel = createKernel({
    pool: db.pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    access: system.access,
    clock: () => new Date(instant),
    content: { cursorNow: () => instant },
    writeRate: createWriteRateLimiter({ secret: randomUUID() + randomUUID() }),
  });
  const close = async () => {
    try {
      await runtime?.close();
    } finally {
      await observer.close();
      try { await db.close(); } finally { await system.close(); }
    }
  };
  async function call(
    method: string,
    path: string,
    bearer = system.actors.moderator.bearer,
    body?: unknown,
    measured = false,
    key = randomUUID(),
  ): Promise<Wire> {
    const response = await (measured ? kernel : system.kernel).handle(new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await response.text();
    return { status: response.status, text, value: text ? JSON.parse(text) : {} };
  }
  async function checked(...args: Parameters<typeof call>) {
    const result = await call(...args);
    if (result.status < 200 || result.status >= 300)
      throw new Error(`${args[0]} ${args[1]}: ${result.status} ${result.text}`);
    return result.value;
  }
  try {
    await bootstrapRelease(system.database.pool, bundledRelease);
    const governanceId = (await db.admin.query('SELECT account_id FROM access.governance_bootstrap')).rows[0].account_id;
    const governance = await system.auth.issue({
      accountId: governanceId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes,
    });
    const moderator = system.actors.moderator.actor.accountId;
    async function grant(id: string, accountId: string, actions: string[]) {
      const input = {
        resource: { route: routeOf(id)!, id }, subject: { kind: 'account', id: accountId }, actions, valid: '(,)',
      };
      const result = await checked('POST', '/v1/grants', governance.bearer, input);
      return { ...input, valid: result.grant.valid as string };
    }
    let inspection = await grant(GLOBAL_CONTEXT, moderator, ['moderation:read_reports']);
    await grant(GLOBAL_CONTEXT, system.actors.author.actor.accountId, ['report:create']);
    const target = (await checked('POST', '/v1/subjects', system.actors.author.bearer, {
      type: 'schema:Book', labels: { en: 'Subject report queue growth' },
    })).subject.id as string;
    // A subject-local grant alone must never substitute for Global inspection.
    await grant(target, system.actors.other.actor.accountId, ['moderation:read_reports']);
    const source: string[] = [];
    const envelopes: Envelope[] = [];
    const tailTime = new Date(instant).toISOString();
    const noiseTime = new Date(instant + 30_000).toISOString();
    async function submit() {
      const key = randomUUID();
      const body = { target: { kind: 'subject', id: target }, reason: 'spam' };
      const result = await checked('POST', '/v1/reports', system.actors.author.bearer, body, false, key);
      const replay = await checked('POST', '/v1/reports', system.actors.author.bearer, body, false, key);
      if (replay.reportId !== result.reportId) throw new Error('Native report receipt replay changed identity');
      source.push(result.reportId);
      envelopes.push(await reportEnvelope(db.admin, result.reportId));
    }
    await system.clock.setCommandTime(tailTime);
    await submit();
    await submit();
    instant += 60_000;
    await system.clock.setCommandTime(new Date(instant).toISOString());
    for (let index = 0; index < 5; index++) await submit();
    // Auth owns DBOS during registration. Hand off only once all command setup is complete.
    runtime = await startProjection(system, db.pool);
    for (const envelope of envelopes) {
      await runtime.produce(envelope);
      await runtime.produce(envelope);
    }
    const selected = (await db.admin.query<{ report_id: string }>(
      `SELECT report_id FROM content.report_target WHERE route=$1 AND target_kind='subject' AND target_id=$2
       ORDER BY created_at DESC, report_id DESC`, [routeOf(target), target],
    )).rows.map((row) => row.report_id);
    if (selected.length !== source.length || !selected.every((id) => source.includes(id)))
      throw new Error('Registered report projection did not retain the native candidates exactly once');
    const paths = {
      catalogue: '/v1/catalogue/reports', subject: `/v1/subjects/${target}/reports`,
    };
    const url = (scope: QueueScope, status = 'pending', cursor?: string) =>
      `${paths[scope]}?limit=1&status=${status}&order=newest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const cursors = {} as Record<QueueScope, { deep: string; terminal: string }>;
    for (const scope of ['catalogue', 'subject'] as const) {
      // Native cursor construction occurs before pressure; no SQL or forged seal supplies a page result.
      let pendingCursor: string | undefined;
      let resolvedCursor: string | undefined;
      for (let index = 0; index < selected.length - 1; index++) {
        const pending = await checked('GET', url(scope, 'pending', pendingCursor));
        const resolved = await checked('GET', url(scope, 'resolved', resolvedCursor));
        if (pending.reports[0]?.id !== selected[index] || resolved.reports.length !== 0)
          throw new Error('Native queue selection does not match its fixed candidate neighbourhood');
        pendingCursor = pending.next;
        resolvedCursor = resolved.next;
        if (index === 2) cursors[scope] = { deep: pendingCursor!, terminal: '' };
      }
      cursors[scope].terminal = resolvedCursor!;
    }
    let inspectionActive = true;
    async function revoke() {
      if (!inspectionActive) throw new Error('Inspection already revoked');
      await checked('POST', '/v1/grants:revoke', governance.bearer, inspection);
      inspectionActive = false;
    }
    async function restore() {
      if (inspectionActive) return;
      inspection = await grant(GLOBAL_CONTEXT, moderator, ['moderation:read_reports']);
      inspectionActive = true;
    }
    const noiseSubject = newId(routeOf(target)!);
    const noiseReport = newId(routeOf(selected[0]!)!);
    const pressureSubjects: string[] = [];
    const pressureReports: string[] = [];
    const historyTransactions: string[] = [];
    const historyPositions: string[] = [];
    const population: Population = {
      name: `subject-report-queue-${randomUUID()}`,
      hotPartition: partitionOf(routeOf(target)!), hotShare: 1,
      rows: () => {
        const subject = newId(routeOf(target)!);
        const report = newId(routeOf(selected[0]!)!);
        pressureSubjects.push(subject);
        pressureReports.push(report);
        return {
          'semantic.subject': [{ route: routeOf(subject), subject_id: subject, type: 'schema:Book', recorded_transaction_id: randomUUID() }],
          'content.report': [{ route: routeOf(report), report_id: report, target_kind: 'subject', target_id: subject,
            reason: 'spam', created_at: noiseTime, recorded_transaction_id: randomUUID() }],
          'content.report_target': [{ route: routeOf(subject), target_kind: 'subject', target_id: subject,
            report_route: routeOf(report), report_id: report, created_at: noiseTime }],
          'content.catalogue_report_candidate': [{ route: 0, subject_id: subject, report_route: routeOf(report), report_id: report, created_at: noiseTime }],
        };
      },
    };
    // One fixed unrelated native-shaped source for retained event/receipt pressure, with no new candidates.
    await db.admin.query(`INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES ($1,$2,'schema:Book',$3)`,
      [routeOf(noiseSubject), noiseSubject, randomUUID()]);
    await db.admin.query(`INSERT INTO content.report(route,report_id,target_kind,target_id,reason,created_at,recorded_transaction_id)
      VALUES ($1,$2,'subject',$3,'spam',$4,$5)`, [routeOf(noiseReport), noiseReport, noiseSubject, noiseTime, randomUUID()]);
    async function grow(axis: QueueAxis, scale: number, previous: number) {
      if (previous === 0 && axis === 'population' && pressureSubjects.length) {
        await db.admin.query('DELETE FROM content.catalogue_report_candidate WHERE route=0 AND report_id=ANY($1::uuid[])', [pressureReports]);
        await db.admin.query('DELETE FROM content.report_target WHERE route=$1 AND target_id=ANY($2::uuid[])', [routeOf(target), pressureSubjects]);
        await db.admin.query('DELETE FROM content.report WHERE route=$1 AND report_id=ANY($2::uuid[])', [routeOf(selected[0]!), pressureReports]);
        await db.admin.query('DELETE FROM semantic.subject WHERE route=$1 AND subject_id=ANY($2::uuid[])', [routeOf(target), pressureSubjects]);
        pressureSubjects.length = pressureReports.length = 0;
      }
      if (axis === 'population') return seed(db, population, { from: previous, to: scale });
      const partition = partitionOf(routeOf(noiseReport)!);
      const head = (await db.admin.query('SELECT epoch,position FROM core.partition WHERE partition_no=$1', [partition])).rows[0];
      if (previous === 0 && historyTransactions.length) {
        await db.admin.query('DELETE FROM core.receipt WHERE partition_no=$1 AND transaction_id=ANY($2::uuid[])', [partition, historyTransactions]);
        await db.admin.query('DELETE FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=ANY($2::uuid[])', [partition, historyTransactions]);
        await db.admin.query('DELETE FROM core.outbox WHERE partition_no=$1 AND position=ANY($2::bigint[])', [partition, historyPositions]);
        historyTransactions.length = historyPositions.length = 0;
      }
      const start = BigInt(head.position);
      const history: Population = {
        name: `${population.name}-history`, hotPartition: partition, hotShare: 1,
        rows: ({ ordinal }) => {
          const transaction = randomUUID();
          const position = (start + BigInt(ordinal - previous + 1)).toString();
          historyTransactions.push(transaction);
          historyPositions.push(position);
          return {
            'editorial.write_basis': [{ partition_no: partition, transaction_id: transaction, epoch: head.epoch, position,
              principal_id: system.actors.author.actor.accountId, client_id: system.auth.ordinaryClient.id, principal_kind: 'account' }],
            'core.receipt': [{ partition_no: partition, principal_kind: 'account', principal_id: system.actors.author.actor.accountId,
              command_kind: 'content.report.create', idempotency_key: randomUUID(), request_digest: Buffer.alloc(32),
              epoch: head.epoch, position, transaction_id: transaction, response: { reportId: noiseReport } }],
            'core.outbox': [{ partition_no: partition, position, event_seq: 0, event_count: 1, epoch: head.epoch, id: randomUUID(),
              type: 'com.rezics.content.report.created.v1', subject: noiseReport,
              data: { reportId: noiseReport, targetKind: 'subject', targetId: noiseSubject } }],
          };
        },
      };
      await seed(db, history, { from: previous, to: scale });
      await db.admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [partition, (start + BigInt(scale - previous)).toString()]);
    }
    return { system, db, observer, paths, url, cursors, selected, target, revoke, restore, grow, call, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Read the exact committed source envelope through the native log reader. */
async function reportEnvelope(pool: Pool, reportId: string): Promise<Envelope> {
  const partition = partitionOf(routeOf(reportId)!);
  const row = (await pool.query('SELECT epoch,position FROM core.outbox WHERE partition_no=$1 AND subject=$2', [partition, reportId])).rows[0];
  if (!row) throw new Error('Native report did not emit its source event');
  const consumer = `queue_capture_${randomUUID().replaceAll('-', '')}`;
  await pool.query('INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)',
    [partition, consumer, row.epoch, (BigInt(row.position) - 1n).toString()]);
  const envelopes: Envelope[] = [];
  const result = await readBatch(pool, { consumer, partition, envelopes: 1, apply: async (batch) => { envelopes.push(...batch); } });
  if (result.status !== 'read' || envelopes.length !== 1) throw new Error('Native report source envelope was unavailable');
  return envelopes[0]!;
}

async function startProjection(system: Awaited<ReturnType<typeof createNativeContentSystem>>, pool: Pool) {
  const databaseUrl = system.database.pool.options.connectionString!;
  const client = await createWorkClient(databaseUrl, pool);
  const registered: Effect[] = [];
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    await DBOS.shutdown({ deregister: true });
    work = await composeWork([{ name: registerContent.name, register(context) {
      return registerContent.register({ ...context, addEffects(effects) {
        registered.push(...effects); context.addEffects(effects);
      } });
    } }], { databaseUrl, pool, client, executorId: `subject-queue-${randomUUID()}`,
      env: workerTestEnv({ KERNEL_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'), CONTENT_TEST_COLLECTION_PARTITIONS: '0' }),
    });
    await work.launch();
    if (!registered.some((effect) => effect.name === 'content_report_target')) throw new Error('Missing registered report target projection');
    return {
      async produce(envelope: Envelope) {
        await work!.effects.enqueue([envelope]);
        for (const [index, event] of envelope.events.entries())
          for (const effect of registered.filter((candidate) => candidate.types.includes(event.type)))
            await client.retrieveWorkflow(effectWorkflowId(envelope, index, effect.name)).getResult({ pollingIntervalMs: 10 });
      },
      async close() { try { await work?.shutdown(); } finally { await client.close(); } },
    };
  } catch (error) {
    try { await work?.shutdown(); } finally { await client.close(); }
    throw error;
  }
}
