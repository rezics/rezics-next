import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createAccess } from '../../../src/access/index.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { registerContent } from '../../../src/content/register.ts';
import { createTurnstileVerifier } from '../../../src/content/turnstile.ts';
import { relayEffects } from '../../../src/events/effects.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { anonymousCommandTarget } from '../../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { openGrowthDatabase, seed, type Population, type Row } from '../../support/growth.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { workerTestEnv } from '../../support/worker-env.ts';

export const axes = ['reports', 'receipts', 'grants'] as const;
export type Axis = (typeof axes)[number];
export const branches = ['missing', 'invalid', 'unavailable', 'replay', 'conflict', 'revoked'] as const;
export type Branch = (typeof branches)[number];
const operation = 'content.report.create';
const anonymous = '00000000-0000-0000-0000-000000000000';
const sourceType = 'com.rezics.content.report.created.v1';
const projectionType = 'com.rezics.content.report-target.projected.v1';
const evidence = 'Fixed private anonymous report evidence';

/** Private fixture: real HTTP, production Access, Siteverify adapter and registered content work. */
export async function createAdmissionFixture() {
  const db = await openGrowthDatabase();
  const routeKey = new Uint8Array(32).fill(73);
  const board = newId(0x4567);
  const boardRoute = routeOf(board)!;
  const target = { kind: 'board', id: board } as const;
  const input = { target, reason: 'spam', evidence };
  const issued = new Set<string>();
  const proofs: string[] = [];
  let providerCalls = 0;
  let peer = 0;
  const verifier = createTurnstileVerifier({
    secret: 'private-admission-provider-secret',
    hostname: 'kernel.test',
    action: 'report',
    fetch: async (url, init) => {
      providerCalls++;
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(init?.signal).toBeDefined();
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('secret')).toBe('private-admission-provider-secret');
      const token = form.get('response')!;
      if (token === 'provider-unavailable') return new Response('', { status: 503 });
      return Response.json({ success: issued.delete(token), hostname: 'kernel.test', action: 'report' });
    },
  });
  const mint = () => {
    const token = randomUUID();
    issued.add(token);
    proofs.push(token);
    return token;
  };
  const app = createKernel({
    pool: db.pool,
    routeKey,
    receiptKeys: testReceiptKeys(),
    access: (config) => createAccess(config),
    reports: { anonymousVerifier: verifier },
    writeRate: createWriteRateLimiter({ secret: 'private-admission-rate-secret-at-least-32-bytes', overrides: '{}' }),
    // A separate trusted /64 per invocation preserves the shared default budgets.
    // These are transport peers, never caller-supplied forwarding headers.
    ratePeer: () => `2001:db8:${(++peer).toString(16)}::1`,
  });
  const home = (key: string) => anonymousCommandTarget(routeKey, operation, key);
  const keyFor = () => {
    for (;;) {
      const key = randomUUID();
      if (partitionOf(home(key).route) !== partitionOf(boardRoute)) return key;
    }
  };
  const selectedKey = keyFor();
  const rejectedKeys = new Map(branches.slice(0, 3).map((branch) => [branch, keyFor()]));
  const selected = home(selectedKey);
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  const close = async () => {
    try {
      await work?.shutdown();
    } finally {
      try {
        await client?.close();
      } finally {
        await db.close();
      }
    }
  };
  async function submit(key: string, token?: string, reason = input.reason) {
    const response = await app.handle(
      new Request('https://kernel.test/v1/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) },
        body: JSON.stringify({ ...input, reason, ...(token === undefined ? {} : { botToken: token }) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function visibility(revoked: boolean) {
    await db.admin.query(
      `UPDATE content.board SET visibility=$3, security_revision=security_revision+1
       WHERE route=$1 AND board_id=$2 AND visibility<>$3`,
      [boardRoute, board, revoked ? 'protected' : 'published'],
    );
  }
  async function snapshot() {
    // Inspections use the unmeasured administrative pool, outside checkGrowth operations.
    const ids = [selected.id, ...[...rejectedKeys.values()].map((key) => home(key).id)];
    const tables = [
      ['reports', 'SELECT to_jsonb(r) AS row FROM content.report r WHERE report_id=ANY($1::uuid[])'],
      [
        'receipts',
        `SELECT to_jsonb(r) AS row FROM core.receipt r
                    WHERE command_kind='${operation}' AND response->>'reportId'=ANY($1::text[])`,
      ],
      ['events', "SELECT to_jsonb(r) AS row FROM core.outbox r WHERE data->>'reportId'=ANY($1::text[])"],
      ['targets', 'SELECT to_jsonb(r) AS row FROM content.report_target r WHERE report_id=ANY($1::uuid[])'],
    ] as const;
    return Object.fromEntries(
      await Promise.all(
        tables.map(async ([name, sql]) => [
          name,
          (await db.admin.query(`${sql} ORDER BY to_jsonb(r)::text`, [ids])).rows.map((row) => row.row),
        ]),
      ),
    ) as Record<'reports' | 'receipts' | 'events' | 'targets', Record<string, unknown>[]>;
  }
  async function totals() {
    return (
      await db.admin.query(
        `SELECT (SELECT count(*)::int FROM content.report) AS reports,
              (SELECT count(*)::int FROM core.receipt WHERE command_kind='${operation}') AS receipts,
              (SELECT count(*)::int FROM core.outbox WHERE type=ANY($1::text[])) AS events,
              (SELECT count(*)::int FROM content.report_target) AS targets`,
        [[sourceType, projectionType]],
      )
    ).rows[0];
  }
  try {
    // Same migrated native board setup semantics as reports-http.test.ts; no Access stub.
    await db.admin.query(
      `INSERT INTO content.board
       (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Admission growth target','published',1,$4)`,
      [boardRoute, board, newId(0x5678), randomUUID()],
    );
    client = await createWorkClient(db.url, db.pool);
    work = await composeWork([registerContent], {
      databaseUrl: db.url,
      pool: db.pool,
      client,
      receiptKeys: testReceiptKeys(),
      executorId: `admission-growth-${randomUUID()}`,
      env: workerTestEnv({
        CONTENT_TEST_COLLECTION_PARTITIONS: '0',
        KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
      }),
    });
    await work.launch();
    // Selection is a real HTTP command, never a SQL-synthesized result.
    const first = await submit(selectedKey.toUpperCase(), mint());
    expect(first.status).toBe(201);
    expect(first.body.reportId).toBe(selected.id);
    expect(home(selectedKey.toUpperCase())).toEqual(selected);
    const source = (
      await db.admin.query<{ epoch: number; position: string; event_seq: number }>(
        'SELECT epoch,position::text,event_seq FROM core.outbox WHERE type=$1 AND subject=$2',
        [sourceType, selected.id],
      )
    ).rows;
    expect(source).toHaveLength(1);
    const event = source[0]!;
    // Completion uses the exact production relay and registered DBOS effect.
    const delivered = await relayEffects(db.pool, work.effects, partitionOf(selected.route));
    expect(delivered.status).toBe('read');
    await client
      .retrieveWorkflow(
        `fx:${event.epoch}:${partitionOf(selected.route)}:${event.position}:${event.event_seq}:content_report_target`,
      )
      .getResult({ pollingIntervalMs: 10 });
    const baseline = await snapshot();
    expect(baseline.reports).toHaveLength(1);
    expect(baseline.receipts).toHaveLength(1);
    expect(baseline.targets).toHaveLength(1);
    expect(baseline.events.filter((row) => row.type === sourceType)).toHaveLength(1);
    expect(baseline.events.filter((row) => row.type === projectionType)).toHaveLength(1);

    return {
      db,
      close,
      selected,
      baseline,
      proofs,
      input,
      snapshot,
      totals,
      visibility,
      get providerCalls() {
        return providerCalls;
      },
      async run(branch: Branch) {
        const key = rejectedKeys.get(branch) ?? selectedKey;
        const token =
          branch === 'missing'
            ? undefined
            : branch === 'invalid'
              ? 'invalid-proof'
              : branch === 'unavailable'
                ? 'provider-unavailable'
                : mint();
        const result = await submit(key, token, branch === 'conflict' ? 'other' : input.reason);
        // No report command/effect is due on these branches. Include the registered
        // relay's empty source read rather than assuming that no queued work exists.
        const empty = await relayEffects(db.pool, work!.effects, partitionOf(home(key).route));
        if (empty.status !== 'read') throw new Error(`Admission relay did not read: ${empty.status}`);
        expect(empty.envelopes).toBe(0);
        return result;
      },
      population(axis: Axis, branch: Branch) {
        const commandHome = home(rejectedKeys.get(branch) ?? selectedKey);
        const transactionIds: string[] = [];
        const ids: string[] = [];
        const population: Population = {
          name: `anonymous-admission-${axis}-${branch}`,
          hotPartition: axis === 'grants' ? partitionOf(boardRoute) : partitionOf(commandHome.route),
          hotShare: 1,
          rows() {
            const tx = randomUUID();
            transactionIds.push(tx);
            const route = axis === 'grants' ? boardRoute : commandHome.route;
            const id = newId(route);
            ids.push(id);
            const rows: Record<string, Row[]> =
              axis === 'reports'
                ? {
                    'content.report': [
                      {
                        route,
                        report_id: id,
                        target_kind: 'board',
                        target_id: newId(boardRoute),
                        revision_id: null,
                        reason: 'spam',
                        evidence: 'Unrelated report evidence',
                        reporter_account_id: null,
                        created_at: '2026-01-01T00:00:00.000Z',
                        recorded_transaction_id: tx,
                      },
                    ],
                  }
                : axis === 'receipts'
                  ? {
                      'core.receipt': [
                        {
                          partition_no: partitionOf(route),
                          principal_id: anonymous,
                          principal_kind: 'anonymous',
                          command_kind: operation,
                          idempotency_key: randomUUID(),
                          request_digest: createHash('sha256').update(tx).digest(),
                          epoch: 1,
                          position: 0,
                          transaction_id: tx,
                          response: { reportId: id },
                        },
                      ],
                    }
                  : {
                      'access.resource_grant': [
                        {
                          route,
                          resource_id: board,
                          subject_id: newId(0x1234),
                          subject_kind: 'identity',
                          subject_role: '',
                          action: 'report:create',
                          valid: '(,)',
                          transaction_id: tx,
                        },
                      ],
                    };
            return rows;
          },
        };
        return {
          async grow(scale: number, previous: number) {
            await seed(db, population, { from: previous, to: scale });
            const table =
              axis === 'reports' ? 'content.report' : axis === 'receipts' ? 'core.receipt' : 'access.resource_grant';
            const column = axis === 'reports' ? 'recorded_transaction_id' : 'transaction_id';
            const result = await db.admin.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM ${table} WHERE ${column}=ANY($1::uuid[])`,
              [transactionIds],
            );
            expect(result.rows[0]!.count).toBe(scale);
          },
          async clear() {
            // Only rows authored by this private population are removed, outside capture.
            if (axis === 'reports')
              await db.admin.query('DELETE FROM content.report WHERE report_id=ANY($1::uuid[])', [ids]);
            else if (axis === 'receipts')
              await db.admin.query('DELETE FROM core.receipt WHERE transaction_id=ANY($1::uuid[])', [transactionIds]);
            else
              await db.admin.query('DELETE FROM access.resource_grant WHERE transaction_id=ANY($1::uuid[])', [
                transactionIds,
              ]);
          },
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
