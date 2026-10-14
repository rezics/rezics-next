import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { LibraryLoanStore, type LoanState } from '../src/modules/library/loans.ts';
import { libraryCopiesRoutes } from '../src/routes/library-copies.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { AccountAssertionDenied, verifyRequestAccount } from '../src/modules/account/verify-assertion.ts';

const owner = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const copy = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const loan = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const now = new Date('2026-10-14T06:00:00.000Z');

function fixture(direction: 'lent' | 'borrowed', overdue: boolean, revoke = false, accessUnavailable = false) {
  let state: LoanState = { id: loan, copy, direction, counterparty: { kind: 'name', name: 'Reader' },
    startedAt: '2026-10-01T00:00:00.000Z', dueAt: overdue ? '2026-10-10T00:00:00.000Z' : '2026-11-01T00:00:00.000Z',
    returnedAt: null, version: 1, changedAt: '2026-10-01T00:00:00.000Z' };
  let before = structuredClone(state), receipt: { request_digest: string; result: object } | undefined;
  let pendingReceipt = receipt, verifications = 0, checkouts = 0, admissions = 0;
  const client = {
    async query(sql: string, args: unknown[] = []) {
      let rows: object[] = [];
      if (sql === 'BEGIN') { before = structuredClone(state); pendingReceipt = receipt; }
      else if (sql === 'ROLLBACK') { state = before; pendingReceipt = receipt; }
      else if (sql === 'COMMIT') receipt = pendingReceipt;
      else if (sql.includes('SELECT request_digest,result')) rows = receipt ? [receipt] : [];
      else if (sql.includes('SELECT state FROM reader.library_loan')) rows = args[0] === owner ? [{ state: structuredClone(state) }] : [];
      else if (sql.includes('SELECT state FROM reader.library_copy')) rows = [{ state: { id: copy, removed: false } }];
      else if (sql === 'SELECT clock_timestamp() AS now') rows = [{ now }];
      else if (sql.includes('INSERT INTO reader.library_loan')) state = JSON.parse(args[3] as string) as LoanState;
      else if (sql.includes('INSERT INTO reader.library_copy_loan_command')) pendingReceipt = {
        request_digest: args[2] as string, result: JSON.parse(args[3] as string) as object };
      else if (!sql.includes('SET LOCAL') && !sql.includes('pg_advisory_xact_lock')) throw new Error(`Unexpected SQL: ${sql}`);
      return { rows, rowCount: rows.length };
    },
    release() {},
  };
  const pool = { connect: async () => { checkouts++; return client; } } as unknown as Pool;
  const account = { async verify() {
    verifications++;
    if (revoke && verifications > 2) throw new AccountAssertionDenied('revoked');
    // Budget attribution, fresh command consent and the final enforcement
    // refresh suffice. An extra entrance exchange repeats the dependency.
    if (verifications > 3) throw new Error('Redundant Account exchange');
    return { issuer: 'test', subject: 'owner', accountScopes: ['work:read', 'library:write'] };
  } };
  const app = libraryCopiesRoutes({ account,
    access: { canReadAsBaselineMember: async (_principal: unknown, actor: string) => {
      admissions++;
      if (accessUnavailable && admissions === 3) throw new AdmissionUnavailable('Access unavailable');
      return actor === owner;
    } },
    libraryLoans: new LibraryLoanStore(pool),
  } as unknown as MainWorkDependencies);
  const request = (operation: 'return' | 'extend', actor = owner, expectedVersion = 1) => new Request(
    `http://main.local/v1/me/library-loans/${loan.slice(-36)}/${operation}`, { method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json', 'idempotency-key': operation },
      body: JSON.stringify({ actingSubject: actor, expectedVersion,
        ...(operation === 'extend' ? { dueAt: '2026-12-01T00:00:00.000Z' } : {}) }),
    });
  const send = async (operation: 'return' | 'extend', actor = owner, expectedVersion = 1) => {
    verifications = 0;
    const input = request(operation, actor, expectedVersion);
    await verifyRequestAccount(account as MainWorkDependencies['account'], input, []);
    return app.handle(input);
  };
  return { send, state: () => state, counts: () => ({ verifications, checkouts, admissions }) };
}

for (const direction of ['lent', 'borrowed'] as const) for (const overdue of [true, false]) {
  test(`${direction} ${overdue ? 'expired' : 'open'} loan returns with one admission and a final enforcement refresh`, async () => {
    const f = fixture(direction, overdue);
    const response = await f.send('return');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const saved = await response.json();
    expect(saved).toMatchObject({ id: loan, copy, direction, state: 'returned', returnedAt: now.toISOString(), version: 2, replayed: false });
    expect(f.counts()).toEqual({ verifications: 3, checkouts: 1, admissions: 3 });
    const replay = await f.send('return');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...saved, replayed: true });
    expect(f.state().version).toBe(2);
  });
}

test('an expired loan extends through the same authority guards', async () => {
  const f = fixture('lent', true);
  const response = await f.send('extend');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: 'open', version: 2, returnedAt: null, dueAt: '2026-12-01T00:00:00.000Z' });
  expect(f.counts().verifications).toBe(3);
});

test('foreign and stale return attempts preserve the expired loan', async () => {
  const f = fixture('borrowed', true), before = structuredClone(f.state());
  expect((await f.send('return', copy)).status).toBe(403);
  expect(f.counts().checkouts).toBe(0);
  const stale = await f.send('return', owner, 0);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_library_record' });
  expect(f.state()).toEqual(before);
});

test('Account revocation at the final guard rolls back the loan and its receipt', async () => {
  const f = fixture('lent', true, true), before = structuredClone(f.state());
  expect((await f.send('return')).status).toBe(401);
  expect(f.state()).toEqual(before);
});

// Access contention is the other possible authority-service failure. It must
// remain unavailable and roll back; it cannot supply evidence of ownership.
test('Access failure at the final guard remains unavailable and rolls back the return', async () => {
  const f = fixture('borrowed', true, false, true), before = structuredClone(f.state());
  const response = await f.send('return');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
  expect(f.state()).toEqual(before);
});
