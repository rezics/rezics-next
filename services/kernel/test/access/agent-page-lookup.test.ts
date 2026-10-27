import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { AgentVerificationPageConflictError, writeAgentVerificationPage } from '../../src/access/agent-verification.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { migrate } from '../../scripts/database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL must name the migrated test database');
const accountRoute = 0x5234;
const subjectRoute = 0x6543;
const routeKey = new Uint8Array(32).fill(37);
const clock = () => new Date();
let admin: Pool;
let databaseName: string;
let pool: ReturnType<typeof createPool>;
let kernel: ReturnType<typeof createKernel>;

type AccountSeed = {
  id: string;
  handle: string | null;
  state?: 'active' | 'deleted';
  verified?: boolean;
  subjectId?: string | null;
};

async function seedAccount(seed: AccountSeed): Promise<void> {
  const receiptId = seed.verified ? newId(0) : null;
  await pool.query(
    `INSERT INTO access.account
      (route, account_id, kind, handle, display_name, state, transaction_id,
       agent_verified, agent_subject_id, agent_verification_receipt_id)
     VALUES ($1, $2, 'actor', $3, $4, $5, $2, $6, $7, $8)`,
    [
      accountRoute,
      seed.id,
      seed.handle,
      seed.handle ? seed.handle.replaceAll('_', ' ') : null,
      seed.state ?? 'active',
      seed.verified ?? false,
      seed.subjectId ?? null,
      receiptId,
    ],
  );
}

async function seedPointer(subjectId: string, accountId: string, receiptId = newId(0)): Promise<void> {
  await pool.query(
    `INSERT INTO access.agent_page(route, subject_id, account_id, verification_receipt_id)
     VALUES ($1, $2, $3, $4)`,
    [routeOf(subjectId), subjectId, accountId, receiptId],
  );
}

async function get(path: string) {
  const response = await kernel.handle(new Request(`https://kernel.test${path}`));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeAll(async () => {
  admin = new Pool({ connectionString: sourceUrl, max: 1 });
  databaseName = `agent_page_lookup_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(sourceUrl);
  target.pathname = `/${databaseName}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  migrate(target.toString());
  pool = createPool(target.toString());
  kernel = createKernel({ pool, routeKey, clock });

  const verifiedSubject = newId(subjectRoute);
  const verifiedAccountId = newId(accountRoute);
  const verifiedReceipt = newId(0);
  await pool.query(
    `INSERT INTO access.account
      (route, account_id, kind, handle, display_name, state, transaction_id,
       agent_verified, agent_subject_id, agent_verification_receipt_id)
     VALUES ($1, $2, 'actor', 'agent_page_person', 'Agent Page Person', 'active', $2, true, $3, $4)`,
    [accountRoute, verifiedAccountId, verifiedSubject, verifiedReceipt],
  );
  const handleRoute = createHash('sha256').update('agent_page_person').digest().readUInt16BE(0);
  await pool.query(
    `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
     VALUES ($1, 'agent_page_person', $2, 'active', $2)`,
    [handleRoute, verifiedAccountId],
  );
  await seedPointer(verifiedSubject, verifiedAccountId, verifiedReceipt);

  const unverifiedAccountId = newId(accountRoute);
  const unverifiedSubject = newId(subjectRoute);
  await seedAccount({ id: unverifiedAccountId, handle: 'agent_page_unverified' });
  await seedPointer(unverifiedSubject, unverifiedAccountId);

  const mismatchAccountId = newId(accountRoute);
  const actualSubject = newId(subjectRoute);
  const staleSubject = newId(subjectRoute);
  await seedAccount({
    id: mismatchAccountId,
    handle: 'agent_page_mismatch',
    verified: true,
    subjectId: actualSubject,
  });
  await seedPointer(staleSubject, mismatchAccountId);

  const deletedAccountId = newId(accountRoute);
  const deletedSubject = newId(subjectRoute);
  await seedAccount({
    id: deletedAccountId,
    handle: null,
    state: 'deleted',
    verified: true,
    subjectId: deletedSubject,
  });
  await seedPointer(deletedSubject, deletedAccountId);
}, 60_000);

afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    try {
      if (databaseName) await dropTestDatabase(admin, databaseName);
    } finally {
      await admin?.end();
    }
  }
}, 30_000);

test('verified agent subject lookup returns the same public identity as its handle', async () => {
  const { rows } = await pool.query<{ subject_id: string }>(
    `SELECT subject_id::text FROM access.agent_page WHERE route = $1 AND account_id = (
       SELECT account_id FROM access.handle_claim WHERE normalized_handle = 'agent_page_person' AND state = 'active'
     )`,
    [subjectRoute],
  );
  const subjectId = rows[0]!.subject_id;
  const bySubject = await get(`/v1/accounts?agent=${subjectId}`);
  const byHandle = await get('/v1/accounts?handle=agent_page_person');

  expect(bySubject).toEqual(byHandle);
  expect(bySubject.status).toBe(200);
  expect(bySubject.body.accounts[0]).toMatchObject({
    handle: 'agent_page_person',
    state: 'active',
    verified: true,
    subject: null,
  });
});

test('unknown, unverified, stale and deleted agent pointers answer like an unknown handle', async () => {
  const { rows: subjects } = await pool.query<{ subject_id: string }>(
    `SELECT page.subject_id::text
     FROM access.agent_page AS page
     LEFT JOIN access.account AS account
       ON account.route = $2 AND account.account_id = page.account_id
     WHERE page.route = $1
       AND (account.account_id IS NULL OR account.state = 'deleted' OR NOT account.agent_verified
         OR account.agent_subject_id IS DISTINCT FROM page.subject_id)
     ORDER BY page.subject_id`,
    [subjectRoute, accountRoute],
  );
  const unknown = newId(subjectRoute);
  expect(subjects.map(({ subject_id }) => subject_id)).not.toContain(unknown);
  const unknownHandle = await get('/v1/accounts?handle=agent_page_unknown');
  expect(unknownHandle).toEqual({ status: 200, body: { accounts: [], next: null } });

  for (const subjectId of [unknown, ...subjects.map(({ subject_id }) => subject_id)]) {
    const result = await get(`/v1/accounts?agent=${subjectId}`);
    expect(result).toEqual(unknownHandle);
  }
});

test('replayed pointer writes converge and a subject already naming another account fails typed', async () => {
  const subjectId = newId(subjectRoute);
  const accountId = newId(accountRoute);
  const request = {
    id: newId(0),
    accountId,
    accountKind: 'actor' as const,
    requestedBy: newId(accountRoute),
    catalogueSubjectId: subjectId,
    state: 'approving' as const,
    decisionReceiptId: newId(0),
  };
  const input = { ...request, receiptId: request.decisionReceiptId };
  await writeAgentVerificationPage(pool, input);
  await writeAgentVerificationPage(pool, input);
  const saved = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM access.agent_page WHERE route = $1 AND subject_id = $2',
    [subjectRoute, subjectId],
  );
  expect(saved.rows[0]!.count).toBe('1');

  await expect(
    writeAgentVerificationPage(pool, { ...request, id: newId(0), accountId: newId(accountRoute), receiptId: newId(0) }),
  ).rejects.toBeInstanceOf(AgentVerificationPageConflictError);
});
