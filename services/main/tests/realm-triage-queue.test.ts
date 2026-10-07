import { afterAll, beforeAll, expect, test } from 'bun:test';
import { realmTriageQueueDatabase } from './realm-triage-queue-fixture.ts';
import { ManagementReadMissing } from '../src/modules/management-reads/read-store.ts';
import { WorkReadMoved } from '../src/modules/work/read-session.ts';
import type { Static } from 'typebox';
import type { moderationPage } from '../src/modules/management-reads/read-contract.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManagementReadStore } from '../src/modules/management-reads/read-store.ts';
import type { Pool } from 'pg';

let database: Awaited<ReturnType<typeof realmTriageQueueDatabase>>;
beforeAll(async () => {
  database = await realmTriageQueueDatabase();
}, 60_000);
afterAll(async () => {
  await database?.stop();
});

test('Realm triage keeps incomplete enforcement and later correspondence in its private waiting queue', async () => {
  const h = await database.fixture();
  try {
    await h.newCase();
    await h.newCase();
    const caseId = await h.newCase('rights_complaint');
    await h.report(caseId);
    await h.escalate(caseId);
    const options = { actingSubject: h.actor, limit: 20 };
    const page = async (state: 'open' | 'closed', cursor?: string) =>
      (await h.store.moderation(
        h.principal,
        h.realm,
        { ...options, ...(cursor ? { limit: 1, cursor } : {}) },
        state,
        null,
      )) as Static<typeof moderationPage>;
    const observed: {
      stage: string;
      pending: boolean;
      listed: boolean;
      decided: boolean;
      openCount: number;
      escalatedCount: number;
    }[] = [];
    const capture = async (stage: string) => {
      const snapshot = await h.snapshot(caseId);
      const [waiting, decided] = await Promise.all([page('open'), page('closed')]);
      observed.push({
        stage,
        pending: snapshot.reviewPending,
        listed: waiting.items.some((item) => item.id === caseId),
        decided: decided.items.some((item) => item.id === caseId),
        openCount: snapshot.openCount,
        escalatedCount: snapshot.escalatedCount,
      });
    };
    await capture('reported');
    const decision = await h.decide(caseId);
    await capture('pending');
    await h.confirm(decision, 1);
    await capture('partial');
    const before = await h.snapshot(caseId);
    const continuation = await h.store.moderation(
      h.principal,
      h.realm,
      { actingSubject: h.actor, limit: 1 },
      'open',
      null,
    );
    expect(continuation.nextCursor).toBeString();
    await h.confirm(decision, 2);
    const completed = await h.snapshot(caseId);
    await capture('completed');
    await h.report(caseId);
    await capture('new report');
    await h.decide(caseId, 0);
    await capture('report answered');
    const appeal = await h.step(caseId, (await h.snapshot(caseId)).decisionHead!, 'appeal');
    await capture('appeal');
    const answer = await h.decide(caseId, 0, appeal);
    await capture('appeal answered');
    const counter = await h.step(caseId, answer, 'counter_notice');
    await capture('counter-notice');
    const next = await h.decide(caseId, 2, counter);
    await h.confirm(next, 1);
    await h.cancel(next);
    await capture('cancelled partial');
    await h.decide(caseId, 0);
    await capture('replacement completed');
    await h.close(caseId);
    await capture('closed');

    const pendingStages = new Set([
      'reported',
      'pending',
      'partial',
      'new report',
      'appeal',
      'counter-notice',
      'cancelled partial',
    ]);
    const expected = observed.map(({ stage }) => {
      const pending = pendingStages.has(stage);
      return {
        stage,
        pending,
        listed: pending,
        decided: !pending,
        openCount: pending ? 3 : 2,
        escalatedCount: pending ? 1 : 0,
      };
    });
    if (JSON.stringify(observed) !== JSON.stringify(expected))
      console.info('Realm triage PostgreSQL counterexample', observed);
    expect(observed).toEqual(expected);
    // Completion only changes the projected pending flag. It must fence the
    // same cursor and decrement the point aggregates once.
    expect(BigInt(completed.revision)).toBe(BigInt(before.revision) + 1n);
    await expect(page('open', continuation.nextCursor!)).rejects.toBeInstanceOf(WorkReadMoved);
    const unchanged = await h.snapshot(caseId);
    await h.pending(caseId);
    expect(await h.snapshot(caseId)).toEqual(unchanged);
    await expect(
      h.store.moderation(
        h.outsider.principal,
        h.realm,
        { actingSubject: h.outsider.actor },
        'open',
        null,
      ),
    ).rejects.toBeInstanceOf(ManagementReadMissing);
    await expect(
      h.store.moderation(h.principal, h.realm, { actingSubject: h.outsider.actor }, 'closed', null),
    ).rejects.toBeInstanceOf(ManagementReadMissing);
    expect(
      (await h.store.moderation(h.principal, h.realm, options, 'open', 'rights_complaint')).items,
    ).toEqual([]);
    expect(
      (await h.store.moderation(h.principal, h.realm, options, 'closed', 'rights_complaint')).items,
    ).toMatchObject([{ id: caseId, state: 'closed' }]);
  } finally {
    await h.stop();
  }
}, 120_000);

test('forward Realm queue migration repairs retained counts and fences the old cursor without changing other owner facts', async () => {
  const h = await database.fixture({ beforeQueueMigration: true });
  try {
    await h.newCase();
    await h.newCase();
    const pending = await h.newCase();
    const partial = await h.decide(pending);
    await h.confirm(partial, 1);
    await h.escalate(pending);
    const cancelled = await h.newCase();
    await h.cancel(await h.decide(cancelled));
    await h.escalate(cancelled);
    const reopened = await h.newCase();
    await h.step(reopened, await h.decide(reopened, 0), 'appeal');
    await h.escalate(reopened);
    const completed = await h.newCase();
    await h.decide(completed, 0);
    await h.escalate(completed);
    const before = await h.snapshot(pending);
    expect(before).toMatchObject({ reviewPending: true, openCount: 2, escalatedCount: 0 });
    const page = await h.store.moderation(
      h.principal,
      h.realm,
      { actingSubject: h.actor, limit: 1 },
      'open',
      null,
    );
    expect(page.nextCursor).toBeString();
    // Unrelated submission point facts must survive the report backfill.
    await h.pool.query(
      `UPDATE access.realm_management_activity SET open_submissions = 7,
      escalated_submissions = 3,submission_activity = '2001-01-01T00:00:00Z',admin_activity = '2002-01-01T00:00:00Z' WHERE realm = $1`,
      [h.realm],
    );
    const facts = async () =>
      (
        await h.pool.query(
          `SELECT open_submissions,escalated_submissions,
      report_activity,submission_activity,admin_activity FROM access.realm_management_activity WHERE realm = $1`,
          [h.realm],
        )
      ).rows[0];
    const unchanged = await facts();
    const migration = readFileSync(
      join(import.meta.dir, '../migrations/access/1767_realm_review_pending_queue.sql'),
      'utf8',
    );
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await h.snapshot(pending)).toMatchObject({ openCount: 5, escalatedCount: 3 });
    expect(BigInt((await h.snapshot(pending)).revision)).toBe(BigInt(before.revision) + 1n);
    expect(await facts()).toEqual(unchanged);
    await expect(
      h.store.moderation(
        h.principal,
        h.realm,
        { actingSubject: h.actor, limit: 1, cursor: page.nextCursor! },
        'open',
        null,
      ),
    ).rejects.toBeInstanceOf(WorkReadMoved);
    await h.report(completed);
    expect(await h.snapshot(completed)).toMatchObject({
      reviewPending: true,
      openCount: 6,
      escalatedCount: 4,
    });
    await h.confirm(partial, 2);
    expect(await h.snapshot(pending)).toMatchObject({
      reviewPending: false,
      openCount: 5,
      escalatedCount: 3,
    });
    const refreshed = await h.snapshot(pending);
    await h.pending(pending);
    expect(await h.snapshot(pending)).toEqual(refreshed);
  } finally {
    await h.stop();
  }
}, 120_000);

type Plan = {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
};
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

test('Realm waiting and decided pages seek their own kind and state across large retained and unrelated histories', async () => {
  const h = await database.fixture();
  try {
    const waiting = await h.newCase('rights_complaint');
    await h.decide(waiting);
    const decided = await h.newCase('rights_complaint');
    await h.decide(decided, 0);
    // Long completed histories must not be scanned to find one waiting case,
    // or one rights complaint after thousands of other kinds.
    await h.pool.query(
      `INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure,opened_at)
      SELECT gen_random_uuid(),'content_report','realm',$1,$2,'content','urn:triage:history:' || n,
        'body','private','2000-01-01T00:00:00Z'::timestamptz + n * interval '1 microsecond'
      FROM generate_series(1,3000) n`,
      [h.scope, h.realm],
    );
    await h.pool.query(
      `UPDATE access.governance_case SET state = 'closed',closed_at = clock_timestamp()
      WHERE authority_scope_id = $1 AND target_resource LIKE 'urn:triage:history:%'`,
      [h.scope],
    );
    const otherRealm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
    const otherScope = `governance:realm:${otherRealm}`;
    await h.pool.query('INSERT INTO access.scope_gate(id) VALUES ($1)', [otherScope]);
    await h.pool.query(
      `INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      SELECT gen_random_uuid(),'content_report','realm',$1,$2,'content','urn:triage:unrelated:' || n,'body','private'
      FROM generate_series(1,1000) n`,
      [otherScope, otherRealm],
    );
    await h.pool.query('ANALYZE access.governance_case');
    let query = '',
      values: unknown[] = [];
    const pool = new Proxy(h.pool, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, member) {
                if (member === 'query')
                  return (sql: string, args?: unknown[]) => {
                    if (sql.includes('SELECT candidates.*')) {
                      query = sql;
                      values = args ?? [];
                    }
                    return connection.query(sql, args);
                  };
                const value = Reflect.get(connection, member);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Pool;
    const store = new ManagementReadStore(pool, h.environment);
    for (const state of ['open', 'closed'] as const) {
      for (const kind of [null, 'rights_complaint'] as const) {
        const first = await store.moderation(
          h.principal,
          h.realm,
          { actingSubject: h.actor, limit: 1 },
          state,
          kind,
        );
        if (kind)
          expect(first.items).toMatchObject([{ id: state === 'open' ? waiting : decided, state }]);
        const explain = (await h.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, values))
          .rows[0]!['QUERY PLAN'][0].Plan as Plan;
        const scans = nodes(explain).filter((node) => node['Relation Name'] === 'governance_case');
        expect(scans).toHaveLength(1);
        expect(scans[0]!['Node Type']).toMatch(/Index/);
        expect(scans[0]!['Index Name']).toBe(
          `governance_case_realm_${state === 'open' ? 'waiting' : 'decided'}${kind ? '_kind' : ''}_page`,
        );
        expect(
          (scans[0]!['Actual Rows'] + (scans[0]!['Rows Removed by Filter'] ?? 0)) *
            scans[0]!['Actual Loops'],
        ).toBeLessThanOrEqual(2);
        if (first.nextCursor) {
          const next = await store.moderation(
            h.principal,
            h.realm,
            { actingSubject: h.actor, limit: 1, cursor: first.nextCursor },
            state,
            kind,
          );
          expect(next.items).not.toEqual(first.items);
        }
      }
    }
  } finally {
    await h.stop();
  }
}, 120_000);

test('concurrent correspondence reopens one escalation and repeated pending refresh cannot duplicate counts', async () => {
  const h = await database.fixture();
  try {
    const caseId = await h.newCase();
    await h.report(caseId);
    const decision = await h.decide(caseId, 0);
    // Escalating completed work must not contribute until it needs review.
    await h.escalate(caseId);
    expect(await h.snapshot(caseId)).toMatchObject({
      reviewPending: false,
      openCount: 0,
      escalatedCount: 0,
    });
    await Promise.all([h.report(caseId), h.step(caseId, decision, 'appeal')]);
    expect(await h.snapshot(caseId)).toMatchObject({
      reviewPending: true,
      openCount: 1,
      escalatedCount: 1,
    });
    const before = await h.snapshot(caseId);
    await Promise.all([h.pending(caseId), h.pending(caseId)]);
    expect(await h.snapshot(caseId)).toEqual(before);
    const replacement = await h.decide(caseId);
    await Promise.all([h.confirm(replacement, 1), h.confirm(replacement, 2)]);
    expect(await h.snapshot(caseId)).toMatchObject({
      reviewPending: false,
      openCount: 0,
      escalatedCount: 0,
    });
    await h.pool.query('UPDATE access.permission_grant SET active = false WHERE scope_id = $1', [
      h.scope,
    ]);
    await expect(
      h.store.moderation(h.principal, h.realm, { actingSubject: h.actor }, 'closed', null),
    ).rejects.toBeInstanceOf(ManagementReadMissing);
  } finally {
    await h.stop();
  }
}, 120_000);
