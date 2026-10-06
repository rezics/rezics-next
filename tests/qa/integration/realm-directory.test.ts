// sql-relations-allow: access.realm_directory_probe -- The test creates this trigger probe to count directory row mutations and drops it afterwards.
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { RealmDirectoryIndex } from '../../../services/main/src/modules/realm-directory/index.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startMediaStack } from './media-support.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';
import { measureGraphReads } from './support/graph-reads.ts';

interface DirectoryItem { id: string; reviewMode: 'mandatory' | 'trusted-members' | 'open'; name: { value: string; language: string };
  description: { value: string } | null; membership: { count: { kind: string; value: number | null } };
  icon: { kind: string }; links: { realm: string } }
interface DirectoryPage { items: DirectoryItem[]; nextCursor: string | null;
  sourcePosition: { dataEpoch: string; sequence: string };
  count: { value: number; kind: 'exact-page'; total: null } }
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function checkpoint(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Background directory checkpoint did not arrive')), 15_000);
  })]); }
  finally { clearTimeout(timer); }
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
          profile: 'realm-public-profile-v2', expectedHead: null, actingSubject: editor.actor,
          publication: { name: { original: 'en', labels: { en, 'zh-Hans': zh } },
            description: { original: 'en', labels: { en: `Reading in ${en}`, 'zh-Hans': `一起阅读${zh}` } },
            iconSelection: null, bannerSelection: null, rules: [],
            count: { kind: 'estimated', value: count }, moderators: [] },
        }), 201);
    };
    await publish(first.realm, 'Readers Guild', '读者公会', 120);
    const secondProfile = await publish(second.realm, 'Book Circle', '图书圈', 50);
    const get = (path: string) => stack.call('GET', path);
    const refresh = () => waitForRealmDirectory(stack.env, () => get('/v1/realms'));
    await refresh();
    const activityRead = await measureGraphReads(() => get('/v1/realms?limit=1'));
    const activity = await json<DirectoryPage>(activityRead.value);
    // One additional batch joins Realm identities to Space canonical addresses.
    expect(activityRead.calls).toBeLessThanOrEqual(16);
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
    expect(chinese.items).toMatchObject([{ id: first.realm, name: { value: '读者公会', language: 'zh-Hans' },
      description: { value: '一起阅读读者公会' }, icon: { kind: 'fallback' } }]);
    const preference = await json<DirectoryPage>(await stack.main.handle(new Request(
      'http://main.local/v1/realms?q=Book', { headers: { 'x-rezics-display-languages': 'zh-Hant,zh-Hans,en' } })));
    expect(preference.items[0]?.name).toMatchObject({ value: '图书圈', language: 'zh-Hans' });
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
    await refresh();
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
    await refresh();
    expect((await json<DirectoryPage>(await get('/v1/realms?limit=1'))).items.map(item => item.id))
      .toEqual([second.realm]);

    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.space)} rv:disclosure rv:Public } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.space)} rv:disclosure rv:Private } } WHERE {}`);
    await stack.access.realmDirectory.invalidate(); // Fixture bypasses receipted commands.
    await refresh();
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
    const exactBody = { profile: 'realm-public-profile-v2', expectedHead: secondProfile.revision,
      actingSubject: editor.actor, publication: { name: { original: 'en', labels: { en: 'Book Circle', 'zh-Hans': '图书圈' } },
        description: { original: 'en', labels: { en: 'Together', 'zh-Hans': '一起阅读' } }, iconSelection: null, bannerSelection: null,
        rules: [], moderators: [], count: { kind: 'exact', value: null } } };
    expect((await editor.send('PUT', `/v1/realms/${second.realm.slice(-36)}/profile`, {
      ...exactBody, publication: { ...exactBody.publication, count: { kind: 'exact', value: 999 } } })).status).toBe(400);
    const exactProfile = await json<{ revision: string }>(await editor.send('PUT',
      `/v1/realms/${second.realm.slice(-36)}/profile`, exactBody), 201);
    await refresh();
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
    let secondHead = (await json<{ revision: string }>(await editor.send('PUT', `/v1/realms/${second.realm.slice(-36)}/profile`, {
      ...exactBody, expectedHead: exactProfile.revision,
      publication: { ...exactBody.publication, count: { kind: 'unknown', value: null } } }), 201)).revision;
    await refresh();
    expect((await json<DirectoryPage>(await get('/v1/realms?q=Circle'))).items[0]?.membership.count)
      .toEqual({ kind: 'unknown', value: null });

    const settled = async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const row = (await stack.accessPool.query<{ phase: string; spare_sequence: string | null }>(
          'SELECT phase,spare_sequence::text FROM access.realm_directory_position WHERE singleton')).rows[0]!;
        if (row.phase === 'idle' && row.spare_sequence !== null) return;
        await delay(50);
      }
      throw new Error('Realm directory did not finish synchronizing its spare generation');
    };
    // Count actual row mutations, including all background worker ticks. This
    // catches a bounded-per-tick implementation that still copies the inventory.
    await stack.accessPool.query(`CREATE TABLE access.realm_directory_probe (realm text,operation text);
      CREATE FUNCTION access.probe_realm_directory() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO access.realm_directory_probe VALUES (COALESCE(NEW.realm,OLD.realm),TG_OP);
        RETURN NULL;
      END $$;
      CREATE TRIGGER realm_directory_probe AFTER INSERT OR UPDATE OR DELETE ON access.realm_directory
        FOR EACH ROW EXECUTE FUNCTION access.probe_realm_directory()`);
    await editor.grant(`realm:profile:${third.realm}`, 'realm.profile.publish');
    let thirdHead: string | null = null;

    // Populate a small multi-scale directory directly; invalidate because this
    // fixture deliberately bypasses graph receipts. Product writes use refresh.
    for (const size of [129, 513]) {
      const published = await json<DirectoryPage>(await get('/v1/realms?sort=newest&q=Scale&limit=20'));
      const ids = Array.from({ length: size === 129 ? 129 : 384 }, () => ({ realm: `https://rezics.com/id/${randomUUID()}`,
        space: `https://rezics.com/id/${randomUUID()}`, head: `https://rezics.com/id/${randomUUID()}` }));
      await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
          ${ids.map(row => `${iri(row.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ${iri(row.space)} ;
            rv:head ${iri(row.head)} ; rdfs:label "Scale directory"@en .
            ${iri(row.space)} rdfs:label "Scale directory ${size}"@en ; a rv:Space ; rv:realmCapability ${iri(row.realm)} ; rv:disclosure rv:Public .`).join('\n')}
        } GRAPH ${iri(GRAPHS.revisions)} {
          ${ids.map(row => `${iri(row.head)} a rv:RevisionAnchor ; rv:component ${iri(row.realm)} ;
            rv:dataEpoch "${stack.env.lineage.dataEpoch}" ; rv:sequence 1 .`).join('\n')}
        } }`);
      // Force a rebuild without revoking the safe, completed fixture snapshot.
      // Product erasure receipts choose this same background rebuild path.
      const firstPrepared = barrier(), secondPrepared = barrier(), firstRelease = barrier(), secondRelease = barrier();
      const query = stack.fuseki.query.bind(stack.fuseki);
      let fences = 0;
      stack.fuseki.query = async (...args) => {
        if (args[0].includes('SELECT ?sequence WHERE') && args[0].includes('FILTER NOT EXISTS')) {
          fences++;
          if (fences === 1) { firstPrepared.release(); await firstRelease.promise; }
          if (fences === 2) { secondPrepared.release(); await secondRelease.promise; }
        }
        return query(...args);
      };
      try {
        await stack.accessPool.query(`UPDATE access.realm_directory_position
          SET build_data_epoch = NULL,revision = revision + 1 WHERE singleton`);
        await checkpoint(firstPrepared.promise);
        const retained = await json<DirectoryPage>(await get('/v1/realms?sort=newest&q=Scale&limit=20'));
        expect(retained.sourcePosition).toEqual(published.sourcePosition);
        expect(retained.items.map(item => item.id)).toEqual(published.items.map(item => item.id));
        firstRelease.release();
        await checkpoint(secondPrepared.promise);
        expect((await stack.accessPool.query(`SELECT count(*)::int AS n FROM access.realm_directory
          WHERE generation <> (SELECT generation FROM access.realm_directory_position WHERE singleton)`)).rows[0].n).toBe(64);
        // A newly composed reader sees the completed generation while a
        // committed partial successor survives in owner storage.
        const resumed = new RealmDirectoryIndex(stack.accessPool);
        const session = new WorkReadSession({ environment: stack.env, access: stack.access, account: {} as never },
          new Request('http://main.local/v1/realms'), {}, published.sourcePosition);
        expect((await resumed.page(session, { sort: 'newest', q: 'scale', limit: 20 })).rows.map(row => row.realm))
          .toEqual(published.items.map(item => item.id));
      } finally {
        firstRelease.release(); secondRelease.release(); stack.fuseki.query = query;
      }
      await waitForRealmDirectory(stack.env, () => get(`/v1/realms?sort=newest&q=Scale%20directory%20${size}&limit=20`),
        page => page.items.length === 20);
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
        await planner.query('ANALYZE access.realm_directory');
        await planner.query('BEGIN');
        await planner.query('SET LOCAL enable_seqscan = off');
        for (const [column, index] of [['created', 'created'], ['activity', 'activity'], ['count_value', 'members']]) {
          const plan = await planner.query(`EXPLAIN (ANALYZE, FORMAT JSON)
            SELECT realm FROM access.realm_directory
            WHERE generation = $1::smallint ORDER BY -${column}, realm LIMIT 21`,
          [(await planner.query('SELECT generation FROM access.realm_directory_position WHERE singleton')).rows[0].generation]);
          expect(JSON.stringify(plan.rows)).toContain(`realm_directory_${index}`);
          expect(plan.rows[0]['QUERY PLAN'][0].Plan['Actual Rows']).toBe(21);
        }
        await planner.query('ROLLBACK');
      } finally { planner.release(); }
      await settled();
      expect((await stack.accessPool.query(`SELECT count(*)::int AS n FROM (
        (SELECT realm,space,profile,activity,count_value FROM access.realm_directory WHERE generation = 0
          EXCEPT SELECT realm,space,profile,activity,count_value FROM access.realm_directory WHERE generation = 1)
        UNION ALL
        (SELECT realm,space,profile,activity,count_value FROM access.realm_directory WHERE generation = 1
          EXCEPT SELECT realm,space,profile,activity,count_value FROM access.realm_directory WHERE generation = 0)
      ) difference`)).rows[0].n).toBe(0);
      await stack.accessPool.query('TRUNCATE access.realm_directory_probe');
      secondHead = (await json<{ revision: string }>(await editor.send('PUT',
        `/v1/realms/${second.realm.slice(-36)}/profile`, { ...exactBody, expectedHead: secondHead,
          publication: { ...exactBody.publication,
            name: { original: 'en', labels: { en: `Book Circle ${size}`, 'zh-Hans': '图书圈' } } } }), 201)).revision;
      await refresh();
      await settled();
      const singleChange = (await stack.accessPool.query<{ realm: string }>(
        'SELECT realm FROM access.realm_directory_probe')).rows;
      expect(singleChange).toHaveLength(4); // One copy and one hydration, regardless of inventory size.
      expect(new Set(singleChange.map(row => row.realm))).toEqual(new Set([second.realm]));

      // The next slot is missing the previous cycle's change as well as this
      // cycle's. Carry it forward even when the two changed sets are disjoint.
      await stack.accessPool.query('TRUNCATE access.realm_directory_probe');
      thirdHead = (await json<{ revision: string }>(await editor.send('PUT',
        `/v1/realms/${third.realm.slice(-36)}/profile`, { ...exactBody, expectedHead: thirdHead,
          publication: { ...exactBody.publication,
            name: { original: 'en', labels: { en: `Third Circle ${size}`, 'zh-Hans': '第三圈' } },
            count: { kind: 'estimated', value: 3 } } }), 201)).revision;
      await refresh();
      await settled();
      const consecutiveChanges = (await stack.accessPool.query<{ realm: string }>(
        'SELECT realm FROM access.realm_directory_probe')).rows;
      expect(consecutiveChanges).toHaveLength(6);
      expect(new Set(consecutiveChanges.map(row => row.realm))).toEqual(new Set([second.realm, third.realm]));
      expect((await json<DirectoryPage>(await get('/v1/realms?q=Book'))).items[0])
        .toMatchObject({ id: second.realm, name: { value: `Book Circle ${size}` },
          membership: { count: { kind: 'exact', value: 1 } } });
    }
    // A receipted visibility fixture exercises removal, including carrying the
    // deletion into the older slot on a later unrelated graph write.
    await stack.accessPool.query('TRUNCATE access.realm_directory_probe');
    await stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(third.space)} rv:disclosure rv:Public }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(third.space)} rv:disclosure rv:Private }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.receipts)} { <urn:rezics:directory-visibility:${randomUUID()}> a rv:OperationReceipt ;
          rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:realm ${iri(third.realm)} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ;
        rv:sequence ?sequence } BIND((?sequence + 1) AS ?next) }`);
    await refresh();
    await settled();
    expect((await stack.accessPool.query('SELECT realm FROM access.realm_directory_probe')).rows)
      .toEqual([{ realm: third.realm }, { realm: third.realm }, { realm: third.realm }]);
    await stack.accessPool.query('TRUNCATE access.realm_directory_probe');
    await stack.publicWork(editor.actor, ['en'], 'Carry forward a directory deletion');
    await refresh();
    await settled();
    expect((await stack.accessPool.query('SELECT realm FROM access.realm_directory_probe')).rows)
      .toEqual([{ realm: third.realm }]);
    expect((await stack.accessPool.query('SELECT 1 FROM access.realm_directory WHERE realm = $1', [third.realm])).rows)
      .toEqual([]);
    await stack.accessPool.query('TRUNCATE access.realm_directory_probe');
    await stack.publicWork(editor.actor, ['en'], 'An unrelated write leaves the directory rows alone');
    await refresh();
    await settled();
    expect((await stack.accessPool.query('SELECT 1 FROM access.realm_directory_probe')).rows).toEqual([]);
    expect((await json<DirectoryPage>(await get('/v1/realms?q=Third'))).items).toEqual([]);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect((await get('/v1/realms')).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
  } finally { await stack.stop(); }
}, 120_000);
