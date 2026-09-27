import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, png } from './media-support.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { REALM_PROFILE_COST } from '../../../services/main/src/modules/realm-profile/schema.ts';

const short = (id: string) => id.slice(-36);
async function response<T>(result: Response, expected: number): Promise<T> {
  const body = await result.text();
  if (result.status !== expected) throw new Error(`Expected ${expected}, received ${result.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Realm public profile: manager admission, CAS, media, moderator choice and disclosure', async () => {
  const stack = await startMediaStack('realm-profile');
  try {
    const manager = await stack.member('realm-profile-manager');
    const moderator = await stack.member('realm-profile-moderator');
    const outsider = await stack.member('realm-profile-outsider');
    await manager.grant('space:create:root', 'space.create');
    const created = await response<{ realm: string }>(await manager.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Before publication', capabilities: ['realm'],
      actingSubject: manager.actor }), 201);
    const realm = created.realm;
    const root = `/v1/realms/${short(realm)}`;
    const before = await response<{ profileRevision: null; description: null; rules: null;
      membership: { count: { kind: string } }; moderators: { kind: string; items: string[] } }>(
      await stack.call('GET', root), 200);
    expect(before).toMatchObject({ profileRevision: null, description: null, rules: null,
      membership: { count: { kind: 'unknown' } }, moderators: { kind: 'unknown', items: [] } });

    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(moderator.actor)} a rv:Agent . ${iri(outsider.actor)} a rv:Agent . } }`);
    const publication = {
      name: { en: 'Readers Guild', 'zh-CN': '读者公会' },
      description: { en: 'Read together.', 'zh-CN': '一起阅读。' },
      iconSelection: null as string | null, bannerSelection: null as string | null,
      rules: [{ id: 'be-kind', title: { en: 'Be kind', 'zh-CN': '友善' },
        body: { en: 'Respect others.', 'zh-CN': '尊重他人。' }, governanceRule: null }],
      count: { kind: 'estimated' as const, value: 120 }, moderators: [moderator.actor],
    };
    const body = (actingSubject: string, expectedHead: string | null, value = publication) => ({
      profile: 'realm-public-profile-v1', expectedHead, actingSubject, publication: value,
    });
    await manager.grant(`realm:profile:${realm}`, 'realm.profile.publish');
    expect((await outsider.send('PUT', `${root}/profile`, body(outsider.actor, null))).status).toBe(403);
    expect((await manager.send('PUT', `${root}/profile`, body(manager.actor, null))).status).toBe(400);
    const afterDenied = await response<{ profileRevision: null }>(await stack.call('GET', root), 200);
    expect(afterDenied.profileRevision).toBeNull();

    await moderator.grant(`realm:moderator-choice:${short(realm)}:${short(moderator.actor)}`,
      'realm.moderator.choose');
    const choiceBody = (agent: string, expectedHead: string | null, publicValue: boolean) => ({
      profile: 'realm-public-moderator-choice-v1', expectedHead, public: publicValue,
      actingSubject: agent });
    expect((await outsider.send('PUT', `${root}/moderators/${short(moderator.actor)}/public-choice`,
      choiceBody(outsider.actor, null, true))).status).toBe(400);
    const choice = await response<{ revision: string;
      sourcePosition: { dataEpoch: string; sequence: string } }>(await moderator.send('PUT',
      `${root}/moderators/${short(moderator.actor)}/public-choice`,
      choiceBody(moderator.actor, null, true)), 201);
    const choiceBatch = await readNextMainOutboxBatch(stack.fuseki, choice.sourcePosition.dataEpoch,
      (BigInt(choice.sourcePosition.sequence) - 1n).toString());
    expect((await readMainOutboxEnvelope(stack.fuseki, choiceBatch!, choiceBatch!.eventIds[0]!)))
      .toMatchObject({ type: 'com.rezics.realm.public-moderator-choice.v1',
        data: { receipt: { action: 'realm.moderator.choose', realm, revision: choice.revision } } });

    // Both selections are made through the existing Media API; the Realm context
    // distinguishes the banner from the default icon selection.
    await manager.grant(`media:avatar:${realm}`, 'media.avatar');
    const asset = await manager.upload(png(16, 16));
    const select = async (context?: string) => response<{ selection: string }>(await manager.send('PUT',
      `/v1/resources/${short(realm)}/avatar`, { profile: 'resource-avatar-selection-v1',
        ...(context ? { context } : {}), expectedSelection: null,
        asset: asset.asset, actingSubject: manager.actor }), 201);
    publication.iconSelection = (await select()).selection;
    publication.bannerSelection = (await select(realm)).selection;
    const beforePublishCalls = stack.fuseki.queries;
    const published = await response<{ revision: string; receipt: string; replayed: boolean;
      sourcePosition: { dataEpoch: string; sequence: string } }>(
      await manager.send('PUT', `${root}/profile`, body(manager.actor, null), 'profile-first'), 201);
    expect(published.replayed).toBe(false);
    expect(stack.fuseki.queries - beforePublishCalls).toBeLessThanOrEqual(REALM_PROFILE_COST.graphCalls);
    const profileBatch = await readNextMainOutboxBatch(stack.fuseki, published.sourcePosition.dataEpoch,
      (BigInt(published.sourcePosition.sequence) - 1n).toString());
    expect((await readMainOutboxEnvelope(stack.fuseki, profileBatch!, profileBatch!.eventIds[0]!)))
      .toMatchObject({ type: 'com.rezics.realm.profile-published.v1',
        data: { receipt: { action: 'realm.profile.publish', realm, revision: published.revision } } });
    expect((await response<{ revision: string; replayed: boolean }>(await manager.send('PUT',
      `${root}/profile`, body(manager.actor, null), 'profile-first'), 200)))
      .toMatchObject({ revision: published.revision, replayed: true });

    const beforeHomeCalls = stack.fuseki.queries;
    const home = await response<{ profileRevision: string; name: { value: string };
      description: { value: string }; banner: { kind: string; url: string };
      icon: { kind: string }; rules: Array<{ id: string; title: { value: string } }>;
      membership: { count: { kind: string; value: number }; publicMembers: null };
      moderators: { kind: string; items: string[] } }>(await stack.call('GET', `${root}?language=zh-CN`), 200);
    expect(stack.fuseki.queries - beforeHomeCalls).toBeLessThanOrEqual(REALM_PROFILE_COST.homeGraphCalls);
    expect(home).toMatchObject({ profileRevision: published.revision, name: { value: '读者公会' },
      description: { value: '一起阅读。' }, icon: { kind: 'image' },
      banner: { kind: 'image' }, rules: [{ id: 'be-kind', title: { value: '友善' } }],
      membership: { count: { kind: 'estimated', value: 120 }, publicMembers: null },
      moderators: { kind: 'known', items: [moderator.actor] } });
    expect((await stack.call('GET', home.banner.url)).status).toBe(200);
    expect((await manager.send('PUT', `${root}/profile`, body(manager.actor, null))).status).toBe(409);

    // Competing manager commands against one head admit only one successor.
    const successors = await Promise.all([0, 1].map(index => manager.send('PUT', `${root}/profile`,
      body(manager.actor, published.revision, { ...publication,
        description: { ...publication.description, en: `Revision ${index}` } }),
      `profile-race-${randomUUID()}`)));
    expect(successors.map(result => result.status).sort()).toEqual([201, 409]);
    const revoked = await response<{ revision: string }>(await moderator.send('PUT',
      `${root}/moderators/${short(moderator.actor)}/public-choice`,
      choiceBody(moderator.actor, choice.revision, false)), 201);
    expect(revoked.revision).not.toBe(choice.revision);
    const after = await response<{ moderators: { kind: string; items: string[] } }>(
      await stack.call('GET', root), 200);
    expect(after.moderators).toEqual({ kind: 'known', items: [] });
    expect(JSON.stringify(after)).not.toContain(outsider.actor);
  } finally { await stack.stop(); }
}, 120_000);
