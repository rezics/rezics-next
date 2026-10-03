import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { saveAdmittedContentDraft } from '../../../services/main/src/modules/content-publication/draft.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch }
  from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDigest, publishPinnedContent }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { ContentProjectionUnavailable, relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { DATASET, GRAPHS, RV, initializeFreshGraph, iri, lit }
  from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady, assertSameTextInstance, assertSnapshotMoved,
  SearchIndexUnavailable, SearchSnapshotMoved }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { composeProcessEnvironment, projectName, readEnv, stackDirectory }
  from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');
const LUCENE = '/fuseki/databases/rezics/lucene';
const LUCENE_BEFORE_COMMIT = '/fuseki/databases/rezics/lucene-search15';

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync(...scriptCommand(args), { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 4_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-4000)}`);
  }
  return result.stdout;
}

async function migrateAccess(url: string): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const directory = join(root, 'services/main/migrations/access');
    for (const file of schemaFiles(root, 'access')) {
      await db.query(readFileSync(join(directory, file), 'utf8'));
    }
  } finally { await db.end(); }
}

test('SEARCH15/OPS16: a crash between the TDB2 and Lucene commits suspends search until rebuild', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated fault/recovery QA tier');
  }
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-pc`;
  const options = { profile: 'qa' as const, runId, persistent: true, rawUpdate: false };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent'];
  const stack = stackDirectory(root, options);
  const compose = (args: string[]): void => {
    const saved = readEnv(join(stack, 'compose.env'));
    const result = spawnSync('docker', ['compose', '--env-file', join(stack, 'compose.env'),
      '-f', join(root, 'infra/dev/compose.yaml'), '--project-name', projectName(options), ...args],
    { cwd: root, env: composeProcessEnvironment(loadDockerEnvironment(), saved),
      encoding: 'utf8', timeout: 180_000, maxBuffer: 4_000_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`docker compose ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
    }
  };
  const offline = (script: string) => compose(['run', '--rm', '--no-deps', '--entrypoint', 'sh',
    'fuseki', '-ec', script]);
  const startedAt = Date.now();
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(join(stack, 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    try {
      await migrateContent(contentPool);
      const content = new ContentCore(contentPool);
      const cursor = new ContentProjectionCursor(contentPool);
      const consumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
      const env = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
      const corpus = await seedRecoveryContent(env, contentPool, accessPool);
      const access = new AccessAdmissionRegistry(accessPool);
      const relayTo = async (target: string, reader = consumer) => {
        const dispositions: string[] = [];
        for (let i = 0; i < 10 && (await cursor.read(reader)).sequence !== target; i++) {
          const next = await relayContentProjectionOnce(env, content, cursor, reader);
          if (!next) throw new Error('Content outbox stopped before source cut');
          dispositions.push(next.disposition);
        }
        expect((await cursor.read(reader)).sequence).toBe(target);
        return dispositions;
      };
      const cut = await content.ownerPosition();
      await cursor.initialize(consumer);
      await relayTo(cut.sequence);
      const oldInput = { phrase: 'exact content beacon', language: 'en' };
      const before = await queryPublicContentPhrase(env, content, cursor, consumer, oldInput);
      expect(before).toMatchObject({ complete: true, total: 1 });

      // Retain the last complete Lucene commit before the replacement projection.
      compose(['stop', 'fuseki']);
      offline(`rm -rf ${LUCENE_BEFORE_COMMIT} && cp -a ${LUCENE} ${LUCENE_BEFORE_COMMIT}`);
      compose(['up', '-d', '--wait', 'fuseki']);
      const restarted = await queryPublicContentPhrase(env, content, cursor, consumer, oldInput);
      expect(restarted).toMatchObject({ complete: true, total: 1,
        results: [{ matchUnit: before.results[0]!.matchUnit }] });

      // An author-admitted replacement commits in PostgreSQL, then becomes the
      // graph publication and public eligibility head before projection.
      const replacementBody = 'replacement crash lantern';
      const newInput = { phrase: replacementBody, language: 'en' };
      const nextDraft = await saveAdmittedContentDraft(env, content,
        { verify: async () => corpus.content.principal }, access,
        new Request('http://main.local/v1/content-drafts', {
          method: 'POST', headers: { authorization: 'Bearer qa' } }),
        { resourceId: corpus.works[0]!, variant: { id: corpus.content.variantId,
          resourceId: corpus.works[0]!,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: corpus.content.revisionId, body: replacementBody,
        actingSubject: corpus.content.actingSubject,
        idempotencyKey: `crash-replacement-${randomUUID()}` });
      expect(nextDraft.outcome).toBe('succeeded');
      if (!nextDraft.revisionId) throw new Error('replacement Content revision is absent');
      const nextExact = (await content.readExactBatch([nextDraft.revisionId],
        async ids => new Set(ids)))[0];
      if (nextExact?.status !== 'available') throw new Error('replacement Content bytes are unavailable');
      const publicationInput = { preparationId: `crash-replacement-${randomUUID()}`,
        revisionId: nextDraft.revisionId, expectedDigest: nextExact.reference.byteDigest,
        expectedContentEpoch: nextDraft.position.dataEpoch,
        resourceId: corpus.works[0]!, variantId: corpus.content.variantId,
        expectedPublicationHead: corpus.content.publicationDecision };
      const publicationDigest = contentPublicationDigest(publicationInput);
      const registeredPublication = await access.register({ principal: corpus.content.principal,
        actingSubject: corpus.content.actingSubject,
        scope: `content:publish:${corpus.content.variantId}`, action: 'content.publish',
        idempotencyKey: `crash-publish-${randomUUID()}`, requestDigest: publicationDigest });
      const nextPublication = await publishPinnedContent(env, content,
        await access.claim(registeredPublication.id, publicationDigest), publicationInput);
      expect(nextPublication.status).toBe('active');
      if (!nextPublication.decision) throw new Error('replacement publication decision is absent');
      const eligibilityInput = { resourceId: corpus.works[0]!, variantId: corpus.content.variantId,
        publicationDecision: nextPublication.decision,
        expectedEligibilityHead: corpus.content.eligibilityDecision,
        actingSubject: corpus.content.actingSubject,
        rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
      const eligibilityDigest = contentSearchEligibilityDigest(eligibilityInput);
      const registeredEligibility = await access.register({ principal: corpus.content.principal,
        actingSubject: corpus.content.actingSubject,
        scope: `content:search-eligibility:${corpus.content.variantId}`,
        action: 'content.search-eligibility', idempotencyKey: `crash-eligibility-${randomUUID()}`,
        requestDigest: eligibilityDigest });
      expect((await selectPublicContentSearch(env, content, access,
        await access.claim(registeredEligibility.id, eligibilityDigest), eligibilityInput)).outcome)
        .toBe('succeeded');
      await expect(queryPublicContentPhrase(env, content, cursor, consumer, oldInput))
        .rejects.toBeInstanceOf(ContentProjectionUnavailable);

      // A reader pinned before the replacement MatchUnit literal changes cannot
      // qualify the later graph and index state as its own complete result.
      const pinned = await assertPublicTextReady(fuseki, lineage);
      const changedCut = await content.ownerPosition();
      expect((await relayTo(changedCut.sequence)).filter(value => value === 'projected')).toHaveLength(1);
      await expect(assertSameTextInstance(fuseki, pinned)).rejects.toBeInstanceOf(SearchSnapshotMoved);
      await expect(assertSnapshotMoved(fuseki, pinned)).rejects.toBeInstanceOf(SearchSnapshotMoved);
      const committed = await queryPublicContentPhrase(env, content, cursor, consumer, newInput);
      expect(committed).toMatchObject({ complete: true, total: 1,
        results: [{ revision: `urn:rezics:content:revision:${nextDraft.revisionId}` }] });
      const newUnit = committed.results[0]!.matchUnit;
      const oldUnit = before.results[0]!.matchUnit;
      const sequenceBeforeCrash = committed.graphPosition.sequence;

      // jena-text prepares Lucene, commits TDB2, then completes the Lucene
      // commit. Kill the JVM and leave the index at its last completed commit:
      // the durable state after a crash inside that window.
      compose(['kill', '-s', 'SIGKILL', 'fuseki']);
      offline(`test -d ${LUCENE_BEFORE_COMMIT} && rm -rf ${LUCENE} && mv ${LUCENE_BEFORE_COMMIT} ${LUCENE}`);
      compose(['up', '-d', '--wait', 'fuseki']);
      const graphAfterCrash = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n . } }`);
      expect(graphAfterCrash.results?.bindings[0]?.n?.value).toBe(sequenceBeforeCrash);
      const unitRdf = async (unit: string) => (await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(unit)} a rv:MatchUnit . } }`)).boolean;
      expect(await unitRdf(newUnit)).toBe(true);
      expect(await unitRdf(oldUnit)).toBe(false);
      const indexed = async (phrase: string) => (await fuseki.query(`PREFIX rv: <${RV}>
        PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(`"${phrase}"`)} 10) . } }`))
        .results?.bindings.map(row => row.unit?.value) ?? [];
      expect(await indexed(replacementBody)).toEqual([]);
      expect(await indexed(oldInput.phrase)).toEqual([oldUnit]);

      // Every public reader stays unavailable; none reports a complete empty or old body.
      await expect(assertPublicTextReady(fuseki, lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);
      await expect(queryPublicContentPhrase(env, content, cursor, consumer, newInput))
        .rejects.toBeInstanceOf(SearchIndexUnavailable);
      await expect(queryPublicContentPhrase(env, content, cursor, consumer, oldInput))
        .rejects.toBeInstanceOf(SearchIndexUnavailable);
      const app = createMainApp(fuseki, { environment: env,
        account: { verify: async () => corpus.content.principal }, access, content,
        contentAuthoring: content, contentProjection: { content, cursor, consumer } });
      const publicQuery = (input: { phrase: string; language: string }) => app.handle(new Request(
        'http://main.local/v1/queries', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profile: 'public-content-phrase-v1', ...input }) }));
      for (const input of [newInput, oldInput]) {
        const response = await publicQuery(input);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'search_index_unavailable' });
      }
      expect((await app.handle(new Request('http://main.local/health/search-ready'))).status).toBe(503);

      // A duplicate relay pass finds the exact projection receipt; it cannot
      // repair or mask the lost index commit.
      const duplicate = `crash-duplicate-${randomUUID()}`;
      await cursor.initialize(duplicate);
      const replayed = await relayTo(changedCut.sequence, duplicate);
      expect(replayed.filter(value => value === 'projected')).toHaveLength(1);
      expect(replayed.filter(value => value === 'superseded')).toHaveLength(1);
      const graphAfterReplay = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n . } }`);
      expect(graphAfterReplay.results?.bindings[0]?.n?.value).toBe(sequenceBeforeCrash);
      await expect(queryPublicContentPhrase(env, content, cursor, consumer, newInput))
        .rejects.toBeInstanceOf(SearchIndexUnavailable);

      const operation = rootCommand(['search:rebuild', ...stackArgs], 420_000);
      const result = JSON.parse(operation.trim().split(/\r?\n/).at(-1) ?? '') as { job: string;
        removed: number; replayed: number; generation: string; logPath: string };
      expect(result.removed).toBe(1);
      expect(result.replayed).toBeGreaterThan(0);
      expect(result.generation).not.toBe(committed.indexGeneration);
      expect(readFileSync(result.logPath, 'utf8')).toMatch(/textindexer\s+::\s+\d+ \(\d+ per second\) properties indexed/);
      const after = await queryPublicContentPhrase(env, content, cursor, consumer, newInput);
      expect(after).toMatchObject({ complete: true, total: 1, population: 1,
        indexGeneration: result.generation, contentPosition: changedCut,
        results: [{ resource: committed.results[0]!.resource,
          variant: committed.results[0]!.variant, revision: committed.results[0]!.revision }] });
      const old = await queryPublicContentPhrase(env, content, cursor, consumer, oldInput);
      expect(old).toMatchObject({ complete: true, total: 0 });
      expect(await indexed(oldInput.phrase)).toEqual([]);
      const served = await publicQuery(newInput);
      expect(served.status).toBe(200);
      expect(await served.json()).toMatchObject({ complete: true, total: 1,
        results: [{ revision: committed.results[0]!.revision }] });
      expect((await app.handle(new Request('http://main.local/health/search-ready'))).status).toBe(200);
      writeFileSync(join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'content-projection-crash.json'),
        JSON.stringify({ runId, job: result.job, pinned, sequenceBeforeCrash,
          oldUnit, newUnit, contentCut: changedCut, oldGeneration: committed.indexGeneration,
          newGeneration: result.generation, removed: result.removed, replayed: result.replayed,
          elapsedMs: Date.now() - startedAt, result: after.results[0] }, null, 2) + '\n');
    } finally {
      await Promise.all([contentPool.end(), accessPool.end()]);
    }
  } finally {
    if (started) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 600_000);
