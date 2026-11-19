import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { startAccountIdentityPublication } from '../support/identity-work-process.ts';
import { publishVerifiedAgentFixture } from '../support/verified-agent-fixture.ts';
import { createReceiptTestPool } from '../support/receipt-test-pool.ts';
import { AgentVerificationPageConflictError, writeAgentVerificationPage } from '../../src/access/agent-verification.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { migrate } from '../../scripts/database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL must name the migrated test database');
const accountRoute = 0x5234;
const subjectRoute = 0x6543;
const routeKey = Buffer.alloc(32, 37);
const clock = () => new Date();
let admin: Pool;
let databaseName: string;
let pool: Pool;
let kernel: ReturnType<typeof createKernel>;
let verification: Awaited<ReturnType<typeof publishVerifiedAgentFixture>>;
const verifiedSubject = newId(subjectRoute);
const verifiedAccountId = newId(accountRoute);
const invalidSubjects: string[] = [];

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
  pool = createReceiptTestPool(target.toString());
  kernel = createKernel({ pool, routeKey, clock });

  await bootstrapRelease(pool, bundledRelease);
  await seedAccount({ id: verifiedAccountId, handle: 'agent_page_person' });
  await ensureAccountAgent(pool, {
    account: verifiedAccountId,
    kind: 'person',
    name: 'Agent Page Person',
  });
  const publication = await startAccountIdentityPublication({
    databaseUrl: target.toString(),
    routeKey: routeKey.toString('base64url'),
    searchPrefix: `agent-page-${randomUUID().slice(0, 8)}-`,
    openSearchUrl: process.env.OPENSEARCH_URL,
  });
  try {
    verification = await publishVerifiedAgentFixture(pool, publication.workClient, verifiedAccountId, verifiedSubject, {
      en: 'Catalogue person',
    });
  } finally {
    await publication.stop();
  }

  const handleRoute = createHash('sha256').update('agent_page_person').digest().readUInt16BE(0);
  await pool.query(
    `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
     VALUES ($1, 'agent_page_person', $2, 'active', $2)`,
    [handleRoute, verifiedAccountId],
  );

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
  const missingAccountSubject = newId(subjectRoute);
  await seedPointer(missingAccountSubject, newId(accountRoute));
  invalidSubjects.push(unverifiedSubject, staleSubject, deletedSubject, missingAccountSubject);
}, 240_000);

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
  const bySubject = await get(`/v1/accounts?agent=${verifiedSubject}`);
  const byHandle = await get('/v1/accounts?handle=agent_page_person');

  expect(bySubject).toEqual(byHandle);
  expect(bySubject.status).toBe(200);
  expect(bySubject.body.accounts[0]).toMatchObject({
    handle: 'agent_page_person',
    state: 'active',
    verified: true,
    subject: { id: verifiedSubject, label: 'Catalogue person', type: 'schema:Person' },
  });
});

test('unknown, unverified, stale, deleted and missing-account agent pointers answer like an unknown handle', async () => {
  const unknownHandle = await get('/v1/accounts?handle=agent_page_unknown');
  expect(unknownHandle).toEqual({ status: 200, body: { accounts: [], next: null } });

  for (const subjectId of [newId(subjectRoute), ...invalidSubjects]) {
    expect(await get(`/v1/accounts?agent=${subjectId}`)).toEqual(unknownHandle);
  }
});

test('replayed pointer writes converge and a subject already naming another account fails typed', async () => {
  await writeAgentVerificationPage(pool, verification);
  await writeAgentVerificationPage(pool, verification);
  const readPointer = async () =>
    (
      await pool.query<{ account_id: string; verification_receipt_id: string }>(
        'SELECT account_id, verification_receipt_id FROM access.agent_page WHERE route = $1 AND subject_id = $2',
        [subjectRoute, verifiedSubject],
      )
    ).rows;
  expect(await readPointer()).toEqual([
    {
      account_id: verifiedAccountId,
      verification_receipt_id: verification.receiptId,
    },
  ]);

  const otherAccountId = newId(accountRoute);
  const otherReceiptId = newId(0);
  await pool.query('DELETE FROM access.agent_page WHERE route = $1 AND subject_id = $2', [
    subjectRoute,
    verifiedSubject,
  ]);
  await seedPointer(verifiedSubject, otherAccountId, otherReceiptId);
  await expect(writeAgentVerificationPage(pool, verification)).rejects.toBeInstanceOf(
    AgentVerificationPageConflictError,
  );
  expect(await readPointer()).toEqual([
    {
      account_id: otherAccountId,
      verification_receipt_id: otherReceiptId,
    },
  ]);
});
