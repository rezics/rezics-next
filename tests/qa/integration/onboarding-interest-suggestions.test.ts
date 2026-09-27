import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { selectRealmLocal, realmSelectionDigest } from '../../../services/main/src/modules/work/select-realm.ts';
import { startMediaStack } from './media-support.ts';

test('G-329: matching official Zone appears and empty Realms are absent', async () => {
  const stack = await startMediaStack('onboarding-interest-suggestions');
  try {
    const author = await stack.member('author');
    await author.grant('space:create:root', 'space.create');
    stack.access.configureBaseline(stack.fuseki);
    const createRealm = async (name: string) => {
      const response = await stack.call('POST', '/v1/spaces', { token: author.token, key: randomUUID(),
        body: { profile: 'space-realm-v1', name, capabilities: ['realm'], actingSubject: author.actor } });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ realm: string; space: string }>;
    };
    const empty = await createRealm('Classic Literature');
    const fiction = await createRealm('Fiction · 小说');
    const novel = await stack.publicWork(author.actor, ['zh-Hans'], '网络小说');
    const selection = { context: { kind: 'realm-local' as const, id: fiction.realm },
      work: novel.work, mainVersion: novel.mainVersion,
      contribution: novel.variants[0]!.contribution,
      publicationDecision: novel.variants[0]!.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const,
      actingSubject: author.actor };
    expect((await selectRealmLocal(stack.env, stack.admission(author.actor,
      `publication:adopt:${fiction.realm}`, 'publication.adopt', realmSelectionDigest(selection)),
    selection)).outcome).toBe('succeeded');
    const zone = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(novel.work)} a schema:Book .
        ${iri(zone)} a rv:Zone ; rv:official true ; rv:zoneState rv:Active ;
          rv:disclosure rv:Public ; rv:defaultRealm ${iri(fiction.realm)} ; rv:routeSegment "fiction" .
      } }`);
    const response = await stack.call('GET', '/v1/onboarding/suggested-follows?interests=books&languages=zh-Hans');
    const body = await response.json() as { items?: { id: string; realm: string;
      sampleWorks: { id: string }[]; reason: { kind: string; interest: string | null } }[] };
    expect(response.status).toBe(200);
    expect(body.items).toContainEqual(expect.objectContaining({ id: zone, realm: fiction.realm,
      reason: { kind: 'matching-kind', interest: 'books' },
      sampleWorks: [expect.objectContaining({ id: novel.work })] }));
    expect(body.items?.some(item => item.realm === empty.realm)).toBe(false);
  } finally { await stack.stop(); }
});
