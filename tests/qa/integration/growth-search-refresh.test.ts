import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import {
  FusekiClient,
  type SearchDeltaProof,
  type SparqlResult,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import {
  activateTextContribution,
  textContributionDigest,
} from '../../../services/main/src/modules/contribution/draft.ts';
import {
  publishTextContribution,
  textPublicationDigest,
} from '../../../services/main/src/modules/contribution/publish.ts';
import {
  selectMainDefault,
  mainSelectionDigest,
} from '../../../services/main/src/modules/work/select-main.ts';
import { searchRoutes } from '../../../services/main/src/routes/search.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { contextFixture, nativeId } from './context-fixture.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');
function stack(action: 'stack:up' | 'stack:reset', runId: string) {
  const result = spawnSync(
    'bun',
    ['scripts/dev/cli.ts', action, '--profile', 'qa', '--run-id', runId, '--persistent'],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${action} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(
        -2000,
      )}`,
    );
  }
}
async function migrateAccess(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const directory = join(repositoryRoot, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
      await client.query(readFileSync(join(directory, file), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

class MeteredFuseki extends FusekiClient {
  queries = 0;
  inventories = 0;
  deltaCalls = 0;
  deltaChanges = 0;
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    this.queries++;
    if (sparql.includes('"body:*"')) this.inventories++;
    return super.query(sparql, maxResponseBytes);
  }
  override async searchDeltaSince(ordinal: string): Promise<SearchDeltaProof> {
    this.deltaCalls++;
    const result = await super.searchDeltaSince(ordinal);
    this.deltaChanges += result.deltas?.reduce((sum, delta) => sum + delta.changes.length, 0) ?? 0;
    return result;
  }
  counts() {
    return {
      queries: this.queries,
      inventories: this.inventories,
      deltaCalls: this.deltaCalls,
      deltaChanges: this.deltaChanges,
    };
  }
}

test('SEARCH07: native selection refresh stays bounded across corpus, affected-root and author-degree growth', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const runId = `growth-${randomUUID().slice(0, 12)}`;
  stack('stack:up', runId);
  try {
    const apps = readEnv(
      join(stackDirectory(repositoryRoot, { profile: 'qa', runId, persistent: true }), 'apps.env'),
    );
    const meter = new MeteredFuseki(
      apps.FUSEKI_URL!,
      apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!,
    );
    await initializeFreshGraph(meter, {
      dataEpoch: apps.MAIN_DATA_EPOCH!,
      routingEpoch: apps.MAIN_ROUTING_EPOCH!,
    });
    const health = await meter.commandHealth();
    expect(health.moduleVersion).toBe(COMMAND_MODULE_VERSION);
    expect(health.publicSearchDeltaAvailable).toBe(true);
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    const f = await contextFixture(apps);
    f.env.fuseki = meter;
    const accessPolicy = new AccessPolicyOwner(f.accessPool);
    const listMutes = accessPolicy.interactions.listMutes.bind(accessPolicy.interactions);
    let accessReads = 0;
    accessPolicy.interactions.listMutes = async (...args) => {
      accessReads++;
      return listMutes(...args);
    };
    const app = searchRoutes(meter, {
      environment: f.env,
      account: f.account.verifier,
      access: new AccessAdmissionRegistry(f.accessPool),
      accessPolicy,
    } as Parameters<typeof searchRoutes>[1]);
    const targetPhrase = `growth${randomUUID().replaceAll('-', '')}`;
    const authorA = f.actorA,
      authorB = f.actorB;
    type Publication = { contribution: string; decision: string; author: string };
    type Root = {
      work: string;
      main: string;
      head: string | null;
      original: Publication;
      alternate: Publication;
    };
    const admission = (scope: string, action: string, digest: string, author: string) => ({
      ...f.admission(scope, action, digest),
      actingSubject: author,
    });
    async function publication(work: string, author: string, body: string): Promise<Publication> {
      const draftInput = { work, language: 'en', body, actingSubject: author };
      const draft = await activateTextContribution(
        f.env,
        admission(
          `contribution:create:${work}`,
          'contribution.create',
          textContributionDigest(draftInput),
          author,
        ),
        draftInput,
      );
      if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
        throw new Error('growth Contribution draft failed');
      }
      const input = {
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution' as const,
        disclosure: 'public' as const,
        actingSubject: author,
      };
      const published = await publishTextContribution(
        f.env,
        admission(
          `contribution:publish:${draft.contribution}`,
          'contribution.publish',
          textPublicationDigest(input),
          author,
        ),
        input,
      );
      if (published.outcome !== 'succeeded' || !published.publicationDecision) {
        throw new Error('growth Contribution publication failed');
      }
      return { contribution: draft.contribution, decision: published.publicationDecision, author };
    }
    async function select(root: Root, source: Publication) {
      const input = {
        context: { kind: 'main-version-default' as const, id: root.main },
        work: root.work,
        contribution: source.contribution,
        publicationDecision: source.decision,
        expectedSelectionHead: root.head,
        selectionBasis: 'main-maintainer' as const,
        actingSubject: authorA,
      };
      const result = await selectMainDefault(
        f.env,
        admission(
          `publication:select:${root.main}`,
          'publication.select',
          mainSelectionDigest(input),
          authorA,
        ),
        input,
      );
      if (result.outcome !== 'succeeded' || !result.selection || !result.matchUnit) {
        throw new Error('growth Main selection failed');
      }
      root.head = result.selection;
      return result.matchUnit;
    }
    async function root(index: number, sourceAuthor: string, otherAuthor: string): Promise<Root> {
      const created = await f.work(`Search refresh ${index}`);
      if (!created.work || !created.mainVersion) throw new Error('growth Work activation failed');
      const body = index === 0 ? `${targetPhrase} article` : `unrelated${index} article`;
      const original = await publication(created.work, sourceAuthor, body);
      const alternate = await publication(created.work, otherAuthor, body);
      const item: Root = {
        work: created.work,
        main: created.mainVersion,
        head: null,
        original,
        alternate,
      };
      await select(item, original);
      return item;
    }
    async function search(author: string) {
      const response = await app.handle(
        new Request('http://main.local/v1/queries', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${f.account.tokenA}`,
          },
          body: JSON.stringify({
            profile: 'public-main-phrase-v1',
            phrase: targetPhrase,
            language: 'en',
            author,
          }),
        }),
      );
      if (response.status !== 200) {
        throw new Error(`growth search ${response.status}: ${await response.text()}`);
      }
      return response.json() as Promise<{
        complete: boolean;
        total: number;
        population: number;
        results: Array<{ work: string }>;
      }>;
    }
    const samples: Array<{
      axis: 'corpus' | 'degree';
      size: number;
      writeReads: number;
      searchReads: number;
      accessReads: number;
      deltaCalls: number;
      deltaChanges: number;
    }> = [];
    try {
      const target = await root(0, authorA, authorB);
      const unrelated: Root[] = [];
      const measureSwitch = async (axis: 'corpus' | 'degree', size: number) => {
        const before = meter.counts();
        const beforeAccess = accessReads;
        await select(target, target.alternate);
        const afterWrite = meter.counts();
        const oldAuthor = await search(authorA);
        const newAuthor = await search(authorB);
        const afterSearch = meter.counts();
        expect(oldAuthor).toMatchObject({ complete: true, total: 0 });
        expect(newAuthor).toMatchObject({ complete: true, total: 1 });
        expect(newAuthor.results.map((row) => row.work)).toEqual([target.work]);
        expect(afterSearch.inventories - before.inventories).toBe(0);
        const sample = {
          axis,
          size,
          writeReads: afterWrite.queries - before.queries,
          searchReads: afterSearch.queries - afterWrite.queries,
          accessReads: accessReads - beforeAccess,
          deltaCalls: afterSearch.deltaCalls - before.deltaCalls,
          deltaChanges: afterSearch.deltaChanges - before.deltaChanges,
        };
        samples.push(sample);
        expect(sample.deltaCalls).toBe(1);
        expect(sample.deltaChanges).toBe(2);
        expect(sample.accessReads).toBe(4);
        await select(target, target.original);
        expect(await search(authorA)).toMatchObject({ complete: true, total: 1 });
      };
      expect(await search(authorA)).toMatchObject({ complete: true, total: 1 });
      const baselineInventories = meter.inventories;
      expect(baselineInventories).toBe(1);
      await measureSwitch('corpus', 1);
      for (let index = 1; index <= 8; index++) {
        unrelated.push(await root(index, nativeId(), authorA));
        if (index === 2 || index === 8) {
          expect(await search(authorA)).toMatchObject({ complete: true, total: 1 });
          await measureSwitch('corpus', index + 1);
        }
      }
      expect(
        samples.filter((sample) => sample.axis === 'corpus').map((sample) => sample.size),
      ).toEqual([1, 3, 9]);
      for (const degree of [3, 9]) {
        const already = degree === 3 ? 0 : 2;
        for (const item of unrelated.slice(already, degree - 1)) await select(item, item.alternate);
        expect(await search(authorA)).toMatchObject({ complete: true, total: 1 });
        await measureSwitch('degree', degree);
      }
      const sameCost = (axis: 'corpus' | 'degree') => {
        const rows = samples.filter((sample) => sample.axis === axis);
        for (const field of ['writeReads', 'searchReads', 'accessReads'] as const) {
          expect(
            Math.max(...rows.map((row) => row[field])) - Math.min(...rows.map((row) => row[field])),
          ).toBeLessThanOrEqual(2);
        }
      };
      sameCost('corpus');
      sameCost('degree');
      // Seven independent selected roots change while the nine-root corpus stays fixed.
      // Every step must replay only its own old/new native unit, not inventory the corpus.
      const affectedSamples: Array<{
        roots: number;
        deltaCalls: number;
        deltaChanges: number;
        inventories: number;
      }> = [];
      for (const [start, count] of [
        [0, 1],
        [1, 2],
        [3, 4],
      ] as const) {
        const before = meter.counts();
        for (const item of unrelated.slice(start, start + count)) {
          await select(item, item.original);
          expect(await search(authorA)).toMatchObject({ complete: true, total: 1 });
        }
        const after = meter.counts();
        expect(after.inventories - before.inventories).toBe(0);
        expect(after.deltaCalls - before.deltaCalls).toBe(count);
        expect(after.deltaChanges - before.deltaChanges).toBe(2 * count);
        affectedSamples.push({
          roots: count,
          deltaCalls: after.deltaCalls - before.deltaCalls,
          deltaChanges: after.deltaChanges - before.deltaChanges,
          inventories: after.inventories - before.inventories,
        });
      }
      expect(meter.inventories).toBe(baselineInventories);
      if (!Bun.env.REZICS_QA_ARTIFACT_DIR) throw new Error('QA artifact directory is unavailable');
      writeFileSync(
        join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'search-refresh-growth.json'),
        `${JSON.stringify(
          {
            runId,
          source: 'product command-only Fuseki',
          moduleVersion: health.moduleVersion,
          selectionProfileDigest: health.profiles['main-default-selection-v1'],
            corpusSizes: [1, 3, 9],
            authorDegrees: [1, 3, 9],
            baselineInventories,
            samples,
            affectedSamples,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await f.close();
    }
  } finally {
    stack('stack:reset', runId);
  }
}, 240_000);
