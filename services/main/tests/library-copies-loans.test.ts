import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { LibraryCopyStore, InvalidLibraryRecord, libraryTimestamp,
  validateLibraryParty, type CopyState } from '../src/modules/library/copies.ts';
import { LibraryLoanStore, type LoanState } from '../src/modules/library/loans.ts';
import { ownershipJsonLd, loanJsonLd } from '../src/modules/library-export/ownership.ts';
import { parseRezics } from '../src/modules/library-import/formats/rezics.ts';
import { emptyRow } from '../src/modules/library-import/formats/contract.ts';
import { libraryCopiesRoutes, openApiOperations } from '../src/routes/library-copies.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const owner = id(), release = id(), work = id();
const neverPool = { connect: () => { throw new Error('Invalid input reached PostgreSQL'); } } as unknown as Pool;

test('all copy and loan operations have explicit read or write rate-limit admission', () => {
  const families = Object.entries(openApiOperations).flatMap(([path, methods]) =>
    Object.keys(methods).map(method => ({ method, path, family: rateLimitFamily(method.toUpperCase(), path) })));
  expect(families).toHaveLength(8);
  expect(families).toEqual(families.map(operation => ({ ...operation,
    family: operation.method === 'get' ? null : 'write' })));
});

test('copy and loan validation refuses malformed commands before opening a transaction', async () => {
  const copies = new LibraryCopyStore(neverPool), loans = new LibraryLoanStore(neverPool);
  const resolve = async () => ({ work, release });
  await expect(copies.write({ agent: owner, release, expectedVersion: 1, idempotencyKey: 'new', changes: {} }, resolve))
    .rejects.toBeInstanceOf(InvalidLibraryRecord);
  await expect(copies.write({ agent: owner, release, expectedVersion: 0, idempotencyKey: '', changes: {} }, resolve))
    .rejects.toBeInstanceOf(InvalidLibraryRecord);
  await expect(copies.write({ agent: owner, id: id(), expectedVersion: 1, idempotencyKey: 'edit', changes: {} }, resolve))
    .rejects.toBeInstanceOf(InvalidLibraryRecord);
  await expect(loans.write({ operation: 'open', agent: owner, copy: id(), direction: 'borrowed',
    counterparty: { kind: 'name', name: ' ' }, startedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-10T00:00:00Z',
    expectedVersion: 0, idempotencyKey: 'loan' })).rejects.toBeInstanceOf(InvalidLibraryRecord);
  await expect(loans.page(owner, { limit: 21 })).rejects.toBeInstanceOf(InvalidLibraryRecord);
  expect(() => validateLibraryParty({ kind: 'person', person: 'Jane' })).toThrow(InvalidLibraryRecord);
  expect(() => libraryTimestamp('2026-10-01')).toThrow(InvalidLibraryRecord);
  expect(() => libraryTimestamp('2026-02-30T00:00:00Z')).toThrow(InvalidLibraryRecord);
  expect(() => libraryTimestamp('0000-01-01T00:00:00Z')).toThrow(InvalidLibraryRecord);
  expect(() => libraryTimestamp('9999-12-31T23:59:59-01:00')).toThrow(InvalidLibraryRecord);
  expect(libraryTimestamp('2026-10-01T08:00:00+08:00')).toBe('2026-10-01T00:00:00.000Z');
});

test('copy and loan pages are complete only when no next cursor remains', async () => {
  const copy: CopyState = { id: release, work, release, format: null, acquiredFrom: null, acquiredAt: null,
    ownedFrom: null, ownedThrough: null, removed: false, version: 1, changedAt: '2026-10-01T00:00:00.000Z' };
  const loan = { id: release, copy: release, direction: 'lent' as const,
    counterparty: { kind: 'name' as const, name: 'Jane' }, startedAt: '2026-10-01T00:00:00.000Z',
    dueAt: '2026-10-10T00:00:00.000Z', returnedAt: null, version: 1, changedAt: '2026-10-01T00:00:00.000Z',
    state: 'open' as const };
  const app = libraryCopiesRoutes({ account: { verify: async () => ({ issuer: 'test', subject: 'owner' }) },
    access: { canReadAsBaselineMember: async () => true },
    libraryCopies: { page: async () => ({ items: [copy], nextCursor: 'more' }) },
    libraryLoans: { page: async () => ({ items: [loan], nextCursor: null }) },
  } as unknown as MainWorkDependencies);
  const headers = { authorization: 'Bearer owner' };
  const copies = await app.handle(new Request(
    `http://main.local/v1/works/${work.slice(-36)}/copies?actingSubject=${encodeURIComponent(owner)}`, { headers }));
  expect(copies.status).toBe(200);
  expect(await copies.json()).toMatchObject({ items: [{ id: release }], nextCursor: 'more', complete: false });
  const loans = await app.handle(new Request(
    `http://main.local/v1/me/library-loans?actingSubject=${encodeURIComponent(owner)}`, { headers }));
  expect(loans.status).toBe(200);
  expect(await loans.json()).toMatchObject({ items: [{ id: release, state: 'open' }], nextCursor: null, complete: true });
});

test('private copy and loan routes deny another reader before touching records or the graph', async () => {
  let touched = 0;
  const app = libraryCopiesRoutes({ account: { verify: async () => ({ issuer: 'test', subject: 'other' }) },
    access: { canReadAsBaselineMember: async () => false },
    libraryCopies: { page: async () => { touched++; }, write: async () => { touched++; } },
    libraryLoans: { page: async () => { touched++; }, write: async () => { touched++; } },
  } as unknown as MainWorkDependencies);
  const body = { actingSubject: owner, expectedVersion: 0 };
  const calls: Array<[string, string, object | undefined]> = [
    ['GET', `/v1/works/${work.slice(-36)}/copies?actingSubject=${owner}`, undefined],
    ['POST', '/v1/me/library-copies', { ...body, release }],
    ['PATCH', `/v1/me/library-copies/${release.slice(-36)}`, { ...body, format: 'paperback' }],
    ['DELETE', `/v1/me/library-copies/${release.slice(-36)}`, body],
    ['GET', `/v1/me/library-loans?actingSubject=${owner}`, undefined],
    ['POST', '/v1/me/library-loans', { ...body, copy: release, direction: 'lent', counterparty: { kind: 'name', name: 'Jane' },
      startedAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-10T00:00:00Z' }],
    ['POST', `/v1/me/library-loans/${release.slice(-36)}/extend`, { ...body, dueAt: '2026-11-01T00:00:00Z' }],
    ['POST', `/v1/me/library-loans/${release.slice(-36)}/return`, body],
  ];
  for (const [method, path, value] of calls) {
    const response = await app.handle(new Request(`http://main.local${path}`, { method,
      headers: { authorization: 'Bearer other', ...(value ? { 'content-type': 'application/json' } : {}) },
      ...(value ? { body: JSON.stringify(value) } : {}) }));
    expect(response.status).toBe(403);
  }
  expect(touched).toBe(0);
  for (const methods of Object.values(openApiOperations)) for (const operation of Object.values(methods)) {
    expect(operation).toMatchObject({ bearer: true, exposure: 'public' });
  }
});

test('ownership and loan JSON-LD preserve dates, exact release and free-text identity through portable parsing', () => {
  const copy: CopyState = { id: id(), work, release, format: 'paperback', acquiredFrom: { kind: 'name', name: 'City Library' },
    acquiredAt: '2026-01-01T00:00:00.000Z', ownedFrom: '2026-01-02T00:00:00.000Z', ownedThrough: null,
    version: 1, removed: false, changedAt: '2026-01-02T00:00:00.000Z' };
  const loan: LoanState = { id: id(), copy: copy.id, direction: 'borrowed', counterparty: { kind: 'name', name: owner },
    startedAt: '2026-01-02T00:00:00.000Z', dueAt: '2026-01-10T00:00:00.000Z',
    returnedAt: '2026-01-11T00:00:00.000Z', version: 2, changedAt: '2026-01-11T00:00:00.000Z' };
  const ownership = ownershipJsonLd(copy), action = loanJsonLd(loan, owner);
  expect(ownership).toMatchObject({ '@type': 'OwnershipInfo', typeOfGood: { '@id': copy.id, isBasedOn: { '@id': release } },
    acquiredFrom: { name: 'City Library' }, ownedFrom: copy.ownedFrom });
  expect(action).toMatchObject({ '@type': 'BorrowAction', lender: { name: owner }, endTime: loan.dueAt,
    'rezics:returnedAt': loan.returnedAt });
  if (!('lender' in action)) throw new Error('Borrow action lost its lender');
  expect(action.lender).not.toHaveProperty('@id');
  expect(loanJsonLd({ ...loan, direction: 'lent', counterparty: { kind: 'person', person: owner } }, owner))
    .toMatchObject({ '@type': 'LendAction', borrower: { '@id': owner, '@type': 'Person' } });
  const rows = [emptyRow(`copy:${copy.id}`, '', { libraryCopy: copy, jsonLd: ownership }),
    emptyRow(`loan:${loan.id}`, '', { libraryLoan: loan, jsonLd: action })].map(row => ({ ...row, kind: 'retained' as const, work, target: release }));
  expect(parseRezics(JSON.stringify({ profile: 'rezics-library-export-v1', rows }))).toEqual(rows);
});
