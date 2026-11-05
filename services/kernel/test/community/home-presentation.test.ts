import { afterAll, beforeAll, expect, test } from 'bun:test';
import { serializeDocument } from '@rezics/document';
import { Compile } from 'typebox/compile';
import { readRealmHomePresentation } from '../../src/community/realm-home-presentation.ts';
import openMembership from '../../src/community/membership-open.sql';
import { CommunityPresentationSchema } from '../../src/content/community-presentation-model.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createReactionRelayBase, type ReactionRelayBase } from '../content/reaction-relay-convergence-fixture.ts';

let world: ReactionRelayBase;
beforeAll(async () => {
  world = await createReactionRelayBase();
}, 120_000);
afterAll(async () => {
  await world?.system.close();
});

async function adoptedRealm(title: string) {
  const target = await world.createRealmTarget(title, 'public');
  const realm = await world.call('GET', `/v1/realms/${target.realmId}`, { bearer: world.author.bearer });
  expect(realm.response.status, realm.text).toBe(200);
  const post = await world.call('GET', `/v1/posts/${target.postId}`);
  expect(post.response.status, post.text).toBe(200);
  const pin = { postId: target.postId, revisionId: post.value!.post.revisionId as string };
  const selected = await patch(target.realmId, realm.value!.realm.headRevisionId, {
    summary: '',
    presentation: { avatarMediaId: null, bannerMediaId: null, rules: pin },
  });
  return { ...target, realm: selected.value!.realm, post: post.value!.post, pin };
}

async function patch(realmId: string, head: string, body: unknown) {
  const result = await world.call('PATCH', `/v1/realms/${realmId}`, {
    bearer: world.author.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(head) },
    body,
  });
  expect(result.response.status, result.text).toBe(200);
  return result;
}

function read(realmId: string, access = world.system.access) {
  return readRealmHomePresentation({ pool: world.system.database.pool, access }, realmId, {
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  });
}

/** The native reader releases its first home snapshot before preparing rules. */
function atRulesBoundary(work: () => Promise<void>): Access {
  const native = world.system.access;
  let pending = true;
  return {
    ...native,
    async prepareReadDecisions(input) {
      if (pending && input.actions.has('post:read')) {
        pending = false;
        await work();
      }
      return native.prepareReadDecisions!(input);
    },
  };
}

test.serial(
  'Expose the adopted native Realm presentation for its Space home',
  async () => {
    const target = await adoptedRealm('Native Realm home');
    const result = await world.call('GET', `/v1/realms/${target.realmId}/presentation`);
    expect(result.response.status, result.text).toBe(200);
    expect(Object.keys(result.value!)).toEqual(['community']);
    const community = result.value!.community;
    expect(Compile(CommunityPresentationSchema()).Check(community)).toBe(true);
    expect(community).toMatchObject({
      realmId: target.realmId,
      spaceId: target.realm.spaceId,
      contextId: target.realm.contextId,
      name: 'Native Realm home',
      description: '',
      avatar: { state: 'none', value: null },
      banner: { state: 'none', value: null },
      members: { state: 'current', count: 0, version: '0' },
      rules: {
        state: 'available',
        value: { ...target.pin, licence: target.post.licence, sha256: target.post.sha256 },
      },
      join: { membership: 'unknown', action: 'sign-in' },
    });
    expect(serializeDocument(community.rules.value.body)).toBe(serializeDocument(target.post.body));
    const space = await world.call('GET', `/v1/spaces/${target.realm.spaceId}`);
    const board = await world.call('GET', `/v1/boards/${target.boardId}`);
    expect(space.response.status, space.text).toBe(200);
    expect(board.response.status, board.text).toBe(200);
    expect(space.value!.community).toEqual(community);
    expect(board.value!.board.community).toEqual(community);
  },
  120_000,
);

test.serial(
  'home presentation obeys current rules, protected Realm and host removal disclosure',
  async () => {
    const target = await adoptedRealm('Home disclosure');
    await world.command(
      'POST',
      `/v1/posts/${target.postId}:takeDown`,
      { reason: 'Hide native rules' },
      {
        bearer: world.governance.bearer,
        expectedStatus: 200,
      },
    );
    const concealed = await world.call('GET', `/v1/realms/${target.realmId}/presentation`);
    expect(concealed.response.status, concealed.text).toBe(200);
    expect(concealed.value!.community.rules).toEqual({ state: 'none', value: null });
    expect(concealed.text).not.toContain(target.pin.revisionId);

    await patch(target.realmId, target.realm.headRevisionId, { visibility: 'protected' });
    const denied = await world.call('GET', `/v1/realms/${target.realmId}/presentation`);
    const missing = await world.call('GET', `/v1/realms/${newId(routeOf(target.realmId)!)}/presentation`);
    expect(denied.response.status, denied.text).toBe(404);
    expect(missing.response.status, missing.text).toBe(404);
    expect(denied.value!.code).toBe(missing.value!.code);
    expect(denied.text).not.toContain(target.realmId);
    const owner = await world.call('GET', `/v1/realms/${target.realmId}/presentation`, {
      bearer: world.author.bearer,
    });
    expect(owner.response.status, owner.text).toBe(200);
    expect(owner.value!.community.contextId).toBe(target.realm.contextId);

    const lifecycle = await world.call('GET', `/v1/spaces/${target.realm.spaceId}/lifecycle`, {
      bearer: world.author.bearer,
    });
    expect(lifecycle.response.status, lifecycle.text).toBe(200);
    await world.command(
      'POST',
      `/v1/spaces/${target.realm.spaceId}/removal`,
      {
        expectedVersion: lifecycle.value!.container.version,
        reason: 'Remove the native host',
      },
      {
        headers: { 'if-match': JSON.stringify(lifecycle.value!.container.headRevisionId) },
        expectedStatus: 200,
      },
    );
    const removed = await world.call('GET', `/v1/realms/${target.realmId}/presentation`, {
      bearer: world.author.bearer,
    });
    expect(removed.response.status, removed.text).toBe(404);
    expect(removed.text).not.toContain(target.realmId);
  },
  120_000,
);

test.serial(
  'home composition preserves native unavailable states and withholds changed final sources',
  async () => {
    const target = await adoptedRealm('Home source transitions');
    const native = world.system.access;
    await expect(
      read(target.realmId, {
        ...native,
        async prepareReadDecisions() {
          throw new Error('Required native Realm source unavailable');
        },
      }),
    ).rejects.toMatchObject({ code: 'dependency_unavailable' });

    const unavailable = await read(
      target.realmId,
      atRulesBoundary(async () => {
        throw new Error('Optional native rules source unavailable');
      }),
    );
    expect(unavailable?.rules).toEqual({ state: 'unavailable', value: null });
    expect((await read(target.realmId))?.rules.state).toBe('available');

    const changed = await read(
      target.realmId,
      atRulesBoundary(async () => {
        // Exercise the actual producer trigger, without a replacement count source.
        await openMembership.run(world.system.database.pool, {
          route: routeOf(target.realmId)!,
          realm_id: target.realmId,
          account_id: world.other.accountId,
          reservation_id: newId(routeOf(world.other.accountId)!),
          transaction_id: newId(routeOf(target.realmId)!),
          at: new Date().toISOString(),
        });
      }),
    );
    expect(changed?.members).toEqual({ state: 'unknown', count: null, version: null });
    expect((await read(target.realmId))?.members).toEqual({ state: 'current', count: 1, version: '1' });

    const lost = await read(
      target.realmId,
      atRulesBoundary(async () => {
        await patch(target.realmId, target.realm.headRevisionId, { visibility: 'protected' });
      }),
    );
    expect(lost).toBeNull();
  },
  120_000,
);
