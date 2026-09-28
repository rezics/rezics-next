import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { RealmDirectoryIndex } from '../../../services/main/src/modules/realm-directory/index.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

interface DirectoryItem { id: string; reviewMode: 'mandatory' | 'trusted-members' | 'open'; name: { value: string; language: string };
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
    const scheme = `https://rezics.com/id/${randomUUID()}`;
    const topic = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(scheme)} a skos:ConceptScheme, rv:VocabularyDefinition ; rv:schemeState rv:Active .
        ${iri(topic)} a skos:Concept ; skos:inScheme ${iri(scheme)} ; rv:conceptState rv:Active ;
          skos:prefLabel "Mystery"@en, "悬疑"@zh-Hans .
      } }`);
    const vocabulary = await json<{ items: { id: string; label: string }[] }>(
      await stack.call('GET', '/v1/classification-vocabulary?language=zh-CN&q=Mystery'));
    expect(vocabulary.items).toContainEqual({ id: topic, label: '悬疑' });
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
    const secondProfile = await publish(second.realm, 'Book Circle', '图书圈', 50);
    const get = (path: string) => stack.call('GET', path);
    const beforeCalls = stack.fuseki.queries;
    const activity = await json<DirectoryPage>(await get('/v1/realms?limit=1'));
    expect(stack.fuseki.queries - beforeCalls).toBeLessThanOrEqual(14);
    expect(activity.items.map(item => item.id)).toEqual([second.realm]);
    expect(activity.items[0]?.reviewMode).toBe('mandatory');
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(second.realm)} rv:reviewMode ?mode } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(second.realm)} rv:reviewMode "open" } } WHERE { OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
      ${iri(second.realm)} rv:reviewMode ?mode } } }`);
    expect((await json<DirectoryPage>(await get('/v1/realms?limit=1'))).items[0]?.reviewMode).toBe('open');
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
    await stack.access.realmDirectory.invalidate(); // Fixture bypasses the erasure command.
    expect((await json<DirectoryPage>(await get('/v1/realms?limit=1'))).items.map(item => item.id))
      .toEqual([second.realm]);

    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.space)} rv:disclosure rv:Public } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.space)} rv:disclosure rv:Private } } WHERE {}`);
    await stack.access.realmDirectory.invalidate(); // Fixture bypasses receipted commands.
    const privateExcluded = await json<DirectoryPage>(await get('/v1/realms?q=Guild'));
    expect(privateExcluded.items).toEqual([]);
    expect((await stack.call('GET', '/v1/realms?q=Guild', { token: editor.token })).status).toBe(200);
    const anonymous = await json<DirectoryPage>(await get('/v1/realms'));
    expect(anonymous.items.map(item => item.id)).not.toContain(first.realm);
    // Exact means joined membership identities, including private participation;
    // the public API never receives either private principal or membership IDs.
    await stack.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution') ON CONFLICT DO NOTHING", [second.realm]);
    await stack.accessPool.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision) VALUES ('realm',$1,1,'terms-1')`, [second.realm]);
    const beforeGrowth = await json<DirectoryPage>(await get('/v1/realms?sort=growing&limit=1'));
    expect(beforeGrowth.nextCursor).toBeString();
    const privateMembership = randomUUID();
    const consent = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.private_membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, policy_revision, terms_revision, next_generation, expires_at)
      SELECT $1, id, enforcement_epoch, 'realm', $3, 1, 'terms-1', 1, now()+interval '5 minutes'
      FROM access.principal WHERE id=$2`, [consent, editor.principalId, second.realm]);
    await stack.accessPool.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation, policy_revision, terms_revision, consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'terms-1',$4)`,
    [privateMembership, second.realm, editor.principalId, consent]);
    expect((await get(`/v1/realms?sort=growing&limit=1&cursor=${beforeGrowth.nextCursor}`)).status)
      .toBe(409);
    const publicMembership = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.membership
      (id, kind, owner_subject, member_subject, state, generation, policy_revision, terms_revision, consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'terms-1','fixture')`, [publicMembership, second.realm, editor.actor]);
    const growingMembers = await json<DirectoryPage>(await get('/v1/realms?sort=growing&limit=1'));
    expect(growingMembers.items[0]?.id).toBe(second.realm);
    for (let index = 0; index < 3; index++) {
      const placement = `https://rezics.com/id/${randomUUID()}`;
      await stack.accessPool.query(`INSERT INTO access.feed_item
        (data_epoch,id,sequence,kind,occurred_at,time_basis,best_key,realm,group_bucket,
          group_key,group_leader,group_members,sort_time)
        VALUES ($1,$2,$3,'discussion',now(),'relay',0,$4,'fixture',$2,true,ARRAY[$2],now())`,
      [stack.env.lineage.dataEpoch, placement, index + 1, third.realm]);
    }
    expect((await json<DirectoryPage>(await get('/v1/realms?sort=growing&limit=1'))).items[0]?.id)
      .toBe(third.realm);
    expect((await get(`/v1/realms?sort=growing&limit=1&cursor=${growingMembers.nextCursor}`)).status)
      .toBe(409);
    const exactBody = { profile: 'realm-public-profile-v1', expectedHead: secondProfile.revision,
      actingSubject: editor.actor, publication: { name: { en: 'Book Circle', 'zh-CN': '图书圈' },
        description: { en: 'Together', 'zh-CN': '一起阅读' }, iconSelection: null, bannerSelection: null,
        rules: [], moderators: [], count: { kind: 'exact', value: null } } };
    expect((await editor.send('PUT', `/v1/realms/${second.realm.slice(-36)}/profile`, {
      ...exactBody, publication: { ...exactBody.publication, count: { kind: 'exact', value: 999 } } })).status).toBe(400);
    const exactProfile = await json<{ revision: string }>(await editor.send('PUT',
      `/v1/realms/${second.realm.slice(-36)}/profile`, exactBody), 201);
    const exactPage = await json<DirectoryPage>(await get('/v1/realms?sort=members&limit=1'));
    expect(exactPage.items).toMatchObject([{ id: second.realm, membership: { count: { kind: 'exact', value: 2 } } }]);
    const header = await json<{ membership: { count: { kind: string; value: number; revision: string } } }>(
      await get(`/v1/realms/${second.realm.slice(-36)}`));
    expect(header.membership.count).toMatchObject({ kind: 'exact', value: 2 });
    expect(JSON.stringify(header)).not.toContain(privateMembership);
    expect(JSON.stringify(header)).not.toContain(editor.principalId);
    const recoveryFence = await engageAccessRecoveryFence(stack.accessPool);
    expect((await get(`/v1/realms/${second.realm.slice(-36)}`)).status).toBe(503);
    expect((await get('/v1/realms')).status).toBe(503);
    await releaseAccessRecoveryFence(stack.accessPool, recoveryFence);
    await stack.accessPool.query(`UPDATE access.private_membership SET state='left', generation=2,
      terms_revision=NULL, consent_reference=NULL WHERE id=$1`, [privateMembership]);
    expect((await get(`/v1/realms?sort=members&limit=1&cursor=${exactPage.nextCursor}`)).status).toBe(409);
    expect((await json<DirectoryPage>(await get('/v1/realms?sort=members&limit=1'))).items[0]?.membership.count)
      .toMatchObject({ kind: 'exact', value: 1 });
    await json(await editor.send('PUT', `/v1/realms/${second.realm.slice(-36)}/profile`, {
      ...exactBody, expectedHead: exactProfile.revision,
      publication: { ...exactBody.publication, count: { kind: 'unknown', value: null } } }), 201);
    expect((await json<DirectoryPage>(await get('/v1/realms?q=Circle'))).items[0]?.membership.count)
      .toEqual({ kind: 'unknown', value: null });

    // Populate a small multi-scale directory directly; invalidate because this
    // fixture deliberately bypasses graph receipts. Product writes use refresh.
    for (const size of [129, 513]) {
      const ids = Array.from({ length: size === 129 ? 129 : 384 }, () => ({ realm: `https://rezics.com/id/${randomUUID()}`,
        space: `https://rezics.com/id/${randomUUID()}`, head: `https://rezics.com/id/${randomUUID()}` }));
      await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
          ${ids.map(row => `${iri(row.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ${iri(row.space)} ;
            rv:head ${iri(row.head)} ; rdfs:label "Scale directory"@en .
            ${iri(row.space)} rdfs:label "Scale directory"@en ; a rv:Space ; rv:realmCapability ${iri(row.realm)} ; rv:disclosure rv:Public .`).join('\n')}
        } GRAPH ${iri(GRAPHS.revisions)} {
          ${ids.map(row => `${iri(row.head)} a rv:RevisionAnchor ; rv:component ${iri(row.realm)} ;
            rv:dataEpoch "${stack.env.lineage.dataEpoch}" ; rv:sequence 1 .`).join('\n')}
        } }`);
      await stack.access.realmDirectory.invalidate();
      // Cold refresh checkpoints bounded batches and resumes on the next request.
      for (let retry = 0; retry < 128; retry++) {
        const warm = await get('/v1/realms?sort=newest&q=Scale&limit=20');
        if (warm.status === 200) break;
        expect(warm.status, await warm.clone().text()).toBe(503);
        expect(retry).toBeLessThan(127);
        Object.assign(stack.access, { realmDirectory: new RealmDirectoryIndex(stack.accessPool) });
      }
      let next: string | null = null;
      const seen = new Set<string>();
      do {
        const page: DirectoryPage = await json<DirectoryPage>(await get(`/v1/realms?sort=newest&q=Scale&limit=20${next ? `&cursor=${next}` : ''}`));
        for (const item of page.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
        next = page.nextCursor;
      } while (next);
      expect(seen.size).toBe(size);
      const planner = await stack.accessPool.connect();
      try {
        await planner.query('BEGIN');
        await planner.query('SET LOCAL enable_seqscan = off');
        for (const [column, index] of [['created', 'created'], ['activity', 'activity'], ['count_value', 'members']]) {
          const plan = await planner.query(`EXPLAIN (ANALYZE, FORMAT JSON)
            SELECT realm FROM access.realm_directory ORDER BY -${column}, realm LIMIT 21`);
          expect(JSON.stringify(plan.rows)).toContain(`realm_directory_${index}`);
          expect(plan.rows[0]['QUERY PLAN'][0].Plan['Actual Rows']).toBe(21);
        }
        await planner.query('ROLLBACK');
      } finally { planner.release(); }
    }
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect((await get('/v1/realms')).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
  } finally { await stack.stop(); }
}, 120_000);
