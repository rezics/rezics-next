import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { memberFixture } from '../../../services/main/tests/member-reply-fixture.ts';
import { startMediaStack } from './media-support.ts';
import { DATASET, GRAPHS, hash, iri, prepareComponent, RV } from '../../../services/main/src/modules/work/activate.ts';
import { readExactMainRevision } from '../../../services/main/src/modules/work/history.ts';
import { readMainLanguageHeads } from '../../../services/main/src/modules/work/selection-heads.ts';
import { readMainDefaultVariant } from '../../../services/main/src/modules/work/native-variants.ts';
import { queryPublicMainTitleBody } from '../../../services/main/src/modules/work/search-multifield.ts';
import { queryPublicMainPhrase, queryPublicRealmPhrase } from '../../../services/main/src/modules/work/search-public.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { projectDiscoveryWork } from '../../../services/main/src/modules/discovery/source.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { reconcileRetainedMainSelection } from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { assertCommandRace } from '../support/command-race.ts';

test('G-277: language CAS is independent, stale within a language, exact through history and lost responses', async () => {
  const h = await memberFixture();
  try {
    const draft = await h.post('/v1/contributions', { profile: 'text-contribution-v1', work: h.work.work,
      language: 'zh-CN', body: '中文选择独立保存。 Bilingual needle', actingSubject: h.actor });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const published = await h.post('/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.body.contribution, expectedDraftHead: draft.body.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: h.actor });
    expect(published.status).toBe(201);
    const chinese = { ...h.selection, contribution: draft.body.contribution,
      publicationDecision: published.body.publicationDecision };
    const [english, zh] = await Promise.all([
      h.post('/v1/publication-selections', h.selection), h.post('/v1/publication-selections', chinese),
    ]);
    expect([english.status, zh.status], JSON.stringify([english.body, zh.body])).toEqual([201, 201]);
    const heads = await readMainLanguageHeads(h.env, h.work.mainVersion);
    expect(heads).toHaveLength(2);
    expect((await readMainDefaultVariant(h.env, h.work.mainVersion, 'en')).selection).toBe(english.body.selection);
    expect((await readMainDefaultVariant(h.env, h.work.mainVersion, 'zh-cn')).selection).toBe(zh.body.selection);
    const get = async (path: string) => {
      const response = await h.app.handle(new Request(`http://main.local${path}`));
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    expect((await get(`/v1/works/${h.work.work.slice(-36)}?language=zh-CN`)).body.selectedLanguage).toBe('zh-CN');
    expect((await get(`/v1/main-versions/${h.work.mainVersion.slice(-36)}/selection?language=zh-CN`)).body.body)
      .toBe('中文选择独立保存。 Bilingual needle');
    expect((await get(`/v1/main-versions/${h.work.mainVersion.slice(-36)}/selection?language=fr`)).status).toBe(404);
    const second = await h.contribution('English replacement. Bilingual needle');
    const next = { ...h.selection, ...second, expectedSelectionHead: english.body.selection };
    delete (next as Record<string, unknown>).draftRevision;
    const winnersCommands = [
      h.post.bind(h, '/v1/publication-selections', next, randomUUID()),
      h.post.bind(h, '/v1/publication-selections', next, randomUUID()),
    ];
    const winners = await assertCommandRace(
      await Promise.all(winnersCommands.map((send) => send())),
      201,
      (index) => winnersCommands[index]!(),
    );
    const winner = winners.find(result => result.status === 201)!.body;
    const exact = await readExactMainRevision(h.env, h.work.mainVersion, winner.mainRevision, async () => true);
    expect(exact.defaultSelections).toEqual({ en: winner.selection, 'zh-cn': zh.body.selection });
    expect((await readMainDefaultVariant(h.env, h.work.mainVersion, 'zh-CN')).selection).toBe(zh.body.selection);
    const global = await queryPublicMainPhrase(h.env, { phrase: 'English replacement', language: 'en' });
    expect(global.results.filter(row => row.work === h.work.work)).toHaveLength(1);
    expect((await queryPublicMainPhrase(h.env, { phrase: 'Bilingual needle', language: null })).results)
      .toHaveLength(1);
    expect((await queryPublicMainTitleBody(h.env, { titleTerm: 'Member Work', bodyTerm: 'Bilingual needle',
      language: null })).results).toHaveLength(1);
    const realm = await h.post('/v1/spaces', { profile: 'space-realm-v1', name: 'Language Realm',
      capabilities: ['realm'], actingSubject: h.actor });
    expect(realm.status).toBe(201);
    const effective = await queryPublicRealmPhrase(h.env, { phrase: 'English replacement', language: 'en',
      context: { kind: 'realm-local', id: realm.body.realm } });
    expect(effective.results.filter(row => row.work === h.work.work)).toHaveLength(1);
    const principalId = await h.access.activePrincipalId(await h.principal());
    const adoptScope = `publication:adopt:${realm.body.realm}`;
    await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [adoptScope]);
    await h.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'publication.adopt',now()+interval '1 hour')`,
    [randomUUID(), principalId, h.actor]);
    await h.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'publication.adopt',now()+interval '1 hour')`, [randomUUID(), h.actor, adoptScope]);
    const adopted = await h.post('/v1/publication-selections', { profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: realm.body.realm }, mainVersion: h.work.mainVersion,
      work: h.work.work, contribution: h.first.contribution, publicationDecision: h.first.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: h.actor });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const chineseSearch = await queryPublicRealmPhrase(h.env, { phrase: 'Bilingual needle', language: 'zh-CN',
      context: { kind: 'realm-local', id: realm.body.realm } });
    expect(chineseSearch.results.filter(row => row.work === h.work.work)).toHaveLength(1);
    expect(chineseSearch.results.find(row => row.work === h.work.work)?.selection).toBe(zh.body.selection);
    const chineseRead = await get(`/v1/realms/${realm.body.realm.slice(-36)}/main-versions/${h.work.mainVersion.slice(-36)}/selection?language=zh-CN`);
    expect(chineseRead.status, JSON.stringify(chineseRead.body)).toBe(200);
    expect(chineseRead.body.selection).toBe(zh.body.selection);
    // The discovery source projects one Work even when two Main languages qualify.
    const seq = (await h.fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`)).results!.bindings[0]!.n!.value;
    const session = new WorkReadSession({ environment: h.env, access: h.access, account: h.verifier },
      new Request('http://main.local'), { language: 'zh-CN' }, { dataEpoch: h.env.lineage.dataEpoch, sequence: seq });
    const predecessor = (BigInt(`0x${h.work.work.slice(-36).replaceAll('-', '')}`) - 1n)
      .toString(16).padStart(32, '0').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    const projected = await projectDiscoveryWork(session, { scope: 'global', realm: null, context: null },
      `https://rezics.com/id/${predecessor}`);
    expect(projected.item?.work).toBe(h.work.work);
    expect((await projectDiscoveryWork(session, { scope: 'global', realm: null, context: null }, h.work.work)).item?.work)
      .not.toBe(h.work.work);
    const before = h.fuseki.commandWithReceipt.bind(h.fuseki);
    let lost = false;
    h.fuseki.commandWithReceipt = async (...args) => {
      const result = await before(...args);
      if (!lost) { lost = true; throw new Error('lost selection response after commit'); }
      return result;
    };
    const key = randomUUID();
    const retried = await h.post('/v1/publication-selections', { ...chinese, expectedSelectionHead: zh.body.selection }, key);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect((await h.post('/v1/publication-selections', { ...chinese, expectedSelectionHead: zh.body.selection }, key)).body.selection)
      .toBe(retried.body.selection);
    h.fuseki.commandWithReceipt = before;
    await h.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(draft.body.draftRevision)} a <${RV}ErasedRevision> } }`);
    expect((await get(`/v1/main-versions/${h.work.mainVersion.slice(-36)}/selection?language=zh-CN`)).status).toBe(404);
    expect((await get(`/v1/main-versions/${h.work.mainVersion.slice(-36)}/selection?language=en`)).status).toBe(200);
    expect((await readExactMainRevision(h.env, h.work.mainVersion, winner.mainRevision, async () => true)).defaultSelections)
      .toEqual(exact.defaultSelections);
  } finally { await h.close(); }
}, 180_000);

test('G-277: legacy singleton migration and retained replay preserve other language heads', async () => {
  const h = await startMediaStack('main-language-restore');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const actor = await h.member('maintainer');
    const work = await h.publicWork(actor.actor, ['en', 'zh-CN']);
    await actor.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const initial = await readMainDefaultVariant(h.env, work.mainVersion, 'en');
    const head = (await h.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work.mainVersion)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    const exact = await readExactMainRevision(h.env, work.mainVersion, head, async () => true);
    const legacy = prepareComponent(h.env.objectDirectory, work.mainVersion, { work: work.work,
      hostingPolicy: 'metadata-only', defaultSelection: initial.selection, predecessor: exact.predecessor });
    await h.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:manifest ?old } }
      INSERT { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:manifest <urn:rezics:sha256:${legacy}> } }
      WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:manifest ?old } }`);
    expect((await readExactMainRevision(h.env, work.mainVersion, head, async () => true)).defaultSelections)
      .toEqual({ en: initial.selection });
    await actor.grant(`work:edit:${work.work}`, 'work.edit');
    const structureObjects = h.objects('semantic/structure/');
    await structureObjects.initialize();
    h.env.structureObjects = structureObjects;
    await h.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work.work)} a <https://schema.org/Book> } }`);
    const composition = await actor.send('POST', '/v1/compositions', { profile: 'book-composition',
      work: work.work, mainVersion: work.mainVersion, actingSubject: actor.actor });
    expect(composition.status, await composition.clone().text()).toBe(201);
    const savedSequence = (await h.fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`)).results!.bindings[0]!.n!.value;
    const graphs = [...Object.values(GRAPHS), PUBLIC_SEARCH_GRAPH];
    for (const graph of graphs) await h.fuseki.update(`COPY GRAPH ${iri(graph)} TO GRAPH <urn:test:saved:${hash(graph)}>`);
    const command = (index: number, expectedSelectionHead: string | null) => actor.send('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: work.variants[index]!.contribution,
      publicationDecision: work.variants[index]!.decision, expectedSelectionHead,
      selectionBasis: 'main-maintainer', actingSubject: actor.actor });
    const selected = [];
    for (const [index, prior] of [[1, null], [0, initial.selection]] as const) {
      const response = await command(index, prior);
      expect(response.status, await response.clone().text()).toBe(201);
      selected.push(await response.json() as { selection: string; mainRevision: string; sourcePosition: { sequence: string } });
    }
    for (const language of ['en', 'zh-CN']) {
      const contents = await h.call('GET', `/v1/works/${work.work.slice(-36)}/contents?language=${language}`);
      expect(contents.status, await contents.clone().text()).toBe(200);
      expect((await contents.json() as { language: string }).language).toBe(language.toLowerCase());
    }
    const consumer = `language-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, h.env.lineage.dataEpoch);
    while (await relayMainOutboxOnce(h.fuseki, relay, consumer)) { /* retain the complete source prefix */ }
    const coverage = await relayCoverage(relay, consumer);
    const fence = await engageAccessRecoveryFence(h.accessPool);
    for (const graph of graphs) await h.fuseki.update(`COPY GRAPH <urn:test:saved:${hash(graph)}> TO GRAPH ${iri(graph)}`);
    const next = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
    await cutoverRestoredGraphLineage(h.fuseki, { prior: { ...h.env.lineage, sequence: savedSequence }, next });
    const restored = { ...h.env, lineage: next };
    for (const receipt of selected) {
      expect((await reconcileRetainedMainSelection(restored, h.accessPool, relay, coverage, receipt.sourcePosition.sequence)).selection)
        .toBe(receipt.selection);
      expect((await reconcileRetainedMainSelection(restored, h.accessPool, relay, coverage, receipt.sourcePosition.sequence)).replayed).toBe(true);
    }
    expect(await readMainLanguageHeads(restored, work.mainVersion)).toHaveLength(2);
    expect((await readExactMainRevision(restored, work.mainVersion, selected[1]!.mainRevision, async () => true)).defaultSelections)
      .toEqual({ en: selected[1]!.selection, 'zh-cn': selected[0]!.selection });
    await releaseAccessRecoveryFence(h.accessPool, fence);
  } finally { await relay.end(); await h.stop(); }
}, 180_000);
