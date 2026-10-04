import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import {
  CommandRejected,
  FusekiClient,
  fusekiReadBudget,
  type FusekiReadBudget,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry,
  type RegisteredAdmission,
} from '../../../services/main/src/modules/access/admission.ts';
import {
  activateTextContribution,
  textContributionDigest,
} from '../../../services/main/src/modules/contribution/draft.ts';
import {
  publishTextContribution,
  textPublicationDigest,
} from '../../../services/main/src/modules/contribution/publish.ts';
import { GRAPHS, ID, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import {
  selectMainDefault,
  mainSelectionDigest,
  PUBLIC_SEARCH_GRAPH,
} from '../../../services/main/src/modules/work/select-main.ts';
import {
  MAX_SEARCH_FUSEKI_BYTES,
  MAX_SEARCH_FUSEKI_CALLS,
  MAX_SEARCH_REQUEST_MS,
  MAX_SEARCH_RESPONSE_BYTES,
} from '../../../services/main/src/modules/work/search-readiness.ts';
import { publicUnitAt } from '../../../scripts/fixture/corpus.ts';
import { readManifest } from '../../../scripts/fixture/build.ts';
import { restoreFixture } from '../../../scripts/fixture/restore.ts';
import { workEnvironment } from '../../../scripts/fixture/smoke.ts';
import { dockerEnvironment, root, run } from '../../../scripts/fixture/stack.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { buildRankedFixture, rankedCorpus, rankedFixtureOwners } from './g-556-ranked-fixture.ts';
import { rankedLuceneOracle } from './g-556-ranked-oracle.ts';
import { RANKED_BILINGUAL_MAINS } from '../support/ranked-bilingual-fixture.ts';
import { integrationOrderPrelude } from '../support/integration-order.ts';

interface Page {
  population: number;
  count: { value: number; precision: string };
  next: string | null;
  results: Array<{ work: string; mainVersion: string; score: number }>;
}
class MeasuredFuseki extends FusekiClient {
  budget?: FusekiReadBudget;
  override query(sparql: string, maxResponseBytes?: number) {
    this.budget = fusekiReadBudget.getStore();
    return super.query(sparql, maxResponseBytes);
  }
  override async command(envelope: Parameters<FusekiClient['command']>[0]) {
    const result = await super.command(envelope);
    if (result.status === 'invalid') {
      console.log(`large fixture native validation: ${JSON.stringify(result)}`);
      throw new CommandRejected(result);
    }
    return result;
  }
}

test('G-556: restored >20k units and >2k bilingual phrase matches traverse 200 HTTP results inside every request budget', async () => {
  await integrationOrderPrelude('g-556-ranked');
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR)
    throw new Error('Run through goalctl integration QA');
  const retained = Bun.env.REZICS_G556_RANKED_FIXTURE_ID;
  if (retained && !/^fx-medium-[0-9a-f]{12}$/.test(retained))
    throw new Error('invalid retained ranked fixture ID');
  const fixture = retained ? readManifest(retained) : await buildRankedFixture();
  if (!fixture) throw new Error('retained ranked fixture manifest is missing');
  expect(fixture.entities.publicUnits).toBe(rankedCorpus.publicUnits);
  const target = `fixture-g556-${randomUUID().slice(0, 8)}`;
  const directory = join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'g556-ranked-large');
  mkdirSync(directory, { recursive: true });
  const measurements: Array<{
    page: number;
    milliseconds: number;
    calls: number;
    fusekiBytes: number;
    responseBytes: number;
  }> = [];
  const evidence: Record<string, unknown> = {
    fixture: fixture.id,
    publicUnits: rankedCorpus.publicUnits,
    phrase: 'fixture body',
    bilingualMains: RANKED_BILINGUAL_MAINS,
    pages: measurements,
  };
  let pool: Pool | undefined;
  try {
    const restored = await restoreFixture(fixture.id, target, rankedFixtureOwners);
    evidence.restoreMs = restored.elapsedMs;
    expect(restored.elapsedMs).toBeLessThan(600_000);
    const options = { profile: 'qa' as const, runId: target, persistent: true };
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const fuseki = new MeasuredFuseki(
      apps.FUSEKI_URL!,
      apps.FUSEKI_MAINTENANCE_TOKEN,
      apps.FUSEKI_COMMAND_TOKEN,
    );
    const env = { ...workEnvironment(apps, fixture.lineage), fuseki };
    pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const app = createMainApp(fuseki, {
      environment: env,
      access: new AccessAdmissionRegistry(pool),
      account: {
        verify: async () => {
          throw new Error('anonymous catalogue read');
        },
      },
    });
    const actor = ID + randomUUID();
    function admission(scope: string, action: string, requestDigest: string): RegisteredAdmission {
      const id = randomUUID();
      return {
        id,
        principalId: randomUUID(),
        actingSubject: actor,
        scope,
        action,
        idempotencyKey: `g556-${id}`,
        requestDigest,
        authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        state: 'claimed',
        dispatchEligible: true,
        replayed: false,
      };
    }
    async function addLanguage(ordinal: number) {
      const source = publicUnitAt(rankedCorpus, ordinal);
      const draftInput = {
        work: source.work.work,
        language: 'fr',
        body: 'fixture body',
        actingSubject: actor,
      };
      const draft = await activateTextContribution(
        env,
        admission(
          `contribution:create:${source.work.work}`,
          'contribution.create',
          textContributionDigest(draftInput),
        ),
        draftInput,
      );
      if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision)
        throw new Error('bilingual draft failed');
      const publicationInput = {
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution' as const,
        disclosure: 'public' as const,
        actingSubject: actor,
      };
      const publication = await publishTextContribution(
        env,
        admission(
          `contribution:publish:${draft.contribution}`,
          'contribution.publish',
          textPublicationDigest(publicationInput),
        ),
        publicationInput,
      );
      if (publication.outcome !== 'succeeded' || !publication.publicationDecision)
        throw new Error('bilingual publication failed');
      const selectionInput = {
        context: { kind: 'main-version-default' as const, id: source.work.mainVersion },
        work: source.work.work,
        contribution: draft.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const,
        actingSubject: actor,
      };
      const selected = await selectMainDefault(
        env,
        admission(
          `publication:select:${source.work.mainVersion}`,
          'publication.select',
          mainSelectionDigest(selectionInput),
        ),
        selectionInput,
      );
      if (selected.outcome !== 'succeeded') throw new Error('bilingual selection failed');
    }
    const preparationStart = performance.now();
    const bilingual =
      await fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(DISTINCT ?main) AS ?n) WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?first, ?french }
      GRAPH ${iri(GRAPHS.revisions)} { ?first rv:language ?language . ?french rv:language "fr" . FILTER(?language != "fr") }
    }`);
    expect(Number(bilingual.results?.bindings[0]?.n?.value)).toBe(RANKED_BILINGUAL_MAINS);
    evidence.bilingualPreparationMs = performance.now() - preparationStart;
    expect(Number(evidence.bilingualPreparationMs) + restored.elapsedMs!).toBeLessThan(600_000);

    const traversed: string[] = [];
    let cursor: string | undefined;
    const read = (continuation?: string) =>
      app.handle(
        new Request(
          `http://main.local/v1/search/catalogue?q=fixture%20body&limit=20` +
            (continuation ? `&cursor=${encodeURIComponent(continuation)}` : ''),
        ),
      );
    for (let n = 0; n < 10; n++) {
      const start = performance.now();
      const response = await read(cursor);
      const milliseconds = performance.now() - start;
      if (response.status !== 200)
        throw new Error(`large ranked page ${n}: ${response.status} ${await response.text()}`);
      const text = await response.text(),
        page = JSON.parse(text) as Page;
      const calls = MAX_SEARCH_FUSEKI_CALLS - fuseki.budget!.callsLeft;
      const fusekiBytes = MAX_SEARCH_FUSEKI_BYTES - fuseki.budget!.bytesLeft;
      const responseBytes = Buffer.byteLength(text);
      measurements.push({ page: n + 1, milliseconds, calls, fusekiBytes, responseBytes });
      expect(milliseconds).toBeLessThan(MAX_SEARCH_REQUEST_MS);
      expect(calls).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_CALLS);
      expect(fusekiBytes).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_BYTES);
      expect(responseBytes).toBeLessThanOrEqual(MAX_SEARCH_RESPONSE_BYTES);
      expect(page.population).toBeGreaterThan(20_000);
      expect(page.results).toHaveLength(20);
      expect(page.count).toEqual({ value: (n + 1) * 20, precision: 'lower-bound' });
      traversed.push(...page.results.map((row) => row.mainVersion));
      expect(page.results.every((row) => Number.isFinite(row.score))).toBe(true);
      expect(page.next).toBeString();
      cursor = page.next!;
    }
    // The independent unpaged reader preserves Lucene's score/doc tie order.
    // All imported selections are current and public; the first occurrence is
    // the best group witness, including its second selected language. Read it
    // after the measured pages, so it cannot warm those requests.
    const oracle = rankedLuceneOracle(target);
    const raw = oracle.hits;
    evidence.oracleCommit = oracle.commit;
    expect(raw).toHaveLength(1000);
    const identities = await fuseki.query(
      `PREFIX rv: <${RV}> SELECT ?unit ?main WHERE {
      VALUES ?unit { ${raw.map((row) => iri(row.id)).join(' ')} }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:mainVersion ?main ; rv:context ?main . }
    }`,
      1_048_576,
    );
    const mains = new Map(
      (identities.results?.bindings ?? []).map((row) => [row.unit!.value, row.main!.value]),
    );
    expect(mains.size).toBe(new Set(raw.map((row) => row.id)).size);
    const expected = [...new Set(raw.map((row) => mains.get(row.id)!))].slice(0, 200);
    expect(expected).toHaveLength(200);
    const phrasePopulation =
      await fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(?unit) AS ?n) WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:searchBody ?body .
        FILTER(CONTAINS(STR(?body), "fixture body")) } }`);
    evidence.phraseMatches = Number(phrasePopulation.results?.bindings[0]?.n?.value);
    expect(Number(evidence.phraseMatches)).toBeGreaterThan(2000);
    expect(new Set(traversed).size).toBe(200);
    expect(traversed).toEqual(expected);
    evidence.traversed = traversed;
    // Imported authored names use the same new catalogue tier as native writes.
    // The independent reader must include it, rather than accidentally proving
    // only the old body index against a fixture with no projected title fields.
    const titleResponse = await app.handle(
      new Request('http://main.local/v1/search/catalogue?q=fixture&limit=20'),
    );
    expect(titleResponse.status, await titleResponse.clone().text()).toBe(200);
    const titlePage = (await titleResponse.json()) as Page;
    const titleOracle = rankedLuceneOracle(target, 'fixture');
    expect(titleOracle.hits).toHaveLength(1000);
    const titleIdentities = await fuseki.query(
      `PREFIX rv: <${RV}> SELECT ?unit ?main WHERE {
      VALUES ?unit { ${titleOracle.hits.map((row) => iri(row.id)).join(' ')} }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:mainVersion ?main ; rv:context ?main . }
    }`,
      1_048_576,
    );
    const titleMains = new Map(
      (titleIdentities.results?.bindings ?? []).map((row) => [row.unit!.value, row.main!.value]),
    );
    expect(titleMains.size).toBe(new Set(titleOracle.hits.map((row) => row.id)).size);
    expect(titlePage.results).toHaveLength(20);
    expect(titlePage.results.every((row) => row.score === 1_000_000)).toBe(true);
    expect(titlePage.results.map((row) => row.mainVersion)).toEqual(
      [...new Set(titleOracle.hits.map((row) => titleMains.get(row.id)!))].slice(0, 20),
    );
    evidence.titleTier = { results: titlePage.results.length, oracleCommit: titleOracle.commit };
    await addLanguage(1225);
    const stale = await read(cursor);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'search_restart_required' });
    evidence.writeRestart = 409;
    console.log(`G-556 large fixture: ${JSON.stringify(measurements)}`);
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (pool) await pool.end();
    const stack = stackDirectory(resolve(import.meta.dir, '../../..'), {
      profile: 'qa',
      runId: target,
      persistent: true,
    });
    if (readFileSyncSafe(join(stack, 'compose.env'))) {
      run(
        'bun',
        [
          'scripts/dev/cli.ts',
          'stack:reset',
          '--profile',
          'qa',
          '--run-id',
          target,
          '--persistent',
        ],
        dockerEnvironment(),
        120_000,
      );
    }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}, 470_000);

function readFileSyncSafe(path: string) {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
