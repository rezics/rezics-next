import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import type { NativeWorkSourceAdoption } from '../../../services/main/src/modules/source/native-work-adoption.ts';

const workId = (ordinal: number) => `OL9200${ordinal}W`;

test('G357: adopted title language uses Work, Edition, script or explicit evidence and replays immutably', async () => {
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `source-adoption-language-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const propose = async (ordinal: number, title: string, languages?: unknown) => {
      const id = workId(ordinal);
      const raw = Buffer.from(JSON.stringify({ key: `/works/${id}`, type: { key: '/type/work' },
        title, ...(languages === undefined ? {} : { languages }), authors: [] }));
      const observed = await h.intake.submit(h.principalId, randomUUID(), {
        provider: 'open-library', namespace: 'work', externalId: id, sourceRevision: null,
        mediaType: 'application/json', retention: 'retained', rawBytesBase64: raw.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'unknown', note: '' },
      }, { profile: 'open-library-work-acquisition-v1',
        url: `https://openlibrary.org/works/${id}.json`, status: 200,
        etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
      const conversion = await h.conversions.convert(h.principalId, shortId(observed.observation.observation));
      expect(conversion).not.toBeNull();
      await h.graph.project(h.principalId, shortId(conversion!.conversion.conversion));
      const proposal = await h.proposals.propose(h.principalId, shortId(conversion!.conversion.conversion));
      expect(proposal).not.toBeNull();
      return { proposal: proposal!.proposal, observation: observed.observation.observation };
    };
    const edition = async (ordinal: number, parent: string, title: string, language: string) => {
      const id = `OL9300${ordinal}M`;
      const raw = Buffer.from(JSON.stringify({ key: `/books/${id}`, type: { key: '/type/edition' },
        title, works: [{ key: `/works/${parent}` }], languages: [{ key: `/languages/${language}` }] }));
      return (await h.intake.submit(h.principalId, randomUUID(), {
        provider: 'open-library', namespace: 'edition', externalId: id, sourceRevision: null,
        mediaType: 'application/json', retention: 'retained', rawBytesBase64: raw.toString('base64'),
        coverage: { scope: 'open-library-edition-response-v1', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'unknown', note: '' },
      })).observation.observation;
    };
    const adopt = async (proposal: { proposal: string; candidateTitle: string },
      titleLanguage?: string) => h.call('POST',
      `/v1/sources/proposals/${shortId(proposal.proposal)}/adoption/native-work`, {
        profile: 'source-native-work-adoption-v1', actingSubject: h.actor,
        confirmedTitle: proposal.candidateTitle,
        ...(titleLanguage === undefined ? {} : { titleLanguage }) });
    const label = async (work: string, title: string, language: string) =>
      (await h.nativeFuseki.query(`ASK { GRAPH <urn:rezics:graph:current> {
        <${work}> <http://www.w3.org/2000/01/rdf-schema#label> "${title}"@${language} . } }`)).boolean;

    const work = await propose(1, '西遊記', [{ key: '/languages/chi' }]);
    const fromWork = await h.json<{ adoption: NativeWorkSourceAdoption }>(await adopt(work.proposal), 201);
    expect(fromWork.adoption).toMatchObject({ titleLanguage: 'zh-Hant',
      titleLanguageAtActivation: 'zh-Hant', titleLanguageBasis: 'work',
      titleLanguageObservation: work.observation });
    expect(await label(fromWork.adoption.work, '西遊記', 'zh-Hant')).toBe(true);

    const withEdition = await propose(2, '西游记');
    const editionObservation = await edition(2, workId(2), '西遊記', 'chi');
    const fromEdition = await h.json<{ adoption: NativeWorkSourceAdoption }>(await adopt(withEdition.proposal), 201);
    expect(fromEdition.adoption).toMatchObject({ titleLanguage: 'zh-Hans',
      titleLanguageAtActivation: 'zh-Hans', titleLanguageBasis: 'edition',
      titleLanguageObservation: editionObservation });
    expect(await label(fromEdition.adoption.work, '西游记', 'zh-Hans')).toBe(true);

    const inferred = await propose(3, '三国演义');
    const fromScript = await h.json<{ adoption: NativeWorkSourceAdoption }>(await adopt(inferred.proposal), 201);
    expect(fromScript.adoption).toMatchObject({ titleLanguage: 'zh-Hans',
      titleLanguageBasis: 'inferred', titleLanguageObservation: null });
    expect(await label(fromScript.adoption.work, '三国演义', 'zh-Hans')).toBe(true);

    const override = await propose(4, '西游记', [{ key: '/languages/chi' }]);
    const explicitlyEnglish = await h.json<{ adoption: NativeWorkSourceAdoption }>(
      await adopt(override.proposal, 'en'), 201);
    expect(explicitlyEnglish.adoption).toMatchObject({ titleLanguage: 'en',
      titleLanguageBasis: 'explicit', titleLanguageObservation: null });
    expect(await label(explicitlyEnglish.adoption.work, '西游记', 'en')).toBe(true);
    expect((await adopt(override.proposal)).status).toBe(409);
    expect((await adopt(override.proposal, 'zh-Hant')).status).toBe(409);
    const replay = await h.json<{ adoption: NativeWorkSourceAdoption; replayed: boolean }>(
      await adopt(override.proposal, 'en'), 200);
    expect(replay).toEqual({ adoption: explicitlyEnglish.adoption, replayed: true });

    const other = await propose(5, 'A title with no language');
    const unknown = await h.json<{ adoption: NativeWorkSourceAdoption }>(await adopt(other.proposal), 201);
    expect(unknown.adoption).toMatchObject({ titleLanguage: 'und', titleLanguageBasis: 'inferred' });
    const tagged = await propose(6, 'A title with an explicit regional language');
    const regional = await h.json<{ adoption: NativeWorkSourceAdoption }>(
      await adopt(tagged.proposal, 'fr-CA'), 201);
    expect(regional.adoption).toMatchObject({ titleLanguage: 'fr-CA',
      titleLanguageAtActivation: 'fr-CA', titleLanguageBasis: 'explicit' });
    expect(await label(regional.adoption.work, tagged.proposal.candidateTitle, 'fr-CA')).toBe(true);
    expect((await h.pool.query('SELECT source.infer_title_language($1) AS value', ['三國演義'])).rows[0].value)
      .toBe('zh-Hant');
    expect((await h.pool.query('SELECT source.infer_title_language($1) AS value', ['かなと漢字'])).rows[0].value)
      .toBe('ja');
    expect((await h.pool.query('SELECT source.infer_title_language($1) AS value', ['한글과漢字'])).rows[0].value)
      .toBe('ko');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

test('G357: migration resolves old title languages while preserving sealed receipt language', async () => {
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const schema = `source_g357_${randomUUID().replaceAll('-', '')}`;
  const directory = resolve(import.meta.dir, '../../../services/content/migrations');
  const scoped = (sql: string) => sql.replace(/\bsource\./g, `${schema}.`)
    .replace('CREATE SCHEMA IF NOT EXISTS source;', `CREATE SCHEMA IF NOT EXISTS ${schema};`);
  try {
    for (const name of ['005_source_intake.sql', '006_source_capture.sql',
      '007_source_conversion.sql', '008_source_native_work_proposal.sql',
      '009_source_native_work_adoption.sql']) {
      await pool.query(scoped(readFileSync(join(directory, name), 'utf8')));
    }
    const stage = async (title: string, ordinal: number, bound: boolean,
      workLanguage?: string) => {
      const record = randomUUID(), observation = randomUUID(), conversion = randomUUID();
      const proposal = randomUUID(), intent = randomUUID(), principal = randomUUID();
      const bytes = Buffer.from(JSON.stringify({ key: `/works/${workId(ordinal)}`,
        type: { key: '/type/work' }, title,
        ...(workLanguage ? { languages: [{ key: `/languages/${workLanguage}` }] } : {}) }));
      await pool.query(scoped(`INSERT INTO source.record (id, provider, namespace, external_id)
        VALUES ($1, 'open-library', 'work', $2)`), [record, workId(ordinal)]);
      await pool.query(scoped(`INSERT INTO source.observation (id, record_id, principal_id,
        media_type, retention, raw_bytes, byte_digest, coverage, rights_evidence)
        VALUES ($1,$2,$3,'application/json','retained',$4,$5,$6,'{}')`),
      [observation, record, principal, bytes, createHash('sha256').update(bytes).digest('hex'),
        { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] }]);
      await pool.query(scoped(`INSERT INTO source.conversion (id, observation_id, principal_id,
        mapping_revision, source_digest, projection, field_inventory)
        VALUES ($1,$2,$3,'open-library-work-map-v1',$4,'{}','[]')`),
      [conversion, observation, principal, createHash('sha256').update(bytes).digest('hex')]);
      await pool.query(scoped(`INSERT INTO source.native_work_proposal (id, conversion_id,
        observation_id, record_id, principal_id, source_digest, candidate_title,
        rights_evidence, graph_receipt, graph_data_epoch, graph_sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9,1)`),
      [proposal, conversion, observation, record, principal,
        createHash('sha256').update(bytes).digest('hex'), title,
        `urn:rezics:receipt:source-projection:${'a'.repeat(64)}`, randomUUID()]);
      await pool.query(scoped(`INSERT INTO source.native_work_adoption_intent
        (id, proposal_id, principal_id, acting_subject, authority_path, confirmed_title,
          title_language, work_idempotency_key)
        VALUES ($1,$2,$3,$4,'represented-agent',$5,'en',$6)`),
      [intent, proposal, principal, `https://rezics.com/id/${randomUUID()}`, title,
        `source-adopt-${randomUUID()}`]);
      if (bound) await pool.query(scoped(`INSERT INTO source.native_work_binding
        (id, intent_id, proposal_id, principal_id, work, main_version,
          work_revision, main_revision, graph_receipt, admission_id, data_epoch, sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`),
      [randomUUID(), intent, proposal, principal, `https://rezics.com/id/${randomUUID()}`,
        `https://rezics.com/id/${randomUUID()}`, `https://rezics.com/id/${randomUUID()}`,
        `https://rezics.com/id/${randomUUID()}`, `urn:rezics:receipt:${'b'.repeat(64)}`,
        randomUUID(), randomUUID()]);
      return { intent, principal };
    };
    const sealed = await stage('西游记', 11, true);
    const pending = await stage('三國演義', 12, false);
    const workEvidence = await stage('西遊記', 13, false, 'chi');
    const editionEvidence = await stage('西游记', 14, false);
    const editionRecord = randomUUID(), editionObservation = randomUUID();
    const editionId = 'OL930014M';
    const editionBytes = Buffer.from(JSON.stringify({ key: `/books/${editionId}`,
      type: { key: '/type/edition' }, title: '西遊記',
      works: [{ key: `/works/${workId(14)}` }],
      languages: [{ key: '/languages/chi' }] }));
    await pool.query(scoped(`INSERT INTO source.record (id, provider, namespace, external_id)
      VALUES ($1, 'open-library', 'edition', $2)`), [editionRecord, editionId]);
    await pool.query(scoped(`INSERT INTO source.observation (id, record_id, principal_id,
      media_type, retention, raw_bytes, byte_digest, coverage, rights_evidence)
      VALUES ($1,$2,$3,'application/json','retained',$4,$5,$6,'{}')`),
    [editionObservation, editionRecord, editionEvidence.principal, editionBytes,
      createHash('sha256').update(editionBytes).digest('hex'),
      { scope: 'open-library-edition-response-v1', complete: true, omittedFields: [] }]);
    await pool.query(scoped(readFileSync(join(directory, '405_source_adoption_title_language.sql'), 'utf8')));
    const rows = (await pool.query(scoped(`SELECT id, title_language, title_language_basis,
      title_language_observation_id, activation_language, request_title_language
      FROM source.native_work_adoption_intent ORDER BY id`))).rows;
    expect(rows.find(row => row.id === sealed.intent)).toMatchObject({ title_language: 'zh-Hans',
      title_language_basis: 'inferred', activation_language: 'en', request_title_language: 'en' });
    expect(rows.find(row => row.id === pending.intent)).toMatchObject({ title_language: 'zh-Hant',
      title_language_basis: 'inferred', activation_language: 'zh-Hant', request_title_language: 'en' });
    expect(rows.find(row => row.id === workEvidence.intent)).toMatchObject({
      title_language: 'zh-Hant', title_language_basis: 'work',
      activation_language: 'zh-Hant', request_title_language: 'en' });
    expect(rows.find(row => row.id === editionEvidence.intent)).toMatchObject({
      title_language: 'zh-Hans', title_language_basis: 'edition',
      title_language_observation_id: editionObservation,
      activation_language: 'zh-Hans', request_title_language: 'en' });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
}, 30_000);
