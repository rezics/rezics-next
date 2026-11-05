import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let other: typeof owner;
const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'];
beforeAll(async () => {
  f = await createProfileEntryFixture();
  owner = await f.identity(scopes);
  other = await f.identity(scopes);
  const release = await compileCatalogue(
    fixture({
      id: 'fixture.copy-retention',
      copies: { kinds: [{ id: 'physical', condition: 'physical-v1', statuses: [{ id: 'owned' }, { id: 'lent' }] }] },
    }),
  );
  await f.activate(await f.publish(release));
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/personal_library:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('private holding clear and exact Undo preserve identity and independent siblings without exposing retained values', async () => {
  const subjectId = await f.createSubject('game');
  const input = {
    subjectId,
    kind: 'physical',
    status: 'owned',
    mediaCondition: 'mint',
    packagingCondition: 'near_mint',
    note: 'private edition',
  };
  const made = await f.send(owner.bearer, 'POST', '/v1/copies', input);
  expect(made.status).toBe(201);
  let original = (await made.json()).copy;
  const sibling = await f.send(owner.bearer, 'POST', '/v1/copies', input);
  expect(sibling.status).toBe(201);
  const siblingId = (await sibling.json()).copy.id;
  expect(siblingId).not.toBe(original.id);
  const edited = await f.send(owner.bearer, 'PATCH', `/v1/copies/${original.id}`, {
    revision: original.revision,
    status: 'lent',
    mediaCondition: 'good',
    packagingCondition: null,
  });
  expect(edited.status).toBe(200);
  original = (await edited.json()).copy;
  expect(original).toMatchObject({ kind: 'physical', status: 'lent', revision: 2 });
  const inventory = await f.send(
    owner.bearer,
    'GET',
    `/v1/copies?subjectId=${subjectId}&kind=physical&status=lent&limit=1`,
  );
  expect(inventory.status).toBe(200);
  const page = await inventory.json();
  expect(page.copies.map((copy: { id: string }) => copy.id)).toEqual([original.id]);
  expect(page.next).toBeNull();
  expect(page.filterOptions.kinds.choices).toContainEqual(expect.objectContaining({ id: 'physical' }));
  const current = await f.send(owner.bearer, 'GET', `/v1/copies/${original.id}?presentation=FULL`);
  expect(current.status).toBe(200);
  const presentation = (await current.json()).copy.presentation;
  expect(presentation.mediaCondition).toMatchObject({ state: 'recorded', id: 'good' });
  expect(presentation.packagingCondition).toEqual({ state: 'cleared' });
  const path = `/v1/copies/${original.id}`,
    key = entryKey();
  expect((await f.send(owner.bearer, 'DELETE', `${path}?revision=${original.revision + 1}`)).status).toBe(409);
  const deleted = await f.send(owner.bearer, 'DELETE', `${path}?revision=${original.revision}`, undefined, key);
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  // Discard the acknowledged deletion and recover its exact episode through the original request.
  const recovered = await f.send(owner.bearer, 'DELETE', `${path}?revision=${original.revision}`, undefined, key);
  expect(recovered.status).toBe(204);
  expect(recovered.headers.get('Library-Copy-Deletion-Id')).toBe(deleted.headers.get('Library-Copy-Deletion-Id'));
  expect(recovered.headers.get('Library-Copy-Deletion-Revision')).toBe(
    deleted.headers.get('Library-Copy-Deletion-Revision'),
  );
  const deletionId = recovered.headers.get('Library-Copy-Deletion-Id');
  const revision = Number(deleted.headers.get('Library-Copy-Deletion-Revision'));
  expect(deletionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(revision).toBeGreaterThan(original.revision);
  expect((await f.send(owner.bearer, 'GET', path)).status).toBe(404);
  expect((await f.send(owner.bearer, 'GET', `/v1/copies/${siblingId}`)).status).toBe(200);
  const body = { deletionId, revision };
  const denied = await f.send(other.bearer, 'POST', path + ':restore', body);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('private edition');
  const restored = await f.send(owner.bearer, 'POST', path + ':restore', body, entryKey());
  expect(restored.status).toBe(200);
  const value = (await restored.json()).copy;
  expect(value).toMatchObject({
    id: original.id,
    subjectId,
    kind: original.kind,
    status: original.status,
    note: original.note,
  });
  expect(value.revision).toBeGreaterThan(revision);
  expect(value).not.toHaveProperty('libraryProfilePin');
  const afterUndo = await f.send(owner.bearer, 'GET', `${path}?presentation=FULL`);
  expect(afterUndo.status).toBe(200);
  expect((await afterUndo.json()).copy.presentation).toEqual(presentation);
  const replay = await f.send(owner.bearer, 'DELETE', `${path}?revision=${original.revision}`, undefined, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get('Library-Copy-Deletion-Id')).toBe(deletionId);
  expect((await f.send(owner.bearer, 'GET', path)).status).toBe(200);
}, 120000);
