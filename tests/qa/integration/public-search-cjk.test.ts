import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, GRAPHS, ID, metadataWorkRequestDigest,
  TEXT_INDEX_PROFILE, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest }
  from '../../../services/main/src/modules/work/select-realm.ts';

const root = resolve(import.meta.dir, '../../..');
const publicGraph = 'urn:rezics:search:public';

interface SelectedText {
  work: string;
  mainVersion: string;
  contribution: string;
  revision: string;
  selection: string;
  matchUnit: string;
  language: string;
  body: string;
}

test('SEARCH06: versioned CJK Main and Realm phrases bind exact selected bodies and languages', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `search-cjk-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const actor = ID + randomUUID();
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = {
    fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects'),
  };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const app = createMainApp(fuseki, { environment: env,
    account: { verify: async () => { throw new Error('no authority request in public search test'); } },
    access: new AccessAdmissionRegistry(accessPool) });

  function admission(scope: string, action: string, requestDigest: string): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `cjk-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }

  async function published(work: string, language: string, body: string) {
    const draftInput = { work, language, body, actingSubject: actor };
    const draft = await activateTextContribution(env,
      admission(`contribution:create:${work}`, 'contribution.create',
        textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('CJK Contribution draft failed');
    }
    const publishInput = { contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: actor };
    const publication = await publishTextContribution(env,
      admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publishInput)), publishInput);
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('CJK Contribution publication failed');
    }
    return { contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      revision: draft.draftRevision, language, body };
  }

  async function mainWork(language: string, body: string) {
    const title = `CJK search ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const source = await published(created.work, language, body);
    const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: source.contribution,
      publicationDecision: source.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const selected = await selectMainDefault(env,
      admission(`publication:select:${created.mainVersion}`, 'publication.select',
        mainSelectionDigest(input)), input);
    if (selected.outcome !== 'succeeded' || !selected.selection || !selected.matchUnit
      || selected.selectedDraft !== source.revision || selected.language !== language) {
      throw new Error('CJK Main selection did not bind the published revision');
    }
    return { work: created.work, mainVersion: created.mainVersion,
      contribution: source.contribution, revision: source.revision,
      selection: selected.selection, matchUnit: selected.matchUnit, language, body };
  }

  async function query(profile: 'public-main-phrase-v1' | 'public-realm-phrase-v1',
    phrase: string, language: string | null, realm?: string) {
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile, phrase, language,
        ...(realm ? { context: { kind: 'realm-local', id: realm } } : {}) }),
    }));
    if (response.status !== 200) {
      throw new Error(`CJK public query returned ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<{ complete: boolean; indexGeneration: string;
      total: number; results: Array<Omit<SelectedText, 'body'> & { reason?: string; score: number }> }>;
  }

  function expectRows(result: Awaited<ReturnType<typeof query>>, expected: SelectedText[],
    generation: string, reason?: 'realm-adoption' | 'main-fallback') {
    expect(result.complete).toBe(true);
    expect(result.indexGeneration).toBe(generation);
    expect(result.total).toBe(expected.length);
    expect(result.results.map(row => {
      expect(Number.isFinite(row.score)).toBe(true);
      return { work: row.work, mainVersion: row.mainVersion,
        contribution: row.contribution, revision: row.revision,
        selection: row.selection, matchUnit: row.matchUnit,
        language: row.language, ...(row.reason ? { reason: row.reason } : {}) };
    })).toEqual(expected.map(({ body: _body, ...selected }) =>
      ({ ...selected, ...(reason ? { reason } : {}) })));
  }

  try {
    const realmInput = { name: `CJK Realm ${randomUUID()}`, actingSubject: actor };
    const space = await createRealmSpace(env,
      admission('space:create:root', 'space.create', spaceCreationDigest(realmInput)), realmInput);
    if (space.outcome !== 'succeeded' || !space.realm) throw new Error('CJK Realm creation failed');

    // The zh-tagged Realm body deliberately contains Japanese and Korean text;
    // the Main body also matches Galaxy42 so adoption must shadow a real hit.
    const alternateBody = '中文检索验证，東京図書館で한국어 자료を探す。Galaxy42 混合标识。';
    const english = await mainWork('en', `English main edition Galaxy42 ${randomUUID()}`);
    const japanese = await mainWork('ja', '東京図書館の案内。Galaxy42 銀河号。');
    const korean = await mainWork('ko', '한국어 자료 안내. Galaxy42 별빛호.');
    const alternate = await published(english.work, 'zh', alternateBody);

    const generation = (await query('public-main-phrase-v1', '中文检索', 'zh')).indexGeneration;
    expectRows(await query('public-main-phrase-v1', '中文检索', 'zh'), [], generation);
    expectRows(await query('public-realm-phrase-v1', '中文检索', 'zh', space.realm),
      [], generation);

    const adoptInput = { context: { kind: 'realm-local' as const, id: space.realm },
      work: english.work, mainVersion: english.mainVersion,
      contribution: alternate.contribution,
      publicationDecision: alternate.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const,
      actingSubject: actor };
    const adopted = await selectRealmLocal(env,
      admission(`publication:adopt:${space.realm}`, 'publication.adopt',
        realmSelectionDigest(adoptInput)), adoptInput);
    if (adopted.outcome !== 'succeeded' || !adopted.selection || !adopted.matchUnit
      || adopted.selectedDraft !== alternate.revision || adopted.language !== 'zh') {
      throw new Error('CJK Realm adoption did not bind the published revision');
    }
    const chinese: SelectedText = { work: english.work, mainVersion: english.mainVersion,
      contribution: alternate.contribution, revision: alternate.revision,
      selection: adopted.selection, matchUnit: adopted.matchUnit,
      language: 'zh', body: alternateBody };

    const control = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?profile WHERE { GRAPH <${GRAPHS.control}> {
        <urn:rezics:dataset:product> rv:textIndexProfile ?profile . } }`);
    expect(control.results?.bindings.map(row => row.profile?.value)).toEqual([TEXT_INDEX_PROFILE]);

    expectRows(await query('public-realm-phrase-v1', '中文检索', 'zh', space.realm),
      [chinese], generation, 'realm-adoption');
    expectRows(await query('public-realm-phrase-v1', '中文检索', 'ja', space.realm),
      [], generation);
    expectRows(await query('public-main-phrase-v1', '中文检索', null), [], generation);
    expectRows(await query('public-realm-phrase-v1', 'Galaxy42', 'zh', space.realm),
      [chinese], generation, 'realm-adoption');
    expectRows(await query('public-main-phrase-v1', 'Galaxy42', 'en'),
      [english], generation);
    expectRows(await query('public-realm-phrase-v1', 'Galaxy42', 'en', space.realm),
      [], generation);
    expectRows(await query('public-main-phrase-v1', 'Galaxy42', 'ja'),
      [japanese], generation);
    expectRows(await query('public-main-phrase-v1', 'Galaxy42', 'ko'),
      [korean], generation);
    expectRows(await query('public-realm-phrase-v1', 'Galaxy42', 'ja', space.realm),
      [japanese], generation, 'main-fallback');
    expectRows(await query('public-realm-phrase-v1', 'Galaxy42', 'ko', space.realm),
      [korean], generation, 'main-fallback');
    expectRows(await query('public-main-phrase-v1', 'Galaxy42', 'zh'), [], generation);
    const mainMixed = await query('public-main-phrase-v1', 'Galaxy42', null);
    expect(mainMixed.complete).toBe(true);
    expect(mainMixed.indexGeneration).toBe(generation);
    expect(mainMixed.total).toBe(3);
    expect(new Set(mainMixed.results.map(row => row.matchUnit)))
      .toEqual(new Set([english.matchUnit, japanese.matchUnit, korean.matchUnit]));
    const realmMixed = await query('public-realm-phrase-v1', 'Galaxy42', null, space.realm);
    expect(realmMixed.complete).toBe(true);
    expect(realmMixed.indexGeneration).toBe(generation);
    expect(realmMixed.total).toBe(3);
    expect(new Set(realmMixed.results.map(row => row.matchUnit)))
      .toEqual(new Set([chinese.matchUnit, japanese.matchUnit, korean.matchUnit]));
    expectRows(await query('public-realm-phrase-v1', '図書館', 'zh', space.realm),
      [chinese], generation, 'realm-adoption');
    expectRows(await query('public-realm-phrase-v1', '한국어', 'zh', space.realm),
      [chinese], generation, 'realm-adoption');

    expectRows(await query('public-main-phrase-v1', '東京図書館', 'ja'),
      [japanese], generation);
    expectRows(await query('public-realm-phrase-v1', '東京図書館', 'ja', space.realm),
      [japanese], generation, 'main-fallback');
    expectRows(await query('public-realm-phrase-v1', '東京図書館', 'zh', space.realm),
      [chinese], generation, 'realm-adoption');
    expectRows(await query('public-main-phrase-v1', '한국어', 'ko'),
      [korean], generation);
    expectRows(await query('public-realm-phrase-v1', '한국어', 'ko', space.realm),
      [korean], generation, 'main-fallback');
    expectRows(await query('public-main-phrase-v1', '한국어', 'zh'), [], generation);
    expectRows(await query('public-realm-phrase-v1', '한국어', 'ja', space.realm),
      [], generation);

    const originals = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?unit ?body ?revision ?language WHERE {
        GRAPH <${publicGraph}> {
          VALUES ?unit { <${english.matchUnit}> <${chinese.matchUnit}>
            <${japanese.matchUnit}> <${korean.matchUnit}> }
          ?unit rv:searchBody ?body ; rv:revision ?revision ; rv:language ?language .
        }
      }`);
    expect(originals.results?.bindings).toHaveLength(4);
    for (const selected of [english, chinese, japanese, korean]) {
      const row = originals.results?.bindings.find(item => item.unit?.value === selected.matchUnit);
      expect(row?.body).toMatchObject({ value: selected.body, 'xml:lang': selected.language });
      expect(row?.revision?.value).toBe(selected.revision);
      expect(row?.language?.value).toBe(selected.language);
    }

    const exact = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rv: <https://rezics.com/vocab/> SELECT ?literal ?graph WHERE {
        GRAPH <${publicGraph}> {
          (<${chinese.matchUnit}> ?score ?literal ?graph)
            text:query (rv:searchBody "中文检索") .
        }
      }`);
    expect(exact.results?.bindings).toEqual([expect.objectContaining({
      literal: expect.objectContaining({ value: alternateBody, 'xml:lang': 'zh' }),
      graph: expect.objectContaining({ value: publicGraph }),
    })]);
  } finally {
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
