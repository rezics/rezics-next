import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

interface DirectoryItem { id: string; name: { value: string; language: string };
  description: { value: string } | null; membership: { count: { kind: string; value: number | null } };
  icon: { kind: string }; links: { realm: string } }
interface DirectoryPage { items: DirectoryItem[]; nextCursor: string | null;
  count: { value: number; kind: 'exact-page'; total: null } }
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Realm directory: public profiles, activity/member/newest pages, CJK search and disclosure', async () => {
  const stack = await startMediaStack('realm-directory');
  try {
    const editor = await stack.member('directory-editor');
    await editor.grant('space:create:root', 'space.create');
    const create = async (name: string) => json<{ realm: string; space: string }>(await editor.send('POST',
      '/v1/spaces', { profile: 'space-realm-v1', name, capabilities: ['realm'],
        actingSubject: editor.actor }), 201);
    const first = await create('First space');
    const second = await create('Second space');
    const third = await create('Unpublished space');
    const publish = async (realm: string, en: string, zh: string, count: number) => {
      await editor.grant(`realm:profile:${realm}`, 'realm.profile.publish');
      return json<{ revision: string }>(await editor.send('PUT',
        `/v1/realms/${realm.slice(-36)}/profile`, {
          profile: 'realm-public-profile-v1', expectedHead: null, actingSubject: editor.actor,
          publication: { name: { en, 'zh-CN': zh },
            description: { en: `Reading in ${en}`, 'zh-CN': `一起阅读${zh}` },
            iconSelection: null, bannerSelection: null, rules: [],
            count: { kind: 'estimated', value: count }, moderators: [] },
        }), 201);
    };
    await publish(first.realm, 'Readers Guild', '读者公会', 120);
    await publish(second.realm, 'Book Circle', '图书圈', 50);
    const get = (path: string) => stack.call('GET', path);
    const beforeCalls = stack.fuseki.queries;
    const activity = await json<DirectoryPage>(await get('/v1/realms?limit=1'));
    expect(stack.fuseki.queries - beforeCalls).toBeLessThanOrEqual(12);
    expect(activity.items.map(item => item.id)).toEqual([second.realm]);
    expect(activity.nextCursor).toBeString();
    expect(activity.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    const activityMore = await json<DirectoryPage>(await get(`/v1/realms?limit=1&cursor=${activity.nextCursor}`));
    expect(activityMore.items.map(item => item.id)).toEqual([first.realm]);
    const members = await json<DirectoryPage>(await get('/v1/realms?sort=members'));
    expect(members.items.map(item => item.id)).toEqual([first.realm, second.realm, third.realm]);
    expect(members.items.map(item => item.membership.count)).toEqual([
      { kind: 'estimated', value: 120 }, { kind: 'estimated', value: 50 },
      { kind: 'unknown', value: null }]);
    expect((await json<DirectoryPage>(await get('/v1/realms?sort=newest'))).items.map(item => item.id))
      .toEqual([third.realm, second.realm, first.realm]);
    const chinese = await json<DirectoryPage>(await get(`/v1/realms?q=${encodeURIComponent('阅读读者')}&language=zh-CN`));
    expect(chinese.items).toMatchObject([{ id: first.realm, name: { value: '读者公会', language: 'zh-cn' },
      description: { value: '一起阅读读者公会' }, icon: { kind: 'fallback' } }]);
    expect((await json<DirectoryPage>(await get('/v1/realms?q=ｇｕｉｌｄ'))).items.map(item => item.id))
      .toEqual([first.realm]);
    expect((await json<DirectoryPage>(await get('/v1/realms?q=Unpublished'))).items.map(item => item.id))
      .toEqual([third.realm]);
    expect((await get(`/v1/realms?sort=newest&cursor=${activity.nextCursor}`)).status).toBe(400);
    expect((await get('/v1/realms?limit=21')).status).toBe(400);
    expect((await get('/v1/realms?cursor=broken')).status).toBe(400);
    expect((await get('/v1/realms?q=%20%20')).status).toBe(400);
    const work = await stack.publicWork(editor.actor, ['en'], 'A public Realm activity');
    await editor.grant(`publication:adopt:${first.realm}`, 'publication.adopt');
    await json(await editor.send('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: first.realm },
      work: work.work, mainVersion: work.mainVersion,
      contribution: work.variants[0]!.contribution,
      publicationDecision: work.variants[0]!.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
      actingSubject: editor.actor }), 201);
    expect((await json<DirectoryPage>(await get('/v1/realms?limit=1'))).items.map(item => item.id))
      .toEqual([first.realm]);
    expect((await get(`/v1/realms?limit=1&cursor=${activity.nextCursor}`)).status).toBe(409);
    const erasedPin = `urn:rezics:content-publication:${'c'.repeat(64)}`;
    const erasedRevision = `urn:rezics:content:revision:${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { <urn:rezics:variant:${randomUUID()}> rv:resource ${iri(work.work)} ;
        rv:contentPublicationHead ${iri(erasedPin)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(erasedPin)} rv:contentRevision ${iri(erasedRevision)} .
        ${iri(erasedRevision)} a rv:ErasedRevision } }`);
    expect((await json<DirectoryPage>(await get('/v1/realms?limit=1'))).items.map(item => item.id))
      .toEqual([second.realm]);

    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.space)} rv:disclosure rv:Public } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.space)} rv:disclosure rv:Private } } WHERE {}`);
    const privateExcluded = await json<DirectoryPage>(await get('/v1/realms?q=Guild'));
    expect(privateExcluded.items).toEqual([]);
    expect((await stack.call('GET', '/v1/realms?q=Guild', { token: editor.token })).status).toBe(200);
    const anonymous = await json<DirectoryPage>(await get('/v1/realms'));
    expect(anonymous.items.map(item => item.id)).not.toContain(first.realm);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect((await get('/v1/realms')).status).toBe(503);
  } finally { await stack.stop(); }
}, 120_000);
