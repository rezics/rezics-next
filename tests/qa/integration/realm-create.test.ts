import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { realmVisibilityFixture } from '../../../services/main/tests/realm-visibility-fixture.ts';

async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Community creation reserves one handle and filters the directory by global Concept', async () => {
  const stack = await startMediaStack('realm-create');
  try {
    const creator = await stack.member('realm-creator');
    await creator.grant('space:create:root', 'space.create');
    const topic = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(topic)} a skos:Concept ;
        skos:prefLabel "Fantasy"@en ; skos:prefLabel "奇幻"@zh-CN . } }`);
    const command = { profile: 'space-realm-v2', name: 'Fantasy Readers', handle: 'fantasy-readers',
      topics: [topic], capabilities: ['realm'], actingSubject: creator.actor };
    expect((await creator.send('POST', '/v1/spaces', { ...command, profile: 'space-realm-v1' })).status)
      .toBe(400);
    const created = await json<{ realm: string; realmRevision: string; owner: string }>(
      await creator.send('POST', '/v1/spaces', command), 201);
    expect(created.owner).toBe(creator.actor);
    expect((await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(created.realm)} rv:definitionProfile
        <https://rezics.com/definition/space-realm-v2> . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(created.realmRevision)}
        rv:modelRevision <https://rezics.com/definition/space-realm-v2> ;
        rv:shapeRevision <https://rezics.com/definition/space-realm-v2> . }
    }`, 1024)).boolean).toBe(true);
    expect(await json(await stack.call('GET', '/v1/realms/by-handle/fantasy-readers'), 200))
      .toEqual({ realm: created.realm, handle: command.handle });
    const selected = await json<{ topic: { id: string; label: { value: string } };
      items: Array<{ id: string; handle: string | null }> }>(
      await stack.call('GET', `/v1/realms?topic=${encodeURIComponent(topic)}&language=zh-CN`), 200);
    expect(selected.topic).toMatchObject({ id: topic, label: { value: '奇幻' } });
    expect(selected.items).toMatchObject([{ id: created.realm, handle: 'fantasy-readers' }]);
    expect((await stack.call('GET', `/v1/realms?topic=${encodeURIComponent(
      `https://rezics.com/id/${randomUUID()}`)}`)).status).toBe(400);
    expect((await creator.send('POST', '/v1/spaces', { ...command, name: 'Impersonator' })).status).toBe(400);
    expect((await stack.call('GET', '/v1/realms/by-handle/missing-handle')).status).toBe(404);
    const oldSpace = `https://rezics.com/id/${randomUUID()}`;
    const oldRealm = `https://rezics.com/id/${randomUUID()}`;
    const oldSpaceRevision = `https://rezics.com/id/${randomUUID()}`;
    const oldRealmRevision = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(oldSpace)} a rv:Space ; rv:owner ${iri(creator.actor)} ;
          rv:realmCapability ${iri(oldRealm)} ; rv:disclosure rv:Public ;
          rdfs:label "Legacy Realm"@en ; rv:head ${iri(oldSpaceRevision)} .
        ${iri(oldRealm)} a rv:Realm ; rv:space ${iri(oldSpace)} ; rv:realmState rv:Active ;
          rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ;
          rv:membershipPolicy <https://rezics.com/definition/realm-closed-v1> ;
          rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> ;
          rv:head ${iri(oldRealmRevision)} .
      } }`);
    expect(await json<{ realm: string }>(await stack.call('GET', `/v1/spaces/${oldSpace.slice(-36)}`), 200))
      .toMatchObject({ realm: oldRealm });
  } finally { await stack.stop(); }
});

test('A new owner can configure community rules and publish the public profile', async () => {
  const h = await realmVisibilityFixture();
  try {
    const imageAuthority = await h.accessPool.query(`SELECT g.action, r.action AS represented
      FROM access.permission_grant g JOIN access.representation r
        ON r.subject_id = g.recipient_subject AND r.principal_id = $2 AND r.action = g.action
      WHERE g.recipient_subject = $1 AND g.scope_id = $3 AND g.active AND r.active`,
    [h.actor, h.principalId, `media:avatar:${h.realm}`]);
    expect(imageAuthority.rows).toMatchObject([{ action: 'media.avatar', represented: 'media.avatar' }]);
    const current = await h.call('GET', `${h.root}/settings`);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    const rules = [{ id: 'rule-1', title: { en: 'Be kind', 'zh-CN': '友善交流' },
      body: { en: 'Respect other readers.', 'zh-CN': '尊重其他读者。' }, governanceRule: null }];
    const settings = await h.call('PUT', `${h.root}/settings`, { actingSubject: h.actor,
      expectedGeneration: current.body.generation, expectedRulesRevision: current.body.ruleBasis.revision,
      reason: 'Set up the community', settings: { ...current.body.settings,
        visibility: 'public', reviewRequired: false, reviewMode: 'open',
        whoMaySubmit: 'members', selfJoin: true, rules } });
    expect(settings.status, JSON.stringify(settings.body)).toBe(201);
    const publication = { name: { en: 'Reading Circle', 'zh-CN': '读书会' },
      description: { en: 'Discuss good books.', 'zh-CN': '一起讨论好书。' },
      iconSelection: null, bannerSelection: null, replyPolicy: 'members-direct', rules,
      count: { kind: 'exact', value: null }, moderators: [] };
    const profile = await h.call('PUT', `${h.root}/profile`, { profile: 'realm-public-profile-v1',
      expectedHead: null, actingSubject: h.actor, publication });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    const read = await h.call('GET', `${h.root}?language=zh-CN`, undefined, null);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ id: h.realm, name: { value: '读书会' },
      description: { value: '一起讨论好书。' }, reviewMode: 'open' });
  } finally { await h.close(); }
}, 180_000);
