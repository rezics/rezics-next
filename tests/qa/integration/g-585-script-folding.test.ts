import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, TEXT_INDEX_PROFILE,
  TEXT_INDEX_PROBE, TEXT_INDEX_PROBE_GRAPH, activateMetadataWork, metadataWorkRequestDigest,
  iri, lit, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH, mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { assertPublicTextReady, SearchIndexUnavailable }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { activateRebuiltPublicContentSearch, clearQuarantinedContentUnits,
  quarantinePublicContentSearch, replayQuarantinedContentCut }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { assertPinnedState, docker, inspectFusekiState, offlineTextIndex, repositoryPins, sha256 }
  from '../../../scripts/operations/search-state.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { pinnedImage, standaloneFuseki }
  from '../fault-recovery/search-ops-support.ts';
import { startMediaStack } from './media-support.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';

const root = resolve(import.meta.dir, '../../..');
const fixtures = [
  { title: '魔法禁書目錄', language: 'zh-Hant', queries: ['魔法禁书目录', '魔法禁書目錄'] },
  { title: '魔法禁书目录', language: 'zh-Hans', queries: ['魔法禁書目錄', '魔法禁书目录'] },
  { title: 'かたかな', language: 'ja', queries: ['カタカナ', 'ｶﾀｶﾅ', 'かたかな'] },
  { title: 'カタカナ', language: 'ja', queries: ['かたかな', 'ｶﾀｶﾅ', 'カタカナ'] },
  { title: 'ｶﾀｶﾅ', language: 'ja', queries: ['かたかな', 'カタカナ', 'ｶﾀｶﾅ'] },
  { title: 'ガラス', language: 'ja', queries: ['ガラス', 'がらす', 'ｶﾞﾗｽ', 'か\u3099らす'] },
  { title: 'ｶﾞﾗｽ', language: 'ja', queries: ['ガラス', 'がらす', 'ｶﾞﾗｽ', 'か\u3099らす'] },
  { title: 'ＲＵＳＴ', language: 'en', queries: ['rust', 'RUST'] },
  { title: '魔法禁書索引', language: 'zh-Hant', queries: ['魔法禁书索引'] },
  { title: 'カラス', language: 'ja', queries: ['からす'] },
  { title: 'キャンパス', language: 'ja', queries: ['きゃんぱす'] },
  { title: 'キヤンパス', language: 'ja', queries: ['きやんぱす'] },
] as const;

test('G-585: selected title/body HTTP search matches Chinese and kana variants and retains authored values', async () => {
  const stack = await startMediaStack(`g585${randomUUID().replaceAll('-', '')}`);
  try {
    const member = await stack.member('folding-reader');
    const marker = `g585${randomUUID().replaceAll('-', '')}`;
    const works = [];
    for (const fixture of fixtures) {
      const created = await activateMetadataWork(stack.env, { title: fixture.title, language: fixture.language,
        admission: stack.admission(member.actor, 'work:create:root', 'work.create',
          metadataWorkRequestDigest(fixture.title, undefined, fixture.language)) });
      const publication = await stack.contribution(created.work, member.actor, fixture.language,
        `${marker} ${fixture.title}`);
      const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
        work: created.work, contribution: publication.contribution, publicationDecision: publication.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
      const selected = await selectMainDefault(stack.env, stack.admission(member.actor,
        `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(input)), input);
      expect(selected.outcome).toBe('succeeded');
      works.push({ ...created, ...fixture, unit: selected.matchUnit! });
    }
    const query = async (titleTerm: string) => {
      const response = await stack.main.handle(new Request('http://main.local/v1/queries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-main-title-body-v1', titleTerm, bodyTerm: marker, language: null }),
      }));
      const value = await response.json();
      if (response.status !== 200) throw new Error(`folded HTTP ${response.status}: ${JSON.stringify(value)}`);
      return value as { complete: boolean; total: number; results: Array<{ work: string; language: string;
        title: { value: string }; indexGeneration?: string }> };
    };
    const queries = new Set(fixtures.flatMap(fixture => [...fixture.queries]));
    for (const term of queries) {
      const result = await query(term);
      const expected = works.filter(work => (work.queries as readonly string[]).includes(term));
      expect(result.complete).toBe(true);
      expect(result.total).toBe(expected.length);
      expect(new Set(result.results.map(row => row.work))).toEqual(new Set(expected.map(work => work.work)));
      for (const row of result.results) {
        const original = expected.find(work => work.work === row.work)!;
        expect(row.language).toBe(original.language);
        expect(row.title.value).toBe(original.title);
      }
      const rankedReply = await stack.main.handle(new Request(
        `http://main.local/v1/search/catalogue?q=${encodeURIComponent(`${marker} ${term}`)}&limit=64`));
      const ranked = await rankedReply.json() as { count: { value: number; precision: string };
        results: Array<{ work: string; language: string; title: { value: string } }> };
      if (rankedReply.status !== 200) throw new Error(`ranked folding HTTP ${rankedReply.status}: ${JSON.stringify(ranked)}`);
      expect(ranked.count).toEqual({ value: expected.length, precision: 'exact' });
      expect(new Set(ranked.results.map(row => row.work))).toEqual(new Set(expected.map(work => work.work)));
      for (const row of ranked.results) {
        const original = expected.find(work => work.work === row.work)!;
        expect(row.title.value).toBe(original.title);
        expect(row.language).toBe(original.language);
      }
    }
    expect((await query('katakana')).total).toBe(0);
    expect((await query('魔法禁書目録外伝')).total).toBe(0);
    // The native hit's literal is independently checked, without RDF masking it.
    for (const work of works) {
      for (const predicate of ['publicTitle', 'searchBody']) {
        const hits = await stack.fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
          PREFIX rv: <https://rezics.com/vocab/> SELECT ?literal ?graph WHERE {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            (${iri(work.unit)} ?score ?literal ?graph) text:query (rv:${predicate} ${lit(`"${work.queries[0]}"`)} 2) . } }`);
        expect(hits.results?.bindings).toEqual([expect.objectContaining({
          literal: expect.objectContaining({ value: predicate === 'publicTitle' ? work.title : `${marker} ${work.title}`,
            'xml:lang': work.language }),
          graph: expect.objectContaining({ value: PUBLIC_SEARCH_GRAPH }),
        })]);
      }
    }
  } finally { await stack.stop(); }
}, 180_000);

test('G-585: a v1 analyzer volume stays closed until a resumable profile upgrade and real offline rebuild qualify its generation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) throw new Error('Run through QA integration');
  const identity = randomUUID(), name = `rezics-qa-g585-${identity}`;
  const directory = join(root, '.temp', `g585-rebuild-${identity}`);
  mkdirSync(directory, { recursive: true });
  const assembler = join(directory, 'fuseki-text.ttl');
  const current = readFileSync(join(root, 'infra/jena/fuseki-text.ttl'), 'utf8');
  writeFileSync(assembler, current.replace('com.rezics.jena.FilteredGraphTextAssembler$CjkBigramV2',
    'org.apache.lucene.analysis.cjk.CJKAnalyzer'));
  const dockerEnv = loadDockerEnvironment(), volume = `${name}-data`;
  const secrets = Object.fromEntries(['FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN', 'FUSEKI_TITLE_ADMISSION_KEY']
    .map(key => [key, randomBytes(32).toString('hex')]));
  // The standalone graph has its own epoch; never pair it with the first test's publications.
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['content'], 'owner');
  const pool = new Pool({ connectionString: databases.urls.content });
  let server: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
  const original = '魔法禁書目錄 ガラス ＲＵＳＴ', unit = `urn:rezics:g585:${identity}`;
  const priorGeneration = `urn:rezics:text-index-generation:${randomUUID()}`;
  try {
    await migrateContent(pool);
    docker(['volume', 'create', volume], dockerEnv, 15_000);
    server = await standaloneFuseki(dockerEnv, { name, volume, image: pinnedImage(), secrets,
      mounts: [`${assembler}:/fuseki/fuseki-text.ttl:ro,Z`] });
    const fuseki = new FusekiClient(server.url, secrets.FUSEKI_MAINTENANCE_TOKEN, secrets.FUSEKI_COMMAND_TOKEN);
    const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory,
      lineage: { dataEpoch: identity, routingEpoch: identity } };
    const receipt = `urn:rezics:receipt:bootstrap:g585-${identity}`, digest = sha256(receipt);
    const bootstrap = await fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
      update: `PREFIX rv: <https://rezics.com/vocab/> INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(identity)} ; rv:routingEpoch ${lit(identity)} ;
          rv:sequence 0 ; rv:textIndexProfile <https://rezics.com/definition/search-index-cjk-bigram-v2> ;
          rv:textIndexGeneration ${iri(priorGeneration)} . }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
          ${iri(unit)} a rv:MatchUnit ; rv:searchBody ${lit(original)}@zh-Hant . }
        GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} { ${iri(TEXT_INDEX_PROBE)} rv:searchBody "中文检索验证"@zh . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(identity)} ; rv:sequence 0 . }
      } WHERE { FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} ?p ?o } } }` });
    expect(bootstrap.status).toBe('committed');
    const text = (phrase: string) => fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rv: <https://rezics.com/vocab/> SELECT ?literal WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      (${iri(unit)} ?score ?literal) text:query (rv:searchBody ${lit(`"${phrase}"`)} 2) . } }`);
    expect((await text('魔法禁书目录')).results?.bindings).toEqual([]);
    expect((await text('魔法禁書目錄')).results?.bindings).toHaveLength(1);
    expect((await fuseki.searchDeltaSince('-1')).available).toBe(true);
    await expect(assertPublicTextReady(fuseki, env.lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);
    server.runner.stop();
    writeFileSync(assembler, current);
    await server.runner.start();
    const expected = repositoryPins(root, dockerEnv, volume);
    assertPinnedState(await inspectFusekiState(server.runner, dockerEnv, fuseki), expected);
    // Stored values alone still agree with RDF, but v1 terms cannot serve v3.
    await expect(assertPublicTextReady(fuseki, env.lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);
    const content = new ContentCore(pool), cursor = new ContentProjectionCursor(pool);
    // Lose the process after quarantine commits but before profile preparation.
    // The next attempt must upgrade the existing job rather than requarantine.
    const command = fuseki.commandWithReceipt.bind(fuseki);
    fuseki.commandWithReceipt = async input => {
      if (input.receipt.includes(':content-rebuild:profile:')) throw new Error('injected profile preparation outage');
      return command(input);
    };
    await expect(quarantinePublicContentSearch(env, content, identity)).rejects.toThrow('injected profile preparation outage');
    fuseki.commandWithReceipt = command;
    const job = await quarantinePublicContentSearch(env, content, identity);
    const readSequence = async () => (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence . } }`))
      .results!.bindings[0]!.sequence!.value;
    const sequence = await readSequence();
    const profileBatch = await readNextMainOutboxBatch(fuseki, identity, '1');
    expect(profileBatch).not.toBeNull();
    expect((await readMainOutboxEnvelope(fuseki, profileBatch!, profileBatch!.eventIds[0]!)).data.receipt)
      .toMatchObject({ action: 'content.rebuild.profile', systemProof: { kind: 'content-rebuild', phase: 'profile' } });
    expect((await quarantinePublicContentSearch(env, content, identity)).cut).toEqual(job.cut);
    expect(await readSequence()).toBe(sequence);
    await expect(assertPublicTextReady(fuseki, env.lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);
    await clearQuarantinedContentUnits(env, job);
    await replayQuarantinedContentCut(env, content, cursor, job);
    const output = await offlineTextIndex(server.runner);
    expect(output).toContain('textindexer');
    expect((await fuseki.searchDeltaSince('-1')).available).toBe(false);
    const generation = await activateRebuiltPublicContentSearch(env, content, cursor, job,
      `g585-public-${identity}`, sha256(output));
    expect(generation).not.toBe(priorGeneration);
    const ready = await assertPublicTextReady(fuseki, env.lineage);
    expect(ready).toMatchObject({ generation, population: 1 });
    const proof = await fuseki.searchDeltaSince('-1');
    expect(proof).toMatchObject({ available: true, generation, qualifiedPopulation: '1' });
    for (const query of ['魔法禁书目录', '魔法禁書目錄', 'がらす', 'ｶﾞﾗｽ', 'rust']) {
      expect((await text(query)).results?.bindings).toEqual([expect.objectContaining({
        literal: expect.objectContaining({ value: original, 'xml:lang': 'zh-Hant' }),
      })]);
    }
    expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} . } }`)).boolean).toBe(true);
  } finally {
    server?.remove();
    // standaloneFuseki can fail before returning its handle.
    if (!server) spawnSync('docker', ['rm', '-f', name], { env: dockerEnv, timeout: 60_000 });
    docker(['volume', 'rm', '-f', volume], dockerEnv, 60_000);
    await pool.end();
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
