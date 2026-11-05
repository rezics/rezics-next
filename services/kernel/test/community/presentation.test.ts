import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { Compile } from 'typebox/compile';
import { CommunityPresentationSchema } from '../../src/content/community-presentation-model.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createReactionRelayBase, type ReactionRelayBase } from '../content/reaction-relay-convergence-fixture.ts';

let world: ReactionRelayBase;
beforeAll(async () => {
  world = await createReactionRelayBase();
}, 120_000);
afterAll(async () => {
  await world?.system.close();
});

const empty = { avatarMediaId: null, bannerMediaId: null, rules: null } as const;
const key = () => crypto.randomUUID();
async function realmHead(realmId: string) {
  const result = await world.call('GET', `/v1/realms/${realmId}`, { bearer: world.author.bearer });
  expect(result.response.status, result.text).toBe(200);
  return result.value!.realm;
}
async function patch(realmId: string, head: string, body: unknown, commandKey = key()) {
  return world.call('PATCH', `/v1/realms/${realmId}`, {
    bearer: world.author.bearer,
    key: commandKey,
    body,
    headers: { 'if-match': JSON.stringify(head) },
  });
}

test.serial(
  'actual Realm presentation settings pin native rules through CAS and ordinary authoring',
  async () => {
    const target = await world.createRealmTarget('Pinned native rules', 'public');
    const initial = await realmHead(target.realmId);
    expect(initial.presentation).toEqual(empty);
    const source = await world.call('GET', `/v1/posts/${target.postId}`, { bearer: world.author.bearer });
    expect(source.response.status, source.text).toBe(200);
    const original = source.value!.post;
    const pin = { postId: original.id, revisionId: original.revisionId };
    const presentation = { ...empty, rules: pin };
    const commandKey = key();
    const adopted = await patch(target.realmId, initial.headRevisionId, { summary: '', presentation }, commandKey);
    expect(adopted.response.status, adopted.text).toBe(200);
    expect(adopted.value!.realm.presentation).toEqual(presentation);
    const head = adopted.value!.realm.headRevisionId;
    const replay = await patch(target.realmId, initial.headRevisionId, { summary: '', presentation }, commandKey);
    expect(replay.response.status, replay.text).toBe(200);
    expect(replay.value!.realm.headRevisionId).toBe(head);
    expect((await patch(target.realmId, initial.headRevisionId, { presentation })).response.status).toBe(412);

    const board = await world.call('GET', `/v1/boards/${target.boardId}`);
    expect(board.response.status, board.text).toBe(200);
    expect(board.value!.board.realmId).toBe(target.realmId);
    const community = board.value!.board.community;
    expect(Compile(CommunityPresentationSchema()).Check(community)).toBe(true);
    expect(community).toMatchObject({
      realmId: target.realmId,
      description: '',
      members: { state: 'unknown', count: null, version: null },
      join: { membership: 'unknown', action: 'sign-in' },
      rules: { state: 'available', value: { ...pin, licence: original.licence, sha256: original.sha256 } },
    });
    expect(serializeDocument(community.rules.value.body)).toBe(serializeDocument(original.body));

    // Original native post authoring stays independent of the Realm pin.
    const edited = await world.call('POST', `/v1/posts/${target.postId}/revisions`, {
      bearer: world.author.bearer,
      key: key(),
      body: { body: fromPlainText('Later rules are not adopted') },
      headers: { 'if-match': JSON.stringify(original.revisionId) },
    });
    expect(edited.response.status, edited.text).toBe(200);
    expect(edited.value!.post.revisionId).not.toBe(pin.revisionId);
    const after = await world.call('GET', `/v1/boards/${target.boardId}`);
    expect(after.response.status, after.text).toBe(200);
    expect(after.value!.board.community.rules.value.revisionId).toBe(pin.revisionId);
    expect(serializeDocument(after.value!.board.community.rules.value.body)).toBe(serializeDocument(original.body));
    const deniedEdit = await world.call('POST', `/v1/posts/${target.postId}/revisions`, {
      bearer: world.other.bearer,
      key: key(),
      body: { body: fromPlainText('Unrelated editor') },
    });
    expect([403, 404]).toContain(deniedEdit.response.status);

    const preserved = await patch(target.realmId, head, { title: 'Current Realm presentation' });
    expect(preserved.response.status, preserved.text).toBe(200);
    expect(preserved.value!.realm.presentation).toEqual(presentation);
    const home = await world.call('GET', `/v1/spaces/${initial.spaceId}`);
    expect(home.response.status, home.text).toBe(200);
    expect(home.value!.community).toMatchObject({
      realmId: target.realmId,
      name: 'Current Realm presentation',
      description: '',
    });
    const list = await world.call('GET', `/v1/realms/${target.realmId}/boards`);
    expect(list.response.status, list.text).toBe(200);
    expect(
      list.value!.items.find((item: { id: string }) => item.id === target.boardId).community.rules.value.revisionId,
    ).toBe(pin.revisionId);

    // A different Realm cannot adopt this exact source, even with its own management role.
    const foreign = await world.createRealmTarget('Separate rules authority', 'public');
    const foreignHead = await realmHead(foreign.realmId);
    expect((await patch(foreign.realmId, foreignHead.headRevisionId, { presentation })).response.status).toBe(400);
    expect(
      (await patch(target.realmId, preserved.value!.realm.headRevisionId, { presentation: { rules: pin } })).response
        .status,
    ).toBe(400);
    expect(
      (
        await patch(target.realmId, preserved.value!.realm.headRevisionId, {
          presentation: { ...presentation, extra: true },
        })
      ).response.status,
    ).toBe(400);
  },
  120_000,
);

test.serial(
  'current-authorized community header keeps unavailable media and current loss of native rules and Realm authority',
  async () => {
    const target = await world.createRealmTarget('Current disclosure', 'public');
    const initial = await realmHead(target.realmId);
    const source = await world.call('GET', `/v1/posts/${target.postId}`, { bearer: world.author.bearer });
    const pin = { postId: target.postId, revisionId: source.value!.post.revisionId };
    const adopted = await patch(target.realmId, initial.headRevisionId, { presentation: { ...empty, rules: pin } });
    expect(adopted.response.status, adopted.text).toBe(200);
    const head = adopted.value!.realm.headRevisionId;
    const media = await patch(target.realmId, head, {
      presentation: { avatarMediaId: newId(routeOf(target.realmId)!), bannerMediaId: null, rules: pin },
    });
    expect(media.response.status, media.text).toBe(409);
    expect(media.value!.code).toBe('media_unavailable');
    expect((await realmHead(target.realmId)).headRevisionId).toBe(head);
    expect((await realmHead(target.realmId)).presentation).toEqual({ ...empty, rules: pin });

    const hidden = await world.command(
      'POST',
      `/v1/posts/${target.postId}:takeDown`,
      { reason: 'Conceal adopted native rules' },
      { bearer: world.governance.bearer, expectedStatus: 200 },
    );
    expect(hidden).toBeDefined();
    const board = await world.call('GET', `/v1/boards/${target.boardId}`);
    expect(board.response.status, board.text).toBe(200);
    expect(board.value!.board.community.rules).toEqual({ state: 'none', value: null });
    expect(board.value!.board.community.avatar).toEqual({ state: 'none', value: null });
    expect(board.text).not.toContain(pin.revisionId);

    const protectedRealm = await patch(target.realmId, head, { visibility: 'protected' });
    expect(protectedRealm.response.status, protectedRealm.text).toBe(200);
    const lost = await world.call('GET', `/v1/boards/${target.boardId}`);
    expect(lost.response.status, lost.text).toBe(404);
    expect(lost.text).not.toContain(target.realmId);
    const owner = await world.call('GET', `/v1/boards/${target.boardId}`, { bearer: world.author.bearer });
    expect(owner.response.status, owner.text).toBe(200);
    expect(owner.value!.board.community).toMatchObject({
      realmId: target.realmId,
      members: { state: 'unknown', count: null, version: null },
      join: { membership: 'nonmember', action: null },
    });
    const cleared = await patch(target.realmId, protectedRealm.value!.realm.headRevisionId, { presentation: empty });
    expect(cleared.response.status, cleared.text).toBe(200);
    expect(cleared.value!.realm.presentation).toEqual(empty);
  },
  120_000,
);
