import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';

const scopes = ['copy:create', 'copy:update', 'copy:delete', 'copy:list', 'copy:read'];
let now = Date.parse('2026-10-26T12:00:00.000Z');
let native: NativeProfileFixture;

beforeAll(async () => {
  native = await createProfileEntryFixture({
    clock: () => new Date(now),
    ownerScopes: scopes,
  });
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
  await native.activate(native.replacementDigest);
  expect(await (await native.send('owner', 'POST', '/v1/copy-loans', input, createKey)).json()).toEqual(original);
  await native.activate(native.originalDigest);

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
  const loan = (original as { loan: { id: string } }).loan;
  now = Date.parse('2026-10-26T23:59:59.999Z');
  const extended = await native.send('owner', 'PATCH', `/v1/copy-loans/${loan.id}`, {
    revision: 1,
    dueOn: '2026-10-28',
  });
  expect(extended.status).toBe(200);
  expect(await extended.json()).toMatchObject({ loan: { revision: 2, dueOn: '2026-10-28', state: 'due' } });
  now = Date.parse('2026-10-27T00:00:00.000Z');
  expect(await (await native.send('owner', 'GET', openPath)).json()).toMatchObject({
    items: [{ loan: { id: loan.id, state: 'due' } }],
  });

  const ownerId = native.owner.actor.accountId;
  const people: { id: string; label: string }[] = [];
  for (const label of ['Original loan counterparty', 'Current loan counterparty']) {
    const response = await native.send(
      'owner',
      'POST',
      '/v1/subjects',
      { type: 'schema:Person', labels: { en: label } },
      native.homeKey(ownerId),
    );
    expect(response.status).toBe(201);
    const { subject } = (await response.json()) as { subject: { id: string } };
    await native.awaitCurrentIdentity(subject.id);
    people.push({ id: subject.id, label });
  }
  people.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const survivor = people[0]!;
  const redirected = people[1]!;
  const personCopyResponse = await native.send('owner', 'POST', '/v1/copies', {
    subjectId,
    kind: 'physical',
    status: 'owned',
  });
  expect(personCopyResponse.status).toBe(201);
  const { copy: personCopy } = (await personCopyResponse.json()) as { copy: { id: string; revision: number } };
  const personLoanResponse = await native.send('owner', 'POST', '/v1/copy-loans', {
    copyId: personCopy.id,
    copyRevision: personCopy.revision,
    direction: 'borrowed',
    counterparty: { kind: 'person', personId: redirected.id },
    startedOn: '2026-10-20',
    dueOn: '2026-10-27',
  });
  expect(personLoanResponse.status).toBe(201);
  const { loan: personLoan } = (await personLoanResponse.json()) as { loan: { id: string } };
  const personPage = (await (await native.send('owner', 'GET', openPath)).json()) as {
    items: { loan: { id: string; counterparty: Record<string, unknown> } }[];
  };
  const beforeMerge = personPage.items.find(({ loan: item }) => item.id === personLoan.id)?.loan.counterparty;
  expect(beforeMerge).toMatchObject({ kind: 'person', personId: redirected.id, displayName: redirected.label });
  await native.admitSubjectMerge(survivor.id, redirected.id);
  const afterMerge = await (await native.send('owner', 'GET', openPath)).json();
  expect(afterMerge).toMatchObject({
    items: [
      {
        loan: {
          id: personLoan.id,
          counterparty: { kind: 'person', personId: redirected.id, displayName: survivor.label },
        },
      },
      { loan: { id: loan.id, counterparty: input.counterparty } },
    ],
  });
  const personReturned = await native.send('owner', 'POST', `/v1/copy-loans/${personLoan.id}/return`, {
    revision: 1,
    returnedOn: '2026-10-26',
  });
  expect(personReturned.status).toBe(200);

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
    items: [
      { loan: { id: loan.id, counterparty: input.counterparty, state: 'returned' }, copy: { state: 'deleted' } },
      { loan: { id: personLoan.id, state: 'returned' }, copy: { state: 'available' } },
    ],
  });
}, 120_000);

test('maximum mounted open page retains its sentinel and rejects continuation after a generation change', async () => {
  // Keep an interrupted receipt journey's open loans out of this owner's ordered page.
  const owner = await native.identity(['subject:read', ...scopes]);
  const accountId = owner.actor.accountId;
  const send = (method: string, path: string, body?: unknown) => native.send(owner.bearer, method, path, body);
  const subjectId = await native.createSubject('game', 'Loan page fixture');
  const maximumName = '\u{1f9ed}'.repeat(300);
  const createdCopy = await send('POST', '/v1/copies', {
    subjectId,
    kind: 'physical',
    status: 'owned',
  });
  expect(createdCopy.status).toBe(201);
  const { copy } = (await createdCopy.json()) as { copy: { id: string; revision: number } };
  const createdLoan = await send('POST', '/v1/copy-loans', {
    copyId: copy.id,
    copyRevision: copy.revision,
    direction: 'borrowed',
    counterparty: { kind: 'name', name: maximumName },
    startedOn: '2026-10-20',
    dueOn: '9999-12-31',
  });
  expect(createdLoan.status).toBe(201);
  const { loan } = (await createdLoan.json()) as { loan: { id: string } };
  const route = routeOf(copy.id)!;
  const copies = Array.from({ length: 100 }, () => newId(route));
  const loans = copies.map(
    (_, index) =>
      `10000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${(index + 1).toString(16).padStart(8, '0')}`,
  );
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
           l.counterparty_person_id,l.started_on,CASE WHEN p.n=1 THEN NULL ELSE l.due_on END,
           NULL,1,l.created_at,l.updated_at,l.transaction_id
      FROM library.copy_loan l CROSS JOIN unnest($3::uuid[],$4::uuid[]) WITH ORDINALITY p(id,copy_id,n)
     WHERE l.route=$1 AND l.loan_id=$2`,
    [route, loan.id, loans, copies],
  );

  type Page = {
    items: {
      loan: { id: string; dueOn: string | null; counterparty: { kind: string; name: string } };
      copy: { state: string };
    }[];
    nextCursor: string | null;
    generation: number;
  };
  const firstResponse = await send('GET', '/v1/copy-loans?filter=open&limit=100');
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Page;
  expect(first.items).toHaveLength(100);
  expect(first.items.every((item) => item.loan.dueOn === '9999-12-31' && item.copy.state === 'available')).toBe(true);
  expect(
    first.items.every((item) => item.loan.counterparty.kind === 'name' && item.loan.counterparty.name === maximumName),
  ).toBe(true);
  expect(first.items.map((item) => item.loan.id)).toEqual([loan.id, ...loans.slice(1)].sort());
  expect(first.nextCursor).toBeString();
  const nextPath = `/v1/copy-loans?filter=open&limit=100&cursor=${encodeURIComponent(first.nextCursor!)}`;
  const nextResponse = await send('GET', nextPath);
  expect(nextResponse.status).toBe(200);
  expect(await nextResponse.json()).toMatchObject({
    items: [{ loan: { id: loans[0], dueOn: null } }],
    nextCursor: null,
  });
  const legacyCursor = encodeCursor(
    native.tokens,
    {
      operation: 'copy-loan.list',
      parameters: {
        accountId,
        filter: 'open',
        order: 'dueOn-asc-loanId-asc',
        lifetime: 'generation-15m-v1',
      },
    },
    { epoch: first.generation, after: ['9999-12-31', first.items.at(-1)!.loan.id] },
  );
  const legacyResponse = await send(
    'GET',
    `/v1/copy-loans?filter=open&limit=100&cursor=${encodeURIComponent(legacyCursor)}`,
  );
  expect(legacyResponse.status).toBe(200);
  expect(await legacyResponse.json()).toMatchObject({
    items: [{ loan: { id: loans[0], dueOn: null } }],
    nextCursor: null,
  });

  const extended = await send('PATCH', `/v1/copy-loans/${loans[0]}`, {
    revision: 1,
    dueOn: '2026-10-29',
  });
  expect(extended.status).toBe(200);
  const stale = await send('GET', nextPath);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_cursor' });

  await native.pool.query(
    `UPDATE library.copy_loan SET returned_on='2026-10-30', revision=revision+1
      WHERE route=$1 AND account_id=$2 AND loan_id=ANY($3::uuid[])`,
    [route, accountId, loans.slice(0, 51)],
  );
  const historyResponse = await send('GET', '/v1/copy-loans?filter=history&limit=100');
  expect(historyResponse.status).toBe(200);
  const historyFirst = (await historyResponse.json()) as Page;
  expect(historyFirst.items).toHaveLength(50);
  expect(historyFirst.items.map((item) => item.loan.id)).toEqual(loans.slice(1, 51).reverse());
  expect(historyFirst.items.every((item) => item.loan.dueOn === '9999-12-31' && item.copy.state === 'available')).toBe(
    true,
  );
  expect(historyFirst.nextCursor).toBeString();
  const historyNext = await send(
    'GET',
    `/v1/copy-loans?filter=history&limit=100&cursor=${encodeURIComponent(historyFirst.nextCursor!)}`,
  );
  expect(historyNext.status).toBe(200);
  expect(await historyNext.json()).toMatchObject({
    items: [{ loan: { id: loans[0], state: 'returned' } }],
    nextCursor: null,
  });

  await native.pool.query(
    `UPDATE library.copy_loan SET returned_on='2026-10-30', revision=revision+1
      WHERE route=$1 AND account_id=$2 AND loan_id=ANY($3::uuid[])`,
    [route, accountId, [...loans.slice(51), loan.id]],
  );
  const empty = await send('GET', '/v1/copy-loans?filter=open&limit=100');
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({ items: [], nextCursor: null });
}, 120_000);

test('current account authorization fences exact loan receipt replay', async () => {
  const owner = await native.identity(scopes);
  const subjectId = await native.createSubject('game');
  const copyResponse = await native.send(owner.bearer, 'POST', '/v1/copies', {
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
    counterparty: { kind: 'name', name: 'private replay name' },
    startedOn: '2026-10-20',
    dueOn: null,
  };
  const key = entryKey();
  expect((await native.send(owner.bearer, 'POST', '/v1/copy-loans', input, key)).status).toBe(201);
  await native.suspend(owner.actor.accountId);
  const replay = await native.send(owner.bearer, 'POST', '/v1/copy-loans', input, key);
  expect([401, 403, 404]).toContain(replay.status);
  expect(await replay.text()).not.toContain('private replay name');
});
