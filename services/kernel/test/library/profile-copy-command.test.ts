import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryLabels,
  LIBRARY_LOCALES,
} from '../../../../packages/definitions/test/support/library-profiles.ts';
import { GrantDeniedError } from '../../src/access/contract/errors.ts';
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
      'kind_profile_pin',
      'status_profile_pin',
      'kindProfilePin',
      'statusProfilePin',
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
      expect((await fact(id)).kind_profile_pin).toEqual(pin(originalDigest, vertical));
      expect((await fact(id)).status_profile_pin).toEqual(pin(originalDigest, vertical));
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

test('copy commands retain one deadline and compare source and profile before a fresh mutation', async () => {
  const { deriveAccess } = await import('../../src/access/derived-access.ts');
  for (const operation of ['create', 'update'] as const) {
    for (const change of ['profile', 'source'] as const) {
      await native.activate(originalDigest);
      const subjectId = await native.createSubject('game');
      const originalCopy = await commands.createCopy(owner.actor, input(subjectId), entryKey());
      const before = ownerFacts(await inspect());
      const deadlines: number[] = [];
      let observations = 0;
      const access = deriveAccess(native.access, {
        async prepare(actor, action, resource, context) {
          if (action === 'subject:read') {
            deadlines.push(context.deadline);
            // One Source observation prepares original, terminal and current Type disclosure.
            if (++observations === 4) {
              if (change === 'profile') await native.activate(replacementDigest);
              else
                expect(
                  (
                    await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, {
                      reason: 'Source changed during copy preparation',
                    })
                  ).status,
                ).toBe(200);
            }
          }
          return native.access.prepare?.(actor, action, resource, context);
        },
      });
      const changed = createCopyCommands({ pool: native.pool, access, tokens: native.tokens });
      const request =
        operation === 'create'
          ? changed.createCopy(owner.actor, input(subjectId), entryKey())
          : changed.updateCopy(owner.actor, originalCopy.value.id, { revision: 1, location: 'Desk' }, entryKey());
      await expect(request).rejects.toMatchObject({ code: 'semantic_not_ready' });
      expect(observations).toBeGreaterThanOrEqual(4);
      expect(new Set(deadlines).size).toBe(1);
      expect(ownerFacts(await inspect())).toEqual(before);
    }
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
  expect(updated.status_profile_pin).toEqual(pin(replacementDigest, 'game'));
  expect(updated.kind_profile_pin).toEqual(pin(originalDigest, 'game'));
  expect(updated.library_profile_pin).toEqual(pin(originalDigest, 'game'));
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
  expect(
    (
      await native.send(
        owner.bearer,
        'DELETE',
        `${path(sibling.value.id)}?revision=${sibling.value.revision}`,
        undefined,
        httpKey,
      )
    ).status,
  ).toBe(204);
  const afterHttp = await inspect();
  expect(
    (
      await native.send(
        owner.bearer,
        'DELETE',
        `${path(sibling.value.id)}?revision=${sibling.value.revision}`,
        undefined,
        httpKey,
      )
    ).status,
  ).toBe(204);
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

// Additive owner-detail coverage; existing BASIC and command acceptance assertions stay unchanged.
test('owner detail resolves the actual stored pin, keeps accepted labels through rename and retirement, and has no read effects', async () => {
  const subjectId = await native.createSubject('game');
  const created = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const saved = await fact(created.value.id);
  const currentProfile = {
    id: 'fixture.game-holdings',
    copies: { kinds: [{ id: 'installation', statuses: [{ id: 'licensed' }] }] },
  };
  const data = fixture(currentProfile);
  for (const [key, text] of Object.entries(data.presentation)) {
    const labels = JSON.parse(text);
    labels.libraryProfiles[currentProfile.id].copyKinds.installation = 'Current installation';
    labels.libraryProfiles[currentProfile.id].copyStatuses.installation.licensed = 'Current licence';
    data.presentation[key] = JSON.stringify(labels);
  }
  const renamed = await native.publish(await compileCatalogue(data));
  await native.activate(renamed);
  const before = await inspect();
  const response = await native.send(owner.bearer, 'GET', `${path(created.value.id)}?presentation=FULL`);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await json(response, 200);
  expect(body.copy).toEqual({
    id: created.value.id,
    subjectId,
    kind: 'installation',
    status: 'licensed',
    revision: 1,
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: 'Private licence',
    presentation: {
      meaning: 'known',
      kindLabel: 'installation',
      kindLabelLanguage: 'en',
      statusLabel: 'licensed',
      statusLabelLanguage: 'en',
      statusEditing: {
        state: 'supported',
        statuses: [{ id: 'licensed', label: 'Current licence', labelLanguage: 'en' }],
      },
      mediaCondition: { state: 'not_recorded' },
      packagingCondition: { state: 'not_recorded' },
      conditionEditing: {
        state: 'unavailable',
        currentness: 'current',
        reason: 'unsupported',
      },
    },
  });
  const direct = await commands.readPresentedCopy(owner.actor, created.value.id, ['de']);
  expect(direct.presentation).toMatchObject({ meaning: 'known', kindLabelLanguage: 'de', statusLabelLanguage: 'de' });
  privateFree(direct);
  const full = await json(
    await native.send(owner.bearer, 'GET', `${path(created.value.id)}?view=FULL&presentation=FULL`),
    200,
  );
  expect(full.copy.presentation).toEqual(body.copy.presentation);
  expect(full.copy.subject?.id).toBe(subjectId);
  for (const suffix of ['', '?view=FULL']) {
    const ordinary = (await json(await native.send(owner.bearer, 'GET', `${path(created.value.id)}${suffix}`), 200))
      .copy;
    expect(ordinary).not.toHaveProperty('presentation');
  }
  expect(await fact(created.value.id)).toEqual(saved);
  expect(await inspect()).toEqual(before);
  await native.activate(replacementDigest);
  const retired = await commands.readPresentedCopy(owner.actor, created.value.id);
  expect(retired.presentation).toMatchObject({ meaning: 'known', kindLabel: 'installation', statusLabel: 'licensed' });
  expect(retired.presentation.statusEditing).toEqual({
    state: 'supported',
    statuses: [{ id: 'archived', label: 'archived', labelLanguage: 'en' }],
  });
  // Advisory follows the native explicit-status validator; it is never a permission or historical conversion.
  expect(await fact(created.value.id)).toEqual(saved);
});

test('owner detail distinguishes retired profile from hidden current source without relabelling the private accepted holding', async () => {
  const subjectId = await native.createSubject('record');
  const created = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  await native.activate(replacementDigest);
  const before = await inspect();
  const retired = (
    await json(await native.send(owner.bearer, 'GET', `${path(created.value.id)}?presentation=FULL`), 200)
  ).copy;
  expect(retired.presentation).toMatchObject({
    meaning: 'known',
    kindLabel: 'installation',
    statusEditing: { state: 'unsupported' },
  });
  expect(await inspect()).toEqual(before);
  expect(
    (await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, { reason: 'private-detail-test' })).status,
  ).toBe(200);
  const hiddenBefore = await inspect();
  const hidden = (
    await json(await native.send(owner.bearer, 'GET', `${path(created.value.id)}?view=FULL&presentation=FULL`), 200)
  ).copy;
  expect(hidden.subject).toBeNull();
  expect(hidden.presentation).toMatchObject({
    meaning: 'known',
    kindLabel: 'installation',
    statusEditing: { state: 'unavailable' },
  });
  expect(await inspect()).toEqual(hiddenBefore);
});

test('same-route foreign owner, missing scope and revoked principal cannot expose opt-in detail or cause read effects', async () => {
  const subjectId = await native.createSubject('game');
  const created = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const sameRoute = await native.identity(scopes, undefined, routeOf(owner.actor.accountId)!);
  expect(routeOf(sameRoute.actor.accountId)).toBe(routeOf(created.value.id));
  const noScope = await accountToken({
    accountId: owner.actor.accountId,
    clientId: owner.actor.clientId,
    scopes: ['subject:read'],
  });
  const before = await inspect();
  await expect(commands.readPresentedCopy(sameRoute.actor, created.value.id)).rejects.toBeInstanceOf(
    LibraryNotFoundError,
  );
  for (const bearer of [sameRoute.bearer, noScope, 'anonymous']) {
    const response = await native.send(bearer, 'GET', `${path(created.value.id)}?view=FULL&presentation=FULL`);
    expect([401, 403, 404]).toContain(response.status);
    const raw = await response.text();
    for (const secret of ['Private licence', 'installation', 'licensed', originalDigest, 'presentation', '"copy":'])
      expect(raw).not.toContain(secret);
  }
  expect(await inspect()).toEqual(before);
  const own = await native.identity(scopes);
  const ownCopy = await commands.createCopy(own.actor, input(subjectId), entryKey());
  await native.revokeIdentity(own.actor.accountId);
  const revokedBefore = await native.inspect(own.actor.accountId);
  await expect(commands.readPresentedCopy(own.actor, ownCopy.value.id)).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await native.inspect(own.actor.accountId)).toEqual(revokedBefore);
});

test('detail final fence refuses a changed copy, a changed source or a revoked owner before returning rendered data', async () => {
  for (const change of ['copy', 'source', 'owner'] as const) {
    const who = await native.identity(scopes);
    const subjectId = await native.createSubject('game');
    const created = await commands.createCopy(who.actor, input(subjectId), entryKey());
    const read = commands.readPresentedCopy(who.actor, created.value.id, [], async () => {
      if (change === 'copy')
        await commands.updateCopy(who.actor, created.value.id, { revision: 1, note: 'Changed' }, entryKey());
      if (change === 'source')
        expect(
          (await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, { reason: 'detail-final-fence' }))
            .status,
        ).toBe(200);
      if (change === 'owner') await native.revokeIdentity(who.actor.accountId);
      return 'must not escape';
    });
    if (change === 'copy') await expect(read).rejects.toBeInstanceOf(CopyConflictError);
    if (change === 'source') await expect(read).rejects.toMatchObject({ code: 'semantic_not_ready' });
    if (change === 'owner') await expect(read).rejects.toBeInstanceOf(GrantDeniedError);
  }
});

test('missing exact immutable Copy release never borrows current labels and transient source failure never proves retirement', async () => {
  const subjectId = await native.createSubject('game');
  const created = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const before = await inspect();
  const query = native.pool.query;
  // Read-only fault at the existing exact-release lookup and its cache-existence probe.
  native.pool.query = function (...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
    if (/definitions-(?:read|exists)\.sql/.test(text)) return Promise.resolve({ rows: [], rowCount: 0 });
    return Reflect.apply(query, native.pool, args);
  } as typeof query;
  try {
    const detail = await commands.readPresentedCopy(owner.actor, created.value.id);
    expect(detail.presentation).toEqual({
      meaning: 'unavailable',
      statusEditing: { state: 'unavailable' },
      mediaCondition: { state: 'not_recorded' },
      packagingCondition: { state: 'not_recorded' },
      conditionEditing: {
        state: 'unavailable',
        currentness: 'unavailable',
        reason: 'current_source_unavailable',
      },
    });
    expect(detail).toMatchObject({ id: created.value.id, kind: 'installation', status: 'licensed', revision: 1 });
  } finally {
    native.pool.query = query;
  }
  const { deriveAccess } = await import('../../src/access/derived-access.ts');
  const { AccessUnavailableError } = await import('../../src/access/unavailable.ts');
  const access = deriveAccess(native.access, {
    async prepare(actor, action, resource, context) {
      if (action === 'subject:read') throw new AccessUnavailableError('overloaded');
      return native.access.prepare?.(actor, action, resource, context);
    },
  });
  const unavailable = createCopyCommands({ pool: native.pool, tokens: native.tokens, access });
  expect((await unavailable.readPresentedCopy(owner.actor, created.value.id)).presentation).toMatchObject({
    meaning: 'known',
    kindLabel: 'installation',
    statusEditing: { state: 'unavailable' },
  });
  expect(await inspect()).toEqual(before);
});

test('metadata preserves both meanings and an explicit newer status survives delete and Undo with original kind labels', async () => {
  const subjectId = await native.createSubject('game');
  const created = await commands.createCopy(owner.actor, input(subjectId), entryKey());
  const creation = await fact(created.value.id);
  const currentProfile = {
    id: 'fixture.game-holdings',
    copies: { kinds: [{ id: 'installation', statuses: [{ id: 'licensed' }, { id: 'archived' }] }] },
  };
  const data = fixture(currentProfile);
  for (const [key, text] of Object.entries(data.presentation)) {
    const labels = JSON.parse(text);
    labels.libraryProfiles[currentProfile.id].copyKinds.installation = 'Current installation';
    labels.libraryProfiles[currentProfile.id].copyStatuses.installation.licensed = 'Current licence';
    labels.libraryProfiles[currentProfile.id].copyStatuses.installation.archived = 'Archived now';
    data.presentation[key] = JSON.stringify(labels);
  }
  const currentDigest = await native.publish(await compileCatalogue(data));
  await native.activate(currentDigest);
  await commands.updateCopy(owner.actor, created.value.id, { revision: 1, location: 'Study' }, entryKey());
  const metadata = await fact(created.value.id);
  for (const field of ['library_profile_pin', 'kind_profile_pin', 'status_profile_pin'])
    expect(metadata[field]).toEqual(creation[field]);
  expect((await commands.readPresentedCopy(owner.actor, created.value.id)).presentation).toMatchObject({
    meaning: 'known',
    kindLabel: 'installation',
    statusLabel: 'licensed',
  });
  await json(
    await native.send(owner.bearer, 'PATCH', path(created.value.id), { revision: 2, status: 'archived' }),
    200,
  );
  const updated = await fact(created.value.id);
  expect(updated.status_profile_pin).toEqual(pin(currentDigest, 'game'));
  expect(updated.kind_profile_pin).toEqual(creation.kind_profile_pin);
  expect(updated.library_profile_pin).toEqual(creation.library_profile_pin);
  const before = await inspect();
  const presented = (
    await json(await native.send(owner.bearer, 'GET', `${path(created.value.id)}?presentation=FULL`), 200)
  ).copy;
  expect(presented).toMatchObject({
    id: created.value.id,
    subjectId,
    revision: 3,
    kind: 'installation',
    status: 'archived',
    location: 'Study',
    presentation: { meaning: 'known', kindLabel: 'installation', statusLabel: 'Archived now' },
  });
  expect(await inspect()).toEqual(before);
  await commands.deleteCopy(owner.actor, created.value.id, 3, entryKey());
  const deleted = await fact(created.value.id);
  expect(new Date(deleted.restore_until).getTime() - new Date(deleted.deleted_at).getTime()).toBe(720 * 60 * 60 * 1000);
  for (const field of ['library_profile_pin', 'kind_profile_pin', 'status_profile_pin'])
    expect(deleted[field]).toEqual(updated[field]);
  // Undo accepts the actual historic status, even when today's profile no longer offers it.
  await native.activate(originalDigest);
  const restored = await json(
    await native.send(owner.bearer, 'POST', `${path(created.value.id)}:restore`, {
      deletionId: deleted.deletion_id,
      revision: deleted.revision,
    }),
    200,
  );
  expect(restored.copy).toMatchObject({ id: created.value.id, revision: 5, status: 'archived', location: 'Study' });
  const final = await fact(created.value.id);
  for (const field of ['library_profile_pin', 'kind_profile_pin', 'status_profile_pin', 'created_at', 'updated_at'])
    expect(final[field]).toEqual(updated[field]);
  expect((await commands.readPresentedCopy(owner.actor, created.value.id)).presentation).toMatchObject({
    meaning: 'known',
    kindLabel: 'installation',
    statusLabel: 'Archived now',
    statusEditing: { state: 'supported', statuses: [{ id: 'licensed', label: 'licensed', labelLanguage: 'en' }] },
  });
}, 120_000);
