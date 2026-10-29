import { afterAll, beforeAll, expect, test } from 'bun:test';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import * as store from '../../src/library/entry-store.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let native: NativeProfileFixture;
let commands: ReturnType<typeof createCopyCommands>;
const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:read', 'copy:list'];
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;

beforeAll(async () => {
  native = await createProfileEntryFixture();
  owner = await native.identity(scopes);
  commands = createCopyCommands({ pool: native.pool, access: native.access, tokens: native.tokens });
}, 120_000);
afterAll(async () => {
  await native?.close();
});

test('kindless native receipts retain their original digest and missing-kind HTTP shape after source hide', async () => {
  const subjectId = await native.createSubject('game');
  const key = entryKey(),
    updateKey = entryKey();
  // Execute the pre-profile command through the ordinary owner boundary. This is
  // historical receipt evidence, never an adapter for new product input.
  const runner = createLibraryCommandRunner({ pool: native.pool });
  const input = {
    subjectId,
    status: 'owned',
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: 'Historic',
  };
  const route = routeOf(owner.actor.accountId)!;
  const created = await runner.ownAccount(
    owner.actor,
    {
      action: 'copy:create',
      kind: 'library.copy.create',
      requestKey: key,
      input,
    },
    async (tx, command) => {
      const { kind: _kind, ...copy } = await store.insertCopy(
        tx,
        route,
        {
          ...input,
          id: newId(route),
          accountId: owner.actor.accountId,
        },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
      );
      return { value: copy };
    },
  );
  const patch = { revision: 1, status: 'lent', note: 'Historic update' };
  const updated = await runner.ownAccount(
    owner.actor,
    {
      action: 'copy:update',
      kind: 'library.copy.update',
      requestKey: updateKey,
      input: { copyId: created.value.id, ...patch },
    },
    async (tx, command) => {
      const changed = await store.updateCopy(
        tx,
        route,
        created.value.id,
        1,
        {
          ...input,
          status: patch.status,
          note: patch.note,
        },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
      );
      expect(changed).not.toBeNull();
      const { kind: _kind, ...copy } = changed!;
      return { value: copy };
    },
  );
  expect(
    (await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, { reason: 'Historic receipt' })).status,
  ).toBe(200);
  const before = await native.inspect(owner.actor.accountId);
  expect(await commands.createCopy(owner.actor, input, key)).toMatchObject({ replayed: true, value: created.value });
  expect(await commands.updateCopy(owner.actor, created.value.id, patch, updateKey)).toMatchObject({
    replayed: true,
    value: updated.value,
  });
  for (const [method, path, body, requestKey, value, status] of [
    ['POST', '/v1/copies', input, key, created.value, 201],
    ['PATCH', `/v1/copies/${created.value.id}`, patch, updateKey, updated.value, 200],
  ] as const) {
    const response = await native.send(owner.bearer, method, path, body, requestKey);
    expect(response.status).toBe(status);
    const { id, subjectId, status: storedStatus, revision, location, source, acquiredOn, disposedOn, note } = value;
    expect(await response.text()).toBe(
      JSON.stringify({
        copy: { id, subjectId, status: storedStatus, revision, location, source, acquiredOn, disposedOn, note },
      }),
    );
  }
  expect(await native.inspect(owner.actor.accountId)).toEqual(before);
});

test('fresh missing status and PATCH kind are invalid and never persist facts or receipts', async () => {
  const subjectId = await native.createSubject('game');
  const before = await native.inspect(owner.actor.accountId);
  for (const body of [{ subjectId, kind: 'physical' }, { subjectId, status: 'owned' }, { subjectId }]) {
    const response = await native.send(owner.bearer, 'POST', '/v1/copies', body);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_request');
  }
  const response = await native.send(owner.bearer, 'PATCH', `/v1/copies/${newId(routeOf(owner.actor.accountId)!)}`, {
    revision: 1,
    kind: 'physical',
  });
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe('invalid_request');
  expect(await native.inspect(owner.actor.accountId)).toEqual(before);
});
