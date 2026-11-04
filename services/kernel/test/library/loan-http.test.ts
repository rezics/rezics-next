import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, libraryProfile } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createLoanCommands } from '../../src/library/loan-commands.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

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
    counterparty: { kind: 'name', name: '  Kai  ' },
    startedOn: '2026-10-20',
    dueOn: '2026-10-26',
  };
  const createKey = entryKey();
  const created = await native.send('owner', 'POST', '/v1/copy-loans', input, createKey);
  if (created.status !== 201) {
    try {
      const command = createLoanCommands({
        pool: native.pool,
        access: native.access,
        routeKey: testRouteKey(),
        tokens: native.tokens,
        clock: () => new Date(now),
      });
      await command.createLoan(native.owner.actor, input, entryKey());
      throw new Error(`HTTP create returned ${created.status}; direct native dispatch succeeded`);
    } catch (error) {
      throw new Error(
        `HTTP create returned ${created.status}: ${await created.text()}; direct dispatch: ${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error)}`,
      );
    }
  }
  expect(created.status).toBe(201);
  const original = await created.json();
  expect(original).toMatchObject({
    loan: { direction: 'lent', counterparty: { kind: 'name', name: '  Kai  ' }, state: 'due' },
  });
  const replay = await native.send('owner', 'POST', '/v1/copy-loans', input, createKey);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(original);

  const duplicate = await native.send('owner', 'POST', '/v1/copy-loans', input, entryKey());
  expect(duplicate.status).toBe(409);

  const openPath = '/v1/copy-loans?filter=open&limit=20';
  const onDueDay = await native.send('owner', 'GET', openPath);
  expect(onDueDay.status).toBe(200);
  expect(await onDueDay.json()).toMatchObject({
    boundary: { calendar: 'gregorian', zone: 'UTC', today: '2026-10-26' },
    items: [{ loan: { counterparty: { name: '  Kai  ' }, state: 'due' }, copy: { id: copy.id } }],
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
    items: [
      { loan: { id: loan.id, counterparty: { name: '  Kai  ' }, state: 'returned' }, copy: { state: 'deleted' } },
    ],
  });
});
