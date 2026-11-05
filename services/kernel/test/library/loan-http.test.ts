import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, libraryProfile } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const scopes = ['copy:create', 'copy:update', 'copy:delete', 'copy:list', 'copy:read'];
let now = Date.parse('2026-10-26T12:00:00.000Z');
let native: NativeProfileFixture;

beforeAll(async () => {
  native = await createProfileEntryFixture({
    clock: () => new Date(now),
    ownerScopes: scopes,
  });
  await native.activate(await native.publish(await compileCatalogue(fixture(libraryProfile('fixture.loan-http')))));
}, 120_000);

afterAll(async () => {
  await native?.close();
});

test('mounted private loan journey replays receipts, orders by the UTC due boundary, and retains returned history', async () => {
  const subjectId = await native.createSubject('game', 'Loan fixture');
  const copyResponse = await native.send('owner', 'POST', '/v1/copies', {
    subjectId,
    kind: 'physical',
    status: 'owned',
  });
  expect(copyResponse.status).toBe(201);
  const { copy } = (await copyResponse.json()) as { copy: { id: string; revision: number } };
  const input = {
    copyId: copy.id,
    copyRevision: copy.revision,
    direction: 'lent',
    counterparty: { kind: 'name', name: '  Kai e\u0301 🐈 "  ' },
    startedOn: '2026-10-20',
    dueOn: '2026-10-26',
  };
  const createKey = entryKey();
  const created = await native.send('owner', 'POST', '/v1/copy-loans', input, createKey);
  if (created.status !== 201) throw new Error(`Loan create returned ${created.status}: ${await created.text()}`);
  expect(created.status).toBe(201);
  // Discard the successful acknowledgement; recovery must use the original key
  // and exact operand, rather than attempt a second private loan.
  await created.body?.cancel();
  const recovered = await native.send('owner', 'POST', '/v1/copy-loans', input, createKey);
  expect(recovered.status).toBe(201);
  const original = await recovered.json();
  expect(original).toMatchObject({
    loan: { direction: 'lent', counterparty: input.counterparty, state: 'due' },
  });
  const replay = await native.send('owner', 'POST', '/v1/copy-loans', input, createKey);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(original);

  const duplicate = await native.send('owner', 'POST', '/v1/copy-loans', input, entryKey());
  expect(duplicate.status).toBe(409);

  const openPath = '/v1/copy-loans?filter=open&limit=20';
  const onDueDay = await native.send('owner', 'GET', openPath);
  if (onDueDay.status !== 200) throw new Error(`Loan list returned ${onDueDay.status}: ${await onDueDay.text()}`);
  expect(onDueDay.status).toBe(200);
  expect(await onDueDay.json()).toMatchObject({
    boundary: { calendar: 'gregorian', zone: 'UTC', today: '2026-10-26' },
    items: [{ loan: { counterparty: input.counterparty, state: 'due' }, copy: { id: copy.id } }],
  });
  now = Date.parse('2026-10-27T00:00:00.000Z');
  const overdue = await native.send('owner', 'GET', openPath);
  expect(await overdue.json()).toMatchObject({ items: [{ loan: { state: 'overdue' } }] });

  const loan = (original as { loan: { id: string } }).loan;
  const extended = await native.send('owner', 'PATCH', `/v1/copy-loans/${loan.id}`, {
    revision: 1,
    dueOn: '2026-10-28',
  });
  expect(extended.status).toBe(200);
  expect(await extended.json()).toMatchObject({ loan: { revision: 2, dueOn: '2026-10-28', state: 'due' } });
  const stale = await native.send('owner', 'PATCH', `/v1/copy-loans/${loan.id}`, { revision: 1, dueOn: '2026-10-29' });
  expect(stale.status).toBe(409);

  const disposal = await native.send('owner', 'PATCH', `/v1/copies/${copy.id}`, {
    revision: 1,
    status: 'disposed',
    disposedOn: '2026-10-27',
  });
  expect(disposal.status).toBe(409);
  const deletion = await native.send('owner', 'DELETE', `/v1/copies/${copy.id}?revision=1`);
  expect(deletion.status).toBe(409);

  const returnKey = entryKey();
  const returned = await native.send(
    'owner',
    'POST',
    `/v1/copy-loans/${loan.id}/return`,
    { revision: 2, returnedOn: '2026-10-27' },
    returnKey,
  );
  expect(returned.status).toBe(200);
  const returnedBody = await returned.json();
  expect(returnedBody).toMatchObject({ loan: { revision: 3, returnedOn: '2026-10-27', state: 'returned' } });
  const returnReplay = await native.send(
    'owner',
    'POST',
    `/v1/copy-loans/${loan.id}/return`,
    { revision: 2, returnedOn: '2026-10-27' },
    returnKey,
  );
  expect(await returnReplay.json()).toEqual(returnedBody);
  const repeatedReturn = await native.send('owner', 'POST', `/v1/copy-loans/${loan.id}/return`, {
    revision: 3,
    returnedOn: '2026-10-27',
  });
  expect(repeatedReturn.status).toBe(409);

  const cleared = await native.send('owner', 'DELETE', `/v1/copies/${copy.id}?revision=1`);
  expect(cleared.status).toBe(204);
  const history = await native.send('owner', 'GET', '/v1/copy-loans?filter=history&limit=20');
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({
    items: [{ loan: { id: loan.id, counterparty: input.counterparty, state: 'returned' }, copy: { state: 'deleted' } }],
  });
});

test('maximum mounted open page retains its sentinel and rejects continuation after a generation change', async () => {
  const subjectId = await native.createSubject('game', 'Loan page fixture');
  const createdCopy = await native.send('owner', 'POST', '/v1/copies', {
    subjectId,
    kind: 'physical',
    status: 'owned',
  });
  expect(createdCopy.status).toBe(201);
  const { copy } = (await createdCopy.json()) as { copy: { id: string; revision: number } };
  const createdLoan = await native.send('owner', 'POST', '/v1/copy-loans', {
    copyId: copy.id,
    copyRevision: copy.revision,
    direction: 'borrowed',
    counterparty: { kind: 'name', name: 'Page counterparty' },
    startedOn: '2026-10-20',
    dueOn: '2026-10-28',
  });
  expect(createdLoan.status).toBe(201);
  const { loan } = (await createdLoan.json()) as { loan: { id: string } };
  const route = routeOf(copy.id)!;
  const copies = Array.from({ length: 100 }, () => newId(route));
  const loans = copies.map(() => newId(route));
  // Populate the boundary from genuine native copy/loan operands. The assertions
  // receive the mounted operation, including its current-source presentation.
  await native.pool.query(
    `INSERT INTO library.copy
    (route,copy_id,account_id,subject_id,status,revision,created_at,updated_at,transaction_id,kind,library_profile_pin)
    SELECT c.route,p.id,c.account_id,c.subject_id,c.status,c.revision,c.created_at,c.updated_at,c.transaction_id,
           c.kind,c.library_profile_pin
      FROM library.copy c CROSS JOIN unnest($3::uuid[]) p(id)
     WHERE c.route=$1 AND c.copy_id=$2`,
    [route, copy.id, copies],
  );
  await native.pool.query(
    `INSERT INTO library.copy_loan
    (route,loan_id,account_id,copy_id,direction,counterparty_kind,counterparty_name,counterparty_person_id,
     started_on,due_on,returned_on,revision,created_at,updated_at,transaction_id)
    SELECT l.route,p.id,l.account_id,p.copy_id,l.direction,l.counterparty_kind,l.counterparty_name,
           l.counterparty_person_id,l.started_on,CASE WHEN p.n=100 THEN NULL ELSE l.due_on END,
           NULL,1,l.created_at,l.updated_at,l.transaction_id
      FROM library.copy_loan l CROSS JOIN unnest($3::uuid[],$4::uuid[]) WITH ORDINALITY p(id,copy_id,n)
     WHERE l.route=$1 AND l.loan_id=$2`,
    [route, loan.id, loans, copies],
  );

  type Page = {
    items: { loan: { id: string; dueOn: string | null }; copy: { state: string } }[];
    nextCursor: string | null;
  };
  const firstResponse = await native.send('owner', 'GET', '/v1/copy-loans?filter=open&limit=100');
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Page;
  expect(first.items).toHaveLength(100);
  expect(first.items.every((item) => item.loan.dueOn === '2026-10-28' && item.copy.state === 'available')).toBe(true);
  expect(first.items.map((item) => item.loan.id)).toEqual([loan.id, ...loans.slice(0, 99)].sort());
  expect(first.nextCursor).toBeString();
  const nextPath = `/v1/copy-loans?filter=open&limit=100&cursor=${encodeURIComponent(first.nextCursor!)}`;
  const nextResponse = await native.send('owner', 'GET', nextPath);
  expect(nextResponse.status).toBe(200);
  expect(await nextResponse.json()).toMatchObject({
    items: [{ loan: { id: loans[99], dueOn: null } }],
    nextCursor: null,
  });

  const extended = await native.send('owner', 'PATCH', `/v1/copy-loans/${loan.id}`, {
    revision: 1,
    dueOn: '2026-10-29',
  });
  expect(extended.status).toBe(200);
  const stale = await native.send('owner', 'GET', nextPath);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });
}, 120_000);
