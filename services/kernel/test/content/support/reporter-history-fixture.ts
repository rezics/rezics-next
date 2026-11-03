import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createKernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createReportLocatorEffect } from '../../../src/content/report-locator.ts';
import { CommandUnavailableError } from '../../../src/command/command.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import type { CloudEvent } from '../../../src/events/log.ts';
import { createReactionRelayBase, type CallOptions } from '../reaction-relay-convergence-fixture.ts';

/** Shared native signed accounts and Access; only the report rate budget grows
 * to admit a real page through the mounted production producer. */
export async function createReporterHistoryFixture() {
  const base = await createReactionRelayBase();
  const kernel = createKernel({
    pool: base.system.database.pool,
    access: base.system.access,
    routeKey: base.system.routeKey,
    tokens: base.system.tokenKeys,
    writeRate: createWriteRateLimiter({
      secret: 'reporter-history-native-page-rate-secret-at-least-32-bytes',
      overrides: JSON.stringify({
        'new-account': {
          write: { maximum: 100_000, seconds: 86400 },
          report: { maximum: 100_000, seconds: 86400 },
        },
      }),
    }),
  });
  async function call(method: string, path: string, options: CallOptions = {}) {
    const headers = new Headers(options.headers);
    if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
    if (options.key) headers.set('idempotency-key', JSON.stringify(options.key));
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await kernel.handle(
      new Request(`https://content.test${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    const text = await response.text();
    return { response, text, value: text ? (JSON.parse(text) as Record<string, any>) : null };
  }
  async function submit(
    target: { kind: 'thread' | 'post' | 'board' | 'subject'; id: string },
    options: { key?: string; project?: boolean } = {},
  ) {
    const result = await call('POST', '/v1/reports', {
      bearer: base.author.bearer,
      key: options.key ?? randomUUID(),
      body: { target, reason: 'spam', evidence: 'My retained submission' },
    });
    if (result.response.status !== 201) throw new Error(`POST /v1/reports: ${result.response.status} ${result.text}`);
    const id = result.value!.reportId as string;
    if (options.project !== false) await project(id);
    return id;
  }
  async function project(id: string) {
    const partition = partitionOf(routeOf(id)!);
    const row = (
      await base.system.database.pool.query<{
        id: string;
        epoch: number;
        position: string;
        type: string;
        subject: string;
        time: string;
        data: unknown;
      }>(
        `SELECT id, epoch, position::text, type, subject, data,
      to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time
      FROM core.outbox WHERE partition_no=$1 AND type=$2 AND subject=$3 ORDER BY position DESC LIMIT 1`,
        [partition, 'com.rezics.content.report.created.v1', id],
      )
    ).rows[0];
    if (!row) throw new Error('Native committed report original missing');
    const event: CloudEvent = {
      specversion: '1.0',
      id: row.id,
      source: `urn:rezics:log:${partition}.${row.epoch}`,
      sequence: row.position.padStart(19, '0'),
      datacontenttype: 'application/json',
      type: row.type,
      subject: row.subject,
      time: row.time,
      data: row.data,
    };
    const effect = createReportLocatorEffect(base.system.database.pool);
    await effect.run(event);
    await effect.run(event);
  }
  function failNextCaseFill() {
    const pool = base.system.database.pool;
    const original = pool.connect;
    const connect = (original as () => Promise<PoolClient>).bind(pool);
    let failed = false;
    pool.connect = (async () => {
      const client = await connect();
      const query = client.query;
      const release = client.release;
      client.query = function (...args: any[]) {
        if (!failed && typeof args[0] === 'string' && args[0].includes('SELECT r.* FROM content.report r')) {
          failed = true;
          pool.connect = original;
          throw new CommandUnavailableError('deadline', 0);
        }
        return (query as Function).apply(client, args);
      } as typeof client.query;
      client.release = (...args) => {
        client.query = query;
        client.release = release;
        release(...args);
      };
      return client;
    }) as typeof pool.connect;
    return () => {
      pool.connect = original;
    };
  }
  return { ...base, call, submit, project, failNextCaseFill };
}
