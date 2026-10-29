import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { writeAgentVerificationPage } from '../../src/access/agent-verification.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const accountRoute = 0x5235;
const lookupSubjectRoute = 0x6544;
const writeSubjectRoute = 0x6545;
const routeKey = new Uint8Array(32).fill(43);
const targetAccount = newId(accountRoute);
const targetSubject = newId(lookupSubjectRoute);
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;

async function seedVerifiedPages(database: GrowthDatabase, count: number, subjectRoute: number): Promise<void> {
  const accountIds = Array.from({ length: count }, () => newId(accountRoute));
  const subjectIds = Array.from({ length: count }, () => newId(subjectRoute));
  await database.admin.query(
    `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, agent_verified, agent_subject_id,
       agent_verification_receipt_id)
     SELECT $1, account_id, 'actor', 'active', account_id, true, subject_id, account_id
     FROM unnest($2::uuid[], $3::uuid[]) AS seeded(account_id, subject_id)`,
    [accountRoute, accountIds, subjectIds],
  );
  await database.admin.query(
    `INSERT INTO access.agent_page(route, subject_id, account_id, verification_receipt_id)
     SELECT $1, subject_id, account_id, account_id
     FROM unnest($2::uuid[], $3::uuid[]) AS seeded(subject_id, account_id)`,
    [subjectRoute, subjectIds, accountIds],
  );
  await database.admin.query(
    `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_facts)
     SELECT $1, subject_id, 'schema:Person', subject_id, 1
     FROM unnest($2::uuid[]) AS seeded(subject_id)`,
    [subjectRoute, subjectIds],
  );
  await database.admin.query(
    `INSERT INTO semantic.fact(route, subject_id, slot_id, log_seq, operation, kind, language, body, recorded_transaction_id)
     SELECT $1, subject_id, subject_id, 1, 'assert', 'label', 'en', to_jsonb('Verified subject ' || subject_id::text), subject_id
     FROM unnest($2::uuid[]) AS seeded(subject_id)`,
    [subjectRoute, subjectIds],
  );
}

async function seedPendingWrite(database: GrowthDatabase, accountId: string, subjectId: string, receiptId: string) {
  await database.admin.query(
    `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, pending_agent_subject_id, pending_agent_receipt_id)
     VALUES ($1, $2, 'actor', 'active', $2, $3, $4)`,
    [accountRoute, accountId, subjectId, receiptId],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  kernel = createKernel({ pool: db.pool, routeKey });
  await db.admin.query(
    `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, agent_verified, agent_subject_id,
       agent_verification_receipt_id)
     VALUES ($1, $2, 'actor', 'active', $2, true, $3, $4)`,
    [accountRoute, targetAccount, targetSubject, newId(0)],
  );
  await db.admin.query(
    `INSERT INTO access.agent_page(route, subject_id, account_id, verification_receipt_id)
     VALUES ($1, $2, $3, $4)`,
    [lookupSubjectRoute, targetSubject, targetAccount, newId(0)],
  );
  await db.admin.query(
    `INSERT INTO semantic.subject(route, subject_id, type, recorded_transaction_id, current_facts)
     VALUES ($1, $2, 'schema:Person', $2, 1)`,
    [lookupSubjectRoute, targetSubject],
  );
  await db.admin.query(
    `INSERT INTO semantic.fact(route, subject_id, slot_id, log_seq, operation, kind, language, body, recorded_transaction_id)
     VALUES ($1, $2, $2, 1, 'assert', 'label', 'en', to_jsonb('Target verified subject'), $2)`,
    [lookupSubjectRoute, targetSubject],
  );
});

afterAll(async () => db?.close());

test('agent page lookup stays within its bound as unrelated verified subjects grow', async () => {
  const report = await checkGrowth(db, {
    name: 'agent page lookup stays within its bound as unrelated verified subjects grow',
    rule: 'series',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    async grow(database, scale, previous) {
      if (previous === 0) await seedVerifiedPages(database, 1024, lookupSubjectRoute);
      await seedVerifiedPages(database, scale - previous, lookupSubjectRoute);
    },
    async operation() {
      const response = await kernel.handle(new Request(`https://kernel.test/v1/accounts?agent=${targetSubject}`));
      const body = (await response.json()) as {
        accounts: { id: string; subject: { id: string; label: string; type: string } | null }[];
      };
      expect(response.status).toBe(200);
      expect(body.accounts.map(({ id }) => id)).toEqual([targetAccount]);
      expect(body.accounts[0]?.subject).toEqual({
        id: targetSubject,
        label: 'Target verified subject',
        type: 'schema:Person',
      });
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['access.agent_page']?.rows).toBe(1);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(1);
  }
}, 60_000);

test('agent page pointer write stays within its bound as subject pointers grow', async () => {
  let sequence = 0;
  const write = async (database: GrowthDatabase) => {
    sequence += 1;
    const accountId = newId(accountRoute);
    const subjectId = newId(writeSubjectRoute);
    const requestId = newId(0);
    const receiptId = newId(0);
    await seedPendingWrite(database, accountId, subjectId, receiptId);
    await writeAgentVerificationPage(database.pool, {
      id: requestId,
      accountId,
      accountKind: 'actor',
      requestedBy: accountId,
      catalogueSubjectId: subjectId,
      state: 'approving',
      decisionReceiptId: receiptId,
      receiptId,
    });
  };
  const report = await checkGrowth(db, {
    name: 'agent page pointer write stays within its bound as subject pointers grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    async grow(database, scale, previous) {
      const accountIds = Array.from({ length: scale - previous }, () => newId(accountRoute));
      const subjectIds = Array.from({ length: scale - previous }, () => newId(writeSubjectRoute));
      await database.admin.query(
        `INSERT INTO access.agent_page(route, subject_id, account_id, verification_receipt_id)
         SELECT $1, subject_id, account_id, account_id
         FROM unnest($2::uuid[], $3::uuid[]) AS seeded(subject_id, account_id)`,
        [writeSubjectRoute, subjectIds, accountIds],
      );
    },
    async operation(database) {
      await write(database);
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['access.agent_page']?.rows).toBeGreaterThan(0);
  }
  expect(sequence).toBeGreaterThan(0);
}, 60_000);
