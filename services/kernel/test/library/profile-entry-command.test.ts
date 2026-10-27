import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { accountToken, authenticateAccount } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import {
  createProfileEntryFixture,
  entryKey,
  entryStates,
  entryTypes,
  type NativeProfileFixture,
} from './support/profile-entry-fixture.ts';

let native: NativeProfileFixture;
beforeAll(async () => {
  native = await createProfileEntryFixture();
}, 120_000);
beforeEach(async () => {
  await native.activate(native.originalDigest);
});
afterAll(async () => {
  await native?.close();
});
const path = (subjectId: string) => `/v1/libraryEntries/${subjectId}`;

async function json(response: Response, status: number) {
  const body = await response.json();
  expect({ status: response.status, body }).toEqual({ status, body: expect.any(Object) });
  return body;
}
async function problem(response: Response, status: number, code: string) {
  const body = await json(response, status);
  expect(body.code).toBe(code);
  expect(body.effect_status).toBe('not_applied');
  privateFree(body);
}
function privateFree(value: unknown) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      'pin',
      'library_profile_pin',
      'libraryProfilePin',
      'acceptingType',
      'profileId',
      'releaseDigest',
      'provenance',
      'typeId',
      'typeSourceId',
      'sourcePartition',
      'sourceEpoch',
      'sourcePosition',
    ]).not.toContain(key);
    privateFree(child);
  }
}
const pin = (digest: string, vertical: 'game' | 'recipe' | 'record') => ({
  provenance: 'profile',
  releaseDigest: digest,
  acceptingType: entryTypes[vertical],
  profileId: `fixture.${vertical}`,
});
async function fact(subjectId: string, accountId = native.owner.actor.accountId) {
  const found = (await native.inspect(accountId)).entries.filter(({ row }) => row.subject_id === subjectId);
  expect(found).toHaveLength(1);
  return found[0]!.row;
}

test('native entry commands accept active data profiles pin fresh values and replay original receipts after release change while denying revoked authority', async () => {
  const writer = await native.identity(['subject:read', 'library_entry:update', 'library_entry:read']);
  const subjectId = await native.createSubject('game');
  const key = entryKey();
  const before = await native.inspect(writer.actor.accountId);
  const first = await native.commands.putEntry(writer.actor, subjectId, { state: entryStates.game }, key);
  expect(first.replayed).toBe(false);
  expect(first.value.created).toBe(true);
  expect(String(first.value.entry.state)).toBe('playing');
  // Child has structural bases; the pin names only its actual primary type.
  expect(native.original.types['ex:Child']!.bases).toContain('ex:Parent');
  const stored = await fact(subjectId, writer.actor.accountId);
  expect(stored.library_profile_pin).toEqual(pin(native.originalDigest, 'game'));
  expect(Object.keys(stored.library_profile_pin).sort()).toEqual([
    'acceptingType',
    'profileId',
    'provenance',
    'releaseDigest',
  ]);
  privateFree(first.value);
  const after = await native.inspect(writer.actor.accountId);
  expect(after.entries.length - before.entries.length).toBe(1);
  expect(after.receipts.length - before.receipts.length).toBe(1);
  expect(after.events.length - before.events.length).toBe(1);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.copies).toEqual(before.copies);
  expect(after.follows).toEqual(before.follows); // role=active does not mean the ID in_progress
  const event = after.events.at(-1)!.row;
  expect(event.type).toBe('com.rezics.library.entry.updated.v1');
  expect(event.subject).toBe(writer.actor.accountId);
  expect(event.data).toEqual({ subjectId });
  privateFree(event.data);

  await native.activate(native.replacementDigest);
  const unchanged = await native.inspect(writer.actor.accountId);
  const replay = await native.commands.putEntry(writer.actor, subjectId, { state: 'playing' }, key);
  expect(replay).toEqual({ ...first, replayed: true });
  expect(await native.inspect(writer.actor.accountId)).toEqual(unchanged);
  expect((await fact(subjectId, writer.actor.accountId)).library_profile_pin).toEqual(stored.library_profile_pin);
  await expect(
    native.commands.putEntry(writer.actor, subjectId, { state: 'unknown_state' }, key),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await native.inspect(writer.actor.accountId)).toEqual(unchanged);
  await native.revokeIdentity(writer.actor.accountId);
  const revoked = await native.inspect(writer.actor.accountId);
  await expect(native.commands.putEntry(writer.actor, subjectId, { state: 'playing' }, key)).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(await native.inspect(writer.actor.accountId)).toEqual(revoked);
});

test('game recipe and record states use one HTTP entry slot and descriptive active roles do not create follows', async () => {
  for (const vertical of ['game', 'recipe', 'record'] as const) {
    const subjectId = await native.createSubject(vertical);
    const before = await native.inspect();
    const first = await json(await native.send('owner', 'PUT', path(subjectId), { state: entryStates[vertical] }), 201);
    expect(first.libraryEntry.state).toBe(entryStates[vertical]);
    expect(Object.keys(first.libraryEntry).sort()).toEqual([
      'createdAt',
      'revision',
      'state',
      'subjectId',
      'updatedAt',
    ]);
    privateFree(first);
    expect((await fact(subjectId)).library_profile_pin).toEqual(pin(native.originalDigest, vertical));
    const fresh = await native.inspect();
    expect(fresh.sessions).toEqual(before.sessions);
    expect(fresh.copies).toEqual(before.copies);
    expect(fresh.follows).toEqual(before.follows);
    expect(fresh.receipts.length - before.receipts.length).toBe(1);
    expect(fresh.events.length - before.events.length).toBe(1);
    await problem(await native.send('owner', 'PUT', path(subjectId), { state: 'planned' }), 409, 'conflict');
    expect(await native.inspect()).toEqual(fresh);
    const changed = await json(
      await native.send('owner', 'PUT', path(subjectId), { state: 'completed', revision: 1 }),
      200,
    );
    expect(changed.libraryEntry.revision).toBe(2);
    expect(changed.libraryEntry.createdAt).toBe(first.libraryEntry.createdAt);
    const cas = await native.inspect();
    await problem(
      await native.send('owner', 'PUT', path(subjectId), { state: entryStates[vertical], revision: 1 }),
      409,
      'conflict',
    );
    expect(await native.inspect()).toEqual(cas);
    expect(
      (await native.commands.listEntries(native.owner.actor, { limit: 100 })).entries.some(
        (entry) => entry.subjectId === subjectId && entry.state === 'completed',
      ),
    ).toBe(true);
  }
});

test('the literal in_progress state follows once and preserves an explicit unfollow', async () => {
  for (const explicitUnfollow of [false, true]) {
    const subjectId = await native.createSubject('recipe');
    if (explicitUnfollow) {
      await json(await native.send('owner', 'PUT', `/v1/follows/${subjectId}`), 200);
      await json(await native.send('owner', 'DELETE', `/v1/follows/${subjectId}`), 200);
    }
    const before = await native.inspect();
    await json(await native.send('owner', 'PUT', path(subjectId), { state: 'in_progress' }), 201);
    const after = await native.inspect();
    const follows = after.follows.filter(({ row }) => row.target_id === subjectId);
    expect(follows).toHaveLength(1);
    expect(follows[0]!.row.state).toBe(explicitUnfollow ? 'unfollowed' : 'following');
    expect(follows[0]!.row.reason).toBe(explicitUnfollow ? 'explicit' : 'library');
    expect(after.events.length - before.events.length).toBe(explicitUnfollow ? 1 : 2);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.copies).toEqual(before.copies);
    expect((await fact(subjectId)).library_profile_pin).toEqual(pin(native.originalDigest, 'recipe'));
  }
});

test('release replacement and rollback preserve raw facts until a genuine fresh value mutation selects the active profile', async () => {
  const subjectId = await native.createSubject('recipe');
  await json(await native.send('owner', 'PUT', path(subjectId), { state: 'cooking' }), 201);
  const original = await fact(subjectId);
  const before = await native.inspect();
  const oldHead = await native.readHead();
  await native.activate(native.replacementDigest);
  expect((await native.inspect()).entries).toEqual(before.entries);
  await problem(
    await native.send('steward', 'POST', `/v1/definitions/releases/${native.originalDigest}:activate`, {
      expected_head: oldHead!.head,
    }),
    409,
    'stale_editorial_head',
  );
  const oldRead = await json(await native.send('owner', 'GET', path(subjectId)), 200);
  expect(oldRead.libraryEntry.state).toBe('cooking');
  privateFree(oldRead);
  const noWrite = await native.inspect();
  await problem(
    await native.send('owner', 'PUT', path(subjectId), { state: 'cooking', revision: 1 }),
    422,
    'unsupported_library_profile',
  );
  expect(await native.inspect()).toEqual(noWrite);
  await native.activate(native.originalDigest);
  expect(await fact(subjectId)).toEqual(original);
  await native.activate(native.replacementDigest);
  await json(await native.send('owner', 'PUT', path(subjectId), { state: 'cooking_again', revision: 1 }), 200);
  const updated = await fact(subjectId);
  expect(updated.library_profile_pin).toEqual(pin(native.replacementDigest, 'recipe'));
  expect(updated.revision).toBe(2);
  expect(updated.created_at).toBe(original.created_at);
  await native.activate(native.originalDigest);
  expect(await fact(subjectId)).toEqual(updated);
  expect((await json(await native.send('owner', 'GET', path(subjectId)), 200)).libraryEntry.state).toBe(
    'cooking_again',
  );
});

test('profile retirement rejects new state values but permits own read and clear without a legacy fallback', async () => {
  const subjectId = await native.createSubject('record');
  await json(await native.send('owner', 'PUT', path(subjectId), { state: 'planned' }), 201);
  const stored = await fact(subjectId);
  await native.activate(native.replacementDigest);
  expect(native.replacement.types[entryTypes.record]!.library).toBeUndefined();
  expect(native.replacement.libraryProfiles!['legacy-fixed-v1']).toBeDefined();
  const before = await native.inspect();
  await problem(
    await native.send('owner', 'PUT', path(subjectId), { state: 'completed', revision: 1 }),
    422,
    'unsupported_library_profile',
  );
  expect(await native.inspect()).toEqual(before);
  expect((await json(await native.send('owner', 'GET', path(subjectId)), 200)).libraryEntry.state).toBe('planned');
  expect(await fact(subjectId)).toEqual(stored);
  expect((await native.send('owner', 'DELETE', `${path(subjectId)}?revision=1`)).status).toBe(204);
  await problem(await native.send('owner', 'GET', path(subjectId)), 404, 'not_found');
  const cleared = await native.inspect();
  await problem(
    await native.send('owner', 'PUT', path(subjectId), { state: 'planned' }),
    422,
    'unsupported_library_profile',
  );
  const person = await native.createSubject('unprofiled');
  const afterProvisioning = await native.inspect();
  await problem(
    await native.send('owner', 'PUT', path(person), { state: 'planned' }),
    422,
    'unsupported_library_profile',
  );
  expect(await native.inspect()).toEqual(afterProvisioning);
  expect(afterProvisioning.entries).toEqual(cleared.entries);
});

test('HTTP replay keeps original body status digest and pin after profile removal and an absent source', async () => {
  const subjectId = await native.createSubject('record');
  const key = entryKey();
  const first = await json(await native.send('owner', 'PUT', path(subjectId), { state: 'planned' }, key), 201);
  const stored = await fact(subjectId);
  await native.activate(native.replacementDigest);
  await json(
    await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, { reason: 'Native receipt source absence' }),
    200,
  );
  const before = await native.inspect();
  expect(await json(await native.send('owner', 'PUT', path(subjectId), { state: 'planned' }, key), 201)).toEqual(first);
  expect(await native.inspect()).toEqual(before);
  await problem(
    await native.send('owner', 'PUT', path(subjectId), { state: 'not_declared' }, key),
    422,
    'idempotency_conflict',
  );
  expect(await native.inspect()).toEqual(before);
  expect((await fact(subjectId)).library_profile_pin).toEqual(stored.library_profile_pin);
  expect(stored.library_profile_pin).toEqual(pin(native.originalDigest, 'record'));
  const fresh = await native.createSubject('record');
  const noWrite = await native.inspect();
  await problem(
    await native.send('owner', 'PUT', path(fresh), { state: 'planned' }),
    422,
    'unsupported_library_profile',
  );
  expect(await native.inspect()).toEqual(noWrite);
});

test('native signed scope suspension and credential revocation deny prior receipts without disclosing private bodies', async () => {
  // Independent identities keep revocation local to this case and exercise current account authority.
  const subjectId = await native.createSubject('game');
  for (const denial of ['scope', 'suspension', 'revocation'] as const) {
    const who = await native.identity(['subject:read', 'library_entry:update', 'library_entry:read']);
    const key = entryKey();
    await native.commands.putEntry(who.actor, subjectId, { state: 'planned' }, key);
    let actor = who.actor;
    let bearer = who.bearer;
    if (denial === 'scope') {
      const claims = { accountId: actor.accountId, clientId: actor.clientId, scopes: ['subject:read'] };
      bearer = await accountToken(claims);
      actor = await authenticateAccount(native.access, { pool: native.pool, deadline: deadlineFor(30_000) }, claims);
    } else if (denial === 'suspension') await native.suspend(actor.accountId);
    else await native.revokeIdentity(actor.accountId);
    const before = await native.inspect(actor.accountId);
    await expect(native.commands.putEntry(actor, subjectId, { state: 'planned' }, key)).rejects.toBeInstanceOf(
      GrantDeniedError,
    );
    const denied = await native.send(bearer, 'PUT', path(subjectId), { state: 'planned' }, key);
    expect([401, 403, 404]).toContain(denied.status);
    const text = await denied.text();
    expect(text).not.toContain('libraryEntry');
    expect(text).not.toContain('planned');
    expect(text).not.toContain(native.originalDigest);
    expect(await native.inspect(actor.accountId)).toEqual(before);
  }
});

test('revoking a real native gate grant denies an authorized HTTP receipt before its private body is read', async () => {
  const who = await native.identity(['subject:read', 'library_entry:update', 'library_entry:read']);
  const subjectId = await native.createSubject('game');
  const key = entryKey();
  const first = await json(await native.send(who.bearer, 'PUT', path(subjectId), { state: 'planned' }, key), 201);
  await native.grantLibraryGate(who.actor.accountId);
  await native.setLibraryOpen(false);
  try {
    const before = await native.inspect(who.actor.accountId);
    expect(await json(await native.send(who.bearer, 'PUT', path(subjectId), { state: 'planned' }, key), 201)).toEqual(
      first,
    );
    expect(await native.inspect(who.actor.accountId)).toEqual(before);
    await native.revokeLibraryGate(who.actor.accountId);
    const revoked = await native.inspect(who.actor.accountId);
    const denied = await native.send(who.bearer, 'PUT', path(subjectId), { state: 'planned' }, key);
    await problem(denied, 403, 'platform_closed');
    expect(await native.inspect(who.actor.accountId)).toEqual(revoked);
  } finally {
    await native.setLibraryOpen(true);
  }
});

test('owner other anonymous and hidden-source requests conceal private values and rejected writes leave no effects', async () => {
  const subjectId = await native.createSubject('game');
  await native.commands.putEntry(native.owner.actor, subjectId, { state: 'planned' }, entryKey());
  const hidden = await native.createSubject('recipe');
  await json(
    await native.send('steward', 'POST', `/v1/subjects/${hidden}:hide`, { reason: 'Native concealment' }),
    200,
  );
  const before = await native.inspect();
  await expect(native.commands.readEntry(native.other.actor, subjectId)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await problem(await native.send('other', 'GET', path(subjectId)), 404, 'not_found');
  const anonymous = await native.send('anonymous', 'GET', path(subjectId));
  expect([401, 404]).toContain(anonymous.status);
  expect(await anonymous.text()).not.toContain('planned');
  for (const id of [hidden, native.unknownSubject()]) {
    await problem(await native.send('owner', 'PUT', path(id), { state: 'planned' }), 404, 'not_found');
  }
  for (const forged of [
    { state: 'planned', pin: pin(native.originalDigest, 'game') },
    { state: 'planned', profileId: 'fixture.game' },
    { state: 'planned', acceptingType: entryTypes.game },
  ])
    await problem(await native.send('owner', 'PUT', path(subjectId), forged), 400, 'invalid_request');
  expect(await native.inspect()).toEqual(before);
  const publicView = await json(await native.send('owner', 'GET', path(subjectId)), 200);
  privateFree(publicView);
});
