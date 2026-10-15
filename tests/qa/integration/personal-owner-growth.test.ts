import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { importDigest, LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { emptyRow, FILE_IMPORT_COST } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startMediaStack } from './media-support.ts';
import { LibraryLoanStore, type LoanState } from '../../../services/main/src/modules/library/loans.ts';
import { LIBRARY_RECORD_COST, type CopyState } from '../../../services/main/src/modules/library/copies.ts';
import { NotificationStore, NOTIFICATION_LIMITS } from '../../../services/main/src/modules/notification/store.ts';
import { RELATIONSHIP_RECIPIENT_COST } from '../../../services/main/src/modules/follows/recipients.ts';

interface Plan {
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
}
type Sample = { operation: string; size: number; statements: number; returned: number; examined: number; ms: number };
const id = () => `https://rezics.com/id/${randomUUID()}`;

// Count the leaves that touched owner tables, including rows discarded below
// LIMIT/aggregate. A one-row count result is not one row of database work.
function examined(plan: Plan): number {
  return (plan['Relation Name'] ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)
    + (plan['Rows Removed by Index Recheck'] ?? 0)) * plan['Actual Loops'] : 0)
    + (plan.Plans ?? []).reduce((sum, child) => sum + examined(child), 0);
}

function meter(pool: Pool) {
  let active: Sample | undefined;
  type Result = { rows: Array<Record<string, unknown>>; rowCount: number | null };
  const wrap = <T extends Pool | PoolClient>(target: T): T => new Proxy(target, {
    get(owner, key) {
      if (key === 'connect') return async () => wrap(await pool.connect());
      if (key === 'query') return async (sql: string, values?: unknown[]) => {
        const query = owner.query.bind(owner) as (sql: string, values?: unknown[]) => Promise<Result>;
        const result = await query(sql, values);
        if (active) {
          active.statements++;
          active.returned += result.rows.length;
          if (/^\s*(?:SELECT|WITH)\b/i.test(sql) && /\b(?:reader|structure|access)\./.test(sql)) {
            const explained = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
            const plan = (explained.rows[0]?.['QUERY PLAN'] as Array<{ Plan: Plan }>)[0]!.Plan;
            active.examined += examined(plan);
          }
        }
        return result;
      };
      const value: unknown = Reflect.get(owner, key, owner);
      return typeof value === 'function' ? value.bind(owner) : value;
    },
  });
  return { pool: wrap(pool), async measure(operation: string, size: number, read: () => Promise<unknown>) {
    const sample: Sample = { operation, size, statements: 0, returned: 0, examined: 0, ms: 0 };
    active = sample;
    const start = performance.now();
    try { await read(); } finally { active = undefined; sample.ms = performance.now() - start; }
    return sample;
  } };
}

test('shelf counts and import progress touch summaries as each reader inventory grows', async () => {
  const stack = await startMediaStack('personal-owner-growth');
  const samples: Sample[] = [];
  try {
    const measured = meter(stack.contentPool);
    const statuses = new ReaderLibraryStatusStore(measured.pool);
    const files = new LibraryFileStore(measured.pool);
    const agent = id();
    let previousSize = 0;
    let previousFile: string | undefined;
    for (const size of [32, 128, 512]) {
      // Grow one reader's inventory with the same seed method/distribution.
      // Replace the upload so planner choices cannot measure earlier scale fixtures.
      if (previousFile) await files.delete(agent, previousFile, `delete:${previousSize}`);
      for (let index = previousSize; index < size; index++) await statuses.write({ agent, work: id(), status: 'read',
        expectedVersion: 0, idempotencyKey: `seed:${index}`, finishedOn: '2026-10-01' });
      const rows = Array.from({ length: size }, (_, index) => ({ ...emptyRow(`row:${index}`, '', {}), kind: 'retained' as const }));
      const file = await files.create(agent, `growth:${size}`, importDigest(rows), 'rezics', rows);
      await files.complete(agent, file.id, 0, { applied: [], issues: ['unresolved-work'] });
      await stack.contentPool.query('ANALYZE reader.library_status');
      await stack.contentPool.query('ANALYZE reader.library_import_source_row');
      samples.push(await measured.measure('shelf-counts', size, async () => {
        expect(await statuses.counts(agent)).toEqual({ read: size, reading: 0, 'want-to-read': 0 });
      }));
      samples.push(await measured.measure('shelf-filters', size, async () => {
        expect((await statuses.shelves(agent)).find(row => row.status === 'read')?.count).toBe(size);
      }));
      for (const sort of ['added', 'finished', 'title', 'rating', 'last-read'] as const) {
        samples.push(await measured.measure(`shelf-page-${sort}`, size, async () => {
          expect(await statuses.sortedPage(agent, 'read', 20, sort, 'asc')).toHaveLength(20);
        }));
      }
      samples.push(await measured.measure('import-progress', size, async () => {
        expect(await files.progress(agent, file.id)).toMatchObject({ total: size, completed: 1, issues: 1 });
      }));
      samples.push(await measured.measure('import-batch', size, async () => {
        expect(await files.pending(agent, file.id)).toHaveLength(FILE_IMPORT_COST.page);
      }));
      previousSize = size;
      previousFile = file.id;
    }
    console.table(samples);
    // Existing page bounds; these are examined rows, not returned aggregate rows.
    for (const sample of samples) expect(sample.examined, JSON.stringify(sample)).toBeLessThanOrEqual(
      sample.operation === 'import-batch' ? 40 : sample.operation.startsWith('shelf-page-') ? 20
        : sample.operation === 'shelf-filters' ? 6 : 3);
    // Transitions, retries, rollback and cascade deletion must preserve exact
    // counters; a cheaper incorrect count cannot satisfy the growth contract.
    const target = id();
    await statuses.write({ agent, work: target, status: 'reading', expectedVersion: 0, idempotencyKey: 'transition:1' });
    expect(await statuses.counts(agent)).toEqual({ read: 512, reading: 1, 'want-to-read': 0 });
    const transition = { agent, work: target, status: 'read' as const, expectedVersion: 1, idempotencyKey: 'transition:2' };
    await statuses.write(transition); await statuses.write(transition);
    expect(await statuses.counts(agent)).toEqual({ read: 513, reading: 0, 'want-to-read': 0 });
    await statuses.write({ agent, work: target, status: null, expectedVersion: 2, idempotencyKey: 'transition:3' });
    expect(await statuses.counts(agent)).toEqual({ read: 512, reading: 0, 'want-to-read': 0 });
    await files.complete(agent, previousFile!, 0, { applied: [], issues: [] });
    expect(await files.progress(agent, previousFile!)).toMatchObject({ total: 512, completed: 1, issues: 1 });
    const client = await stack.contentPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM reader.library_status WHERE agent=$1 AND work=$2', [agent, target]);
      await client.query('UPDATE reader.library_import_source_row SET outcome=NULL WHERE agent=$1 AND file_id=$2 AND row_number=0', [agent, previousFile]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect(await files.progress(agent, previousFile!)).toMatchObject({ total: 512, completed: 1, issues: 1 });
  } finally {
    const directory = `.temp/personal-authoring-growth/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/owner.json`, JSON.stringify(samples, null, 2) + '\n');
    await stack.stop();
  }
}, 300_000);

test('loan filters and one loan mutation keep a page neighbourhood as history grows', async () => {
  const stack = await startMediaStack('loan-owner-growth');
  const samples: Sample[] = [];
  try {
    const measured = meter(stack.contentPool), store = new LibraryLoanStore(measured.pool);
    const work = id(), release = id(), agent = id();
    let selected: LoanState | undefined;
    const seed = async (owner: string, count: number) => {
      const now = new Date().toISOString();
      const copies: CopyState[] = Array.from({ length: count }, () => ({ id: id(), work, release, format: null,
        acquiredFrom: null, acquiredAt: null, ownedFrom: null, ownedThrough: null, removed: false, version: 1, changedAt: now }));
      const loans: LoanState[] = copies.map((copy, index) => ({ id: id(), copy: copy.id, direction: 'lent',
        counterparty: { kind: 'name', name: 'Reader' }, startedAt: '2026-01-01T00:00:00.000Z',
        dueAt: '2026-02-01T00:00:00.000Z', returnedAt: index % 2 ? null : now, version: 1, changedAt: now }));
      await stack.contentPool.query(`INSERT INTO reader.library_copy(agent,id,work,release,state,version)
        SELECT $1,s->>'id',s->>'work',s->>'release',s,1 FROM jsonb_array_elements($2::jsonb) s`, [owner, JSON.stringify(copies)]);
      await stack.contentPool.query(`INSERT INTO reader.library_loan(agent,id,copy,state,due_at,returned_at,version)
        SELECT $1,s->>'id',s->>'copy',s,(s->>'dueAt')::timestamptz,(s->>'returnedAt')::timestamptz,1
        FROM jsonb_array_elements($2::jsonb) s`, [owner, JSON.stringify(loans)]);
      return loans[1]!;
    };
    // Keep ordinary background data fixed, so the first scale exercises the
    // same indexed plan as a populated service rather than an empty-table scan.
    await seed(id(), 1024);
    let previous = 0;
    for (const size of [32, 128, 512]) {
      selected = await seed(agent, size - previous);
      await stack.contentPool.query('ANALYZE reader.library_loan');
      for (const state of ['active', 'overdue', 'returned'] as const) samples.push(await measured.measure(`loans-${state}`, size, async () => {
        const page = await store.page(agent, { state });
        expect(page.items.length).toBe(Math.min(size / 2, LIBRARY_RECORD_COST.page));
        expect(page.items.every(loan => state === 'returned' ? loan.returnedAt !== null : loan.returnedAt === null)).toBe(true);
      }));
      samples.push(await measured.measure('loan-extend', size, async () => {
        expect(await store.write({ operation: 'extend', agent, id: selected!.id, expectedVersion: 1,
          idempotencyKey: `extend:${size}`, dueAt: '2026-03-01T00:00:00.000Z' })).toMatchObject({ version: 2 });
      }));
      previous = size;
    }
    console.table(samples);
    for (const sample of samples) {
      expect(sample.examined, JSON.stringify(sample)).toBeLessThanOrEqual(sample.operation === 'loan-extend' ? 3 : LIBRARY_RECORD_COST.pageRows + 2);
      expect(sample.statements, JSON.stringify(sample)).toBeLessThanOrEqual(sample.operation === 'loan-extend' ? LIBRARY_RECORD_COST.writeStatements : LIBRARY_RECORD_COST.pageStatements);
    }
  } finally {
    const directory = `.temp/personal-authoring-growth/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/loans.json`, JSON.stringify(samples, null, 2) + '\n');
    await stack.stop();
  }
}, 300_000);

test('notification intake enqueues one bounded audience batch as followers grow', async () => {
  const stack = await startMediaStack('notification-owner-growth');
  const samples: Sample[] = [];
  try {
    const measured = meter(stack.accessPool), notifications = new NotificationStore(measured.pool);
    const work = id(), author = id();
    await stack.accessPool.query(`INSERT INTO access.authority_subject(id,kind) VALUES($1,'agent'),($2,'agent')`, [work, author]);
    let previous = 0;
    for (const size of [512, 1024, 2048]) {
      const principals = Array.from({ length: size - previous }, () => randomUUID());
      await stack.accessPool.query(`INSERT INTO access.principal(id,account_issuer,account_subject)
        SELECT id,'notification-growth',id::text FROM unnest($1::uuid[]) id`, [principals]);
      await stack.accessPool.query(`INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,level)
        SELECT id,$2,'work',$3,true,gen_random_uuid(),'all' FROM unnest($1::uuid[]) id`, [principals, work, author]);
      await stack.accessPool.query('ANALYZE access.follow');
      samples.push(await measured.measure('notification-batch', size, async () => {
        const batch = await notifications.enqueue({ sourceOwner: 'access', sourceEvent: `growth:${work}:${size}`,
          purpose: 'subscription', topic: 'followed-chapter', subject: { owner: 'graph', ref: work, revision: null },
          disclosureBasis: 'followed-chapter-v1', recipients: [], relationshipPlan: { targets: [work], highlights: false } });
        expect(batch).toHaveLength(RELATIONSHIP_RECIPIENT_COST.examinedPerBatch);
        expect(batch.complete).toBe(false);
        expect(batch.length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.recipientsPerEvent);
      }));
      previous = size;
    }
    console.table(samples);
    for (const sample of samples) {
      expect(sample.statements, JSON.stringify(sample)).toBeLessThanOrEqual(samples[0]!.statements);
      expect(sample.examined, JSON.stringify(sample)).toBeLessThanOrEqual(Math.ceil(samples[0]!.examined * 1.2));
    }
  } finally {
    const directory = `.temp/personal-authoring-growth/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/notifications.json`, JSON.stringify(samples, null, 2) + '\n');
    await stack.stop();
  }
}, 300_000);
