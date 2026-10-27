import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryLabels,
  LIBRARY_LOCALES,
} from '../../../../packages/definitions/test/support/library-profiles.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { CopyConflictError, createCopyCommands } from '../../src/library/copies.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { accountToken, authenticateAccount } from '../support/admitted-access.ts';
import {
  compileEntryRelease,
  createProfileEntryFixture,
  entryKey,
  entryTypes,
  type NativeProfileFixture,
} from './support/profile-entry-fixture.ts';

// Only source data changes: the ordinary compiler resolves references and all eight presentations.
async function compileCopyRelease(replacement: boolean) {
  const kinds = [
    { id: 'installation', statuses: [{ id: replacement ? 'archived' : 'licensed' }] },
    ...(!replacement ? [{ id: 'pressing', statuses: [{ id: 'kept' }] }] : []),
  ];
  const game = { id: 'fixture.game-holdings', copies: { kinds } };
  const recipe = {
    id: 'fixture.recipe-holdings',
    copies: { kinds: [{ id: 'pressing', statuses: [{ id: replacement ? 'catalogued' : 'kept' }] }] },
  };
  const record = { id: 'fixture.record-holdings', copies: { kinds } };
  const input = fixture(game);
  const schema = JSON.parse(input.schemas['fixture.yaml']!);
  schema.version = replacement ? 'copy-replacement' : 'copy-original';
  schema.classes.Recipe = { class_uri: entryTypes.recipe, annotations: { library: recipe } };
  schema.classes.Record = {
    class_uri: entryTypes.record,
    ...(!replacement ? { annotations: { library: record } } : {}),
  };
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
  for (const [key, text] of Object.entries(input.presentation)) {
    const labels = JSON.parse(text);
    const locale = key.split('/')[1] as (typeof LIBRARY_LOCALES)[number];
    Object.assign(labels.types, { [entryTypes.recipe]: 'recipe', [entryTypes.record]: 'record' });
    for (const profile of [recipe, ...(!replacement ? [record] : [])])
      labels.libraryProfiles[profile.id] = libraryLabels(profile, locale);
    input.presentation[key] = JSON.stringify(labels);
  }
  return compileCatalogue(input);
}

let native: NativeProfileFixture;
let commands: ReturnType<typeof createCopyCommands>;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let other: typeof owner;
let original: Awaited<ReturnType<typeof compileCopyRelease>>;
let replacement: typeof original;
let originalDigest: string;
let replacementDigest: string;
const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'];
const path = (id: string) => `/v1/copies/${id}`;
const input = (subjectId: string) => ({ subjectId, kind: 'installation', status: 'licensed', note: 'Private licence' });
const inspect = () => native.inspect(owner.actor.accountId);
function ownerFacts({ partition: _partition, ...facts }: Awaited<ReturnType<typeof inspect>>) {
  return facts;
}
const pin = (digest: string, vertical: 'game' | 'recipe' | 'record') => ({
  provenance: 'profile',
  releaseDigest: digest,
  acceptingType: entryTypes[vertical],
  profileId: original.types[entryTypes[vertical]]!.library!.profileId,
});
async function fact(id: string) {
  const rows = (await inspect()).copies.filter(({ row }) => row.copy_id === id);
  expect(rows).toHaveLength(1);
  return rows[0]!.row;
}
function privateFree(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      'pin',
      'library_profile_pin',
      'libraryProfilePin',
      'profileId',
      'releaseDigest',
      'acceptingType',
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
async function json(response: Response, status: number) {
  const body = await response.json();
  expect({ status: response.status, body }).toEqual({ status, body: expect.any(Object) });
  privateFree(body);
  return body;
}
async function problem(response: Response, status: number, code: string) {
  const body = await json(response, status);
  expect(body.code).toBe(code);
  expect(body.effect_status).toBe('not_applied');
  expect(body).not.toHaveProperty('copy');
}
function publicCopy(copy: Record<string, unknown>) {
  expect(Object.keys(copy).sort()).toEqual(
    ['id', 'subjectId', 'kind', 'status', 'revision', 'location', 'source', 'acquiredOn', 'disposedOn', 'note'].sort(),
  );
  privateFree(copy);
}

beforeAll(async () => {
  original = await compileCopyRelease(false);
  replacement = await compileCopyRelease(true);
  native = await createProfileEntryFixture();
  owner = await native.identity(scopes);
  other = await native.identity(scopes);
  commands = createCopyCommands({ pool: native.pool, access: native.access, tokens: native.tokens });
  originalDigest = await native.publish(original);
  replacementDigest = await native.publish(replacement);
}, 120_000);
beforeEach(async () => {
  await native.activate(originalDigest);
});
afterAll(async () => {
  await native?.close();
});

test('compiled data and native identity publication activation and readonly inspection controls are real', async () => {
  expect(await compileEntryRelease('original')).toEqual(native.original);
  for (const vertical of ['game', 'recipe', 'record'] as const) {
    const profile = original.libraryProfiles![original.types[entryTypes[vertical]]!.library!.profileId]!;
    for (const kind of profile.copies!.kinds) {
      expect(Object.keys(kind.labels).sort()).toEqual([...LIBRARY_LOCALES].sort());
      for (const status of kind.statuses)
        expect(Object.keys(status.labels).sort()).toEqual([...LIBRARY_LOCALES].sort());
    }
  }
  expect(replacement.types[entryTypes.record]!.library).toBeUndefined();
  expect(replacement.types[entryTypes.unprofiled]!.library).toBeUndefined();
  expect(replacement.libraryProfiles!['legacy-fixed-v1']).toBeDefined();
  const subjectId = await native.createSubject('game');
  expect((await native.send(owner.bearer, 'GET', `/v1/subjects/${subjectId}`)).status).toBe(200);
  expect(await commands.listCopies(owner.actor)).toEqual({ copies: [], next: null });
  expect(await json(await native.send(owner.bearer, 'GET', '/v1/copies'), 200)).toEqual({ copies: [], next: null });
  const before = await inspect();
  await native.activate(replacementDigest);
  await native.activate(originalDigest);
  expect(ownerFacts(await inspect())).toEqual(ownerFacts(before));
});

test('native holdings accept declared data kind status pairs pin fresh facts and preserve authorized receipts and independent copy identities', async () => {
  for (const vertical of ['game', 'recipe'] as const) {
    const subjectId = await native.createSubject(vertical);
    const pair =
      vertical === 'game' ? { kind: 'installation', status: 'licensed' } : { kind: 'pressing', status: 'kept' };
    const before = await inspect();
    const first = await commands.createCopy(owner.actor, { subjectId, ...pair, location: 'Study' }, entryKey());
    expect(first.replayed).toBe(false);
    expect(first.value).toMatchObject({ subjectId, ...pair, revision: 1 });
    const second = (
      await json(
        await native.send(owner.bearer, 'POST', '/v1/copies', {
          subjectId,
          ...pair,
          location: 'Archive',
          note: 'Independent holding',
        }),
        201,
      )
    ).copy;
    publicCopy(second);
    expect(second.id).not.toBe(first.value.id);
    expect(routeOf(first.value.id)).toBe(routeOf(owner.actor.accountId));
    expect(routeOf(second.id)).toBe(routeOf(owner.actor.accountId));
    const sibling = await fact(second.id);
    for (const id of [first.value.id, second.id]) {
      expect((await fact(id)).library_profile_pin).toEqual(pin(originalDigest, vertical));
      const view = (await json(await native.send(owner.bearer, 'GET', path(id)), 200)).copy;
      publicCopy(view);
      expect(view).toMatchObject({ id, subjectId, ...pair });
    }
    const changed = await commands.updateCopy(
      owner.actor,
      first.value.id,
      { revision: 1, location: 'Desk' },
      entryKey(),
    );
    expect(changed.value).toMatchObject({ id: first.value.id, subjectId, revision: 2, location: 'Desk' });
    await expect(
      commands.updateCopy(owner.actor, first.value.id, { revision: 1, note: 'stale' }, entryKey()),
    ).rejects.toBeInstanceOf(CopyConflictError);
    expect(await fact(second.id)).toEqual(sibling);
    const page = await json(await native.send(owner.bearer, 'GET', `/v1/copies?subjectId=${subjectId}`), 200);
    expect(page.copies.map((copy: { id: string }) => copy.id).sort()).toEqual([first.value.id, second.id].sort());
    page.copies.forEach(publicCopy);
    const after = await inspect();
    expect(after.copies).toHaveLength(before.copies.length + 2);
    expect(after.receipts).toHaveLength(before.receipts.length + 3);
    const events = after.events.slice(before.events.length);
    expect(events).toHaveLength(3);
    for (const { row } of events) {
      expect(row.type).toBe('com.rezics.library.copy.updated.v1');
      expect(row.subject).toBe(owner.actor.accountId);
      expect(Object.keys(row.data)).toEqual(['copyId']);
      expect([first.value.id, second.id]).toContain(row.data.copyId);
      privateFree(row.data);
    }
    for (const table of ['entries', 'sessions', 'follows', 'entitlements'] as const)
      expect(after[table]).toEqual(before[table]);
  }
});

test('well formed absent pairs and old status names are unsupported capability data without effects', async () => {
  const subjectId = await native.createSubject('game');
  for (const pair of [
    { kind: 'installation', status: 'kept' },
    { kind: 'pressing', status: 'licensed' },
    { kind: 'absent', status: 'licensed' },
    { kind: 'installation', status: 'undeclared' },
    ...['ordered', 'owned', 'lent', 'disposed'].map((status) => ({ kind: 'installation', status })),
    { kind: 'legacy-unspecified', status: 'owned' },
  ]) {
    const before = await inspect();
    await problem(
      await native.send(owner.bearer, 'POST', '/v1/copies', { subjectId, ...pair }),
      422,
      'unsupported_library_profile',
    );
    expect(await inspect()).toEqual(before);
  }
});

test('fresh copies require explicit kind even with an old status source or location', async () => {
  const subjectId = await native.createSubject('game');
  const before = await inspect();
  await problem(
    await native.send(owner.bearer, 'POST', '/v1/copies', {
      subjectId,
      status: 'owned',
      source: 'Licence seller',
      location: 'Digital installation',
    }),
    400,
    'invalid_request',
  );
  expect(await inspect()).toEqual(before);
});

test('malformed generic identifiers and caller supplied pin profile or release metadata are invalid requests', async () => {
  const subjectId = await native.createSubject('game');
  const before = await inspect();
  for (const invalid of [
    { kind: '' },
    { kind: 'Invalid Kind' },
    { kind: 'a'.repeat(65) },
    { kind: null },
    { status: '' },
    { status: undefined },
    { status: 'licensed\n' },
    { status: 42 },
    { pin: pin(originalDigest, 'game') },
    { library_profile_pin: pin(originalDigest, 'game') },
    { profileId: 'fixture.game-holdings' },
    { profile: original.libraryProfiles!['fixture.game-holdings'] },
    { acceptingType: entryTypes.game },
    { releaseDigest: originalDigest },
    { release: original },
    { provenance: 'profile' },
  ])
    await problem(
      await native.send(owner.bearer, 'POST', '/v1/copies', { ...input(subjectId), ...invalid }),
      400,
      'invalid_request',
    );
  expect(await inspect()).toEqual(before);
});

test('readable unprofiled subjects reject new holdings without enabling an unattached legacy profile', async () => {
  const subjectId = await native.createSubject('unprofiled');
  expect((await native.send(owner.bearer, 'GET', `/v1/subjects/${subjectId}`)).status).toBe(200);
  const before = await inspect();
  await problem(
    await native.send(owner.bearer, 'POST', '/v1/copies', input(subjectId)),
    422,
    'unsupported_library_profile',
  );
  expect(await inspect()).toEqual(before);
});

test('fresh status updates store the observed pin while retired kind status facts survive activation and rollback unchanged', async () => {
  const subjectId = await native.createSubject('game');
  const first = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const sibling = await commands.createCopy(owner.actor, { subjectId, kind: 'pressing', status: 'kept' }, entryKey());
  const saved = await fact(first.value.id);
  const savedSibling = await fact(sibling.value.id);
  const before = await inspect();
  await native.activate(replacementDigest);
  expect(ownerFacts(await inspect())).toEqual(ownerFacts(before));
  const oldRead = (await json(await native.send(owner.bearer, 'GET', path(sibling.value.id)), 200)).copy;
  expect(oldRead).toMatchObject({ kind: 'pressing', status: 'kept' });
  const rejected = await inspect();
  await problem(
    await native.send(owner.bearer, 'PATCH', path(first.value.id), { revision: 1, status: 'licensed' }),
    422,
    'unsupported_library_profile',
  );
  await problem(
    await native.send(owner.bearer, 'PATCH', path(sibling.value.id), { revision: 1, note: 'new value' }),
    422,
    'unsupported_library_profile',
  );
  await problem(
    await native.send(owner.bearer, 'POST', '/v1/copies', { subjectId, kind: 'pressing', status: 'kept' }),
    422,
    'unsupported_library_profile',
  );
  expect(await inspect()).toEqual(rejected);
  await json(await native.send(owner.bearer, 'PATCH', path(first.value.id), { revision: 1, status: 'archived' }), 200);
  const updated = await fact(first.value.id);
  expect(updated).toMatchObject({
    copy_id: saved.copy_id,
    subject_id: saved.subject_id,
    account_id: saved.account_id,
    kind: saved.kind,
    created_at: saved.created_at,
    note: saved.note,
    status: 'archived',
    revision: 2,
  });
  expect(updated.library_profile_pin).toEqual(pin(replacementDigest, 'game'));
  expect(await fact(sibling.value.id)).toEqual(savedSibling);
  const after = await inspect();
  await native.activate(originalDigest);
  expect(ownerFacts(await inspect())).toEqual(ownerFacts(after));
  expect(await commands.readCopy(owner.actor, first.value.id)).toMatchObject({ status: 'archived' });
  expect((await json(await native.send(owner.bearer, 'GET', path(first.value.id)), 200)).copy.status).toBe('archived');
  expect(await fact(first.value.id)).toEqual(updated);
});

test('authorized create and update receipts retain exact HTTP status body digest and pin after profile replacement removal and source hide', async () => {
  for (const vertical of ['game', 'record'] as const) {
    await native.activate(originalDigest);
    const subjectId = await native.createSubject(vertical);
    const body = input(subjectId),
      createKey = entryKey(),
      updateKey = entryKey();
    const first = await native.send(owner.bearer, 'POST', '/v1/copies', body, createKey);
    expect(first.status).toBe(201);
    const originalBody = await first.text(),
      id = JSON.parse(originalBody).copy.id;
    const patch = { revision: 1, status: 'licensed', note: 'Receipt update' };
    const update = await native.send(owner.bearer, 'PATCH', path(id), patch, updateKey);
    expect(update.status).toBe(200);
    const updatedBody = await update.text();
    const saved = await fact(id);
    expect(saved.library_profile_pin).toEqual(pin(originalDigest, vertical));
    await native.activate(replacementDigest);
    await json(
      await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, { reason: 'Copy receipt source absence' }),
      200,
    );
    expect((await native.send(owner.bearer, 'GET', `/v1/subjects/${subjectId}`)).status).toBe(404);
    const before = await inspect();
    const createReplay = await native.send(owner.bearer, 'POST', '/v1/copies', body, createKey);
    expect(createReplay.status).toBe(201);
    expect(await createReplay.text()).toBe(originalBody);
    const updateReplay = await native.send(owner.bearer, 'PATCH', path(id), patch, updateKey);
    expect(updateReplay.status).toBe(200);
    expect(await updateReplay.text()).toBe(updatedBody);
    const direct = await commands.createCopy(owner.actor, body, createKey);
    expect(direct.replayed).toBe(true);
    expect(direct.value).toMatchObject({ id, revision: 1, status: 'licensed' });
    expect((await commands.updateCopy(owner.actor, id, patch, updateKey)).replayed).toBe(true);
    await expect(commands.createCopy(owner.actor, { ...body, status: 'undeclared' }, createKey)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await problem(
      await native.send(owner.bearer, 'POST', '/v1/copies', { ...body, status: 'undeclared' }, createKey),
      422,
      'idempotency_conflict',
    );
    await problem(
      await native.send(owner.bearer, 'PATCH', path(id), { ...patch, status: 'undeclared' }, updateKey),
      422,
      'idempotency_conflict',
    );
    expect(await inspect()).toEqual(before);
    expect(await fact(id)).toEqual(saved);
  }
});

test('native current scope suspension and authn fence deny prior receipts without returning private bodies', async () => {
  const subjectId = await native.createSubject('game');
  for (const denial of ['scope', 'suspension', 'revocation'] as const) {
    const who = await native.identity(scopes);
    const key = entryKey(),
      body = input(subjectId);
    const created = await commands.createCopy(who.actor, body, key);
    const patch = { revision: 1, status: 'licensed' },
      updateKey = entryKey();
    await commands.updateCopy(who.actor, created.value.id, patch, updateKey);
    let actor = who.actor,
      bearer = who.bearer;
    if (denial === 'scope') {
      const claims = { accountId: actor.accountId, clientId: actor.clientId, scopes: ['subject:read'] };
      bearer = await accountToken(claims);
      actor = await authenticateAccount(native.access, { pool: native.pool, deadline: deadlineFor(30_000) }, claims);
    } else if (denial === 'suspension') await native.suspend(actor.accountId);
    else await native.revokeIdentity(actor.accountId);
    const before = await native.inspect(actor.accountId);
    await expect(commands.createCopy(actor, body, key)).rejects.toBeInstanceOf(GrantDeniedError);
    await expect(commands.updateCopy(actor, created.value.id, patch, updateKey)).rejects.toBeInstanceOf(
      GrantDeniedError,
    );
    const deniedUpdate = await native.send(bearer, 'PATCH', path(created.value.id), patch, updateKey);
    expect([401, 403, 404]).toContain(deniedUpdate.status);
    expect(await deniedUpdate.text()).not.toContain('licensed');
    const denied = await native.send(bearer, 'POST', '/v1/copies', body, key);
    expect([401, 403, 404]).toContain(denied.status);
    const raw = await denied.text();
    for (const secret of ['Private licence', 'licensed', originalDigest, '"copy":']) expect(raw).not.toContain(secret);
    expect(await native.inspect(actor.accountId)).toEqual(before);
  }
});

test('other and anonymous readers and writers cannot infer an owners private holding', async () => {
  const subjectId = await native.createSubject('game');
  const created = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const id = created.value.id,
    before = await inspect();
  await expect(commands.readCopy(other.actor, id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect((await commands.listCopies(other.actor, { subjectId })).copies).toEqual([]);
  for (const persona of [other.bearer, 'anonymous']) {
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { revision: 1, note: 'Intrusion' }],
      ['DELETE', undefined],
    ] as const) {
      const denied = await native.send(persona, method, path(id), body);
      expect(persona === 'anonymous' ? [401, 404] : [404]).toContain(denied.status);
      const raw = await denied.text();
      for (const secret of ['Private licence', 'licensed', originalDigest, '"copy":'])
        expect(raw).not.toContain(secret);
    }
  }
  expect(await inspect()).toEqual(before);
});

test('profile retirement allows own delete and exact replay while denying all fresh copy values', async () => {
  const subjectId = await native.createSubject('record');
  const created = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const sibling = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const savedSibling = await fact(sibling.value.id);
  await native.activate(replacementDigest);
  const before = await inspect();
  await problem(
    await native.send(owner.bearer, 'POST', '/v1/copies', input(subjectId)),
    422,
    'unsupported_library_profile',
  );
  await problem(
    await native.send(owner.bearer, 'PATCH', path(created.value.id), { revision: 1, note: 'Fresh' }),
    422,
    'unsupported_library_profile',
  );
  expect(await inspect()).toEqual(before);
  const key = entryKey();
  const first = await commands.deleteCopy(owner.actor, created.value.id, 1, key);
  expect(first.replayed).toBe(false);
  const deleted = await inspect();
  expect((await commands.deleteCopy(owner.actor, created.value.id, 1, key)).replayed).toBe(true);
  expect(await inspect()).toEqual(deleted);
  expect(await fact(sibling.value.id)).toEqual(savedSibling);
  expect((await native.send(owner.bearer, 'GET', path(created.value.id))).status).toBe(404);
  const httpKey = entryKey();
  expect((await native.send(owner.bearer, 'DELETE', path(sibling.value.id), undefined, httpKey)).status).toBe(204);
  const afterHttp = await inspect();
  expect((await native.send(owner.bearer, 'DELETE', path(sibling.value.id), undefined, httpKey)).status).toBe(204);
  expect(await inspect()).toEqual(afterHttp);
  expect(afterHttp.receipts).toHaveLength(before.receipts.length + 2);
  const events = afterHttp.events.slice(before.events.length);
  expect(events).toHaveLength(2);
  for (const { row } of events) {
    expect(row.type).toBe('com.rezics.library.copy.deleted.v1');
    expect(row.subject).toBe(owner.actor.accountId);
    expect(Object.keys(row.data)).toEqual(['copyId']);
    privateFree(row.data);
  }
});
