import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  flushTelemetryTraces,
  shutdownTelemetry,
  startTelemetry,
} from '@rezics/observability/runtime';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { STRUCTURE_LIMITS } from '../../../services/main/src/modules/structure/format.ts';
import {
  RECIPE_WORK_PAGE_OCCURRENCES,
  RECIPE_WORK_PAGE_READ_BOUND,
} from '../../../services/main/src/modules/recipe/work-page.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { createCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import {
  prepareWorkProfileCorpus,
  restoreWorkProfileCorpus,
  workProfileCorpusApi,
  WORK_PROFILE_SCALES,
  type CorpusApi,
  type CorpusDimensions,
  type WorkProfileCorpusRecipe,
} from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkProfile,
} from '../support/work-profile.ts';
import type { MediaStack } from './media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type PublicWork = Awaited<ReturnType<typeof seedPublicProfileWork>>;
type RecipePage = {
  profile: 'recipe-work-page-v1';
  structure: string;
  revision: string;
  occurrences: Array<{ occurrence: string; role: string }>;
  ingredients: Array<{ occurrence: string }>;
  next?: string;
  cost: { pages: number; pagesRead: number; occurrences: number };
};

const fixedDimensions: CorpusDimensions = {
  unrelatedWorks: 0,
  unrelatedPosts: 0,
  follows: 0,
  memberships: 0,
  historyDepth: 0,
  realmSize: 0,
  conceptVocabulary: 0,
};
const recipeVersion = 'recipe-work-page-growth-v1';
const sectionCount = STRUCTURE_LIMITS.maxDepth - 1;
const ingredientCount = 100;
const stepCount = 20;
const recipeOccurrenceCount = sectionCount + ingredientCount + stepCount;
const shortId = (value: string) => value.slice(-36);

// The route walks only the Work basis and its Structure composition. It never reads Content posts,
// so unrelatedPosts cannot be scanned by this operation and stays outside this probe.
const recipePageCost: WorkCostContract = {
  fusekiRequests: RECIPE_WORK_PAGE_READ_BOUND * 4 + 16,
  fusekiSentBytes: 1_048_576,
  fusekiReceivedBytes: 16_777_216,
  postgresStatements: 256,
  accountCalls: 0,
  otherFetches: 0,
  unclassifiedFetches: 0,
  growth: {
    fusekiRequests: { class: 'constant', dimension: 'mainCalls' },
    fusekiSentBytes: { class: 'constant', dimension: 'mainCalls' },
    fusekiReceivedBytes: { class: 'constant', dimension: 'mainCalls' },
    postgresStatements: { class: 'constant', dimension: 'mainCalls' },
    accountCalls: { class: 'constant', dimension: 'mainCalls' },
    otherFetches: { class: 'constant', dimension: 'mainCalls' },
    unclassifiedFetches: { class: 'constant', dimension: 'mainCalls' },
  },
};

function ingredient(text: string, parent: string) {
  return {
    op: 'insert',
    parent,
    position: 'last',
    role: 'ingredient',
    qualifier: {
      type: 'ingredient-line',
      originalText: { value: text, language: 'en' },
      amountLexical: '1',
      amount: { numerator: 1, denominator: 1 },
      unitText: 'cup',
      optional: false,
      scaling: 'linear',
      substituteFor: [],
      parseStatus: 'parsed',
    },
  };
}

function step(text: string, parent: string) {
  return {
    op: 'insert',
    parent,
    position: 'last',
    role: 'step',
    qualifier: {
      type: 'recipe-step',
      instructionText: { value: text, language: 'en' },
      usesIngredient: [],
      media: [],
      scaling: 'linear',
    },
  };
}

async function grantForRecipeActor(
  stack: MediaStack,
  member: Member,
  actor: string,
  scope: string,
  action: string,
) {
  await grantFixtureAuthority(stack.accessPool, {
    scope,
    requireDispatch: true,
    representations: [
      { principalId: member.principalId, actor, action, lifetime: '8 hours' },
    ],
    grant: { actor, action, lifetime: '8 hours' },
  });
}

function recipePagePath(work: string, actor: string, cursor?: string) {
  const url = new URL(`/v1/recipes/works/${shortId(work)}`, 'http://main.local');
  url.searchParams.set('actingSubject', actor);
  if (cursor) url.searchParams.set('cursor', cursor);
  return url;
}

function reportedCounters(profile: WorkProfile, observedMainCalls: number | null) {
  return {
    mainCalls: observedMainCalls,
    fusekiRequests: profile.fusekiRequests,
    fusekiSentBytes: profile.fusekiSentBytes,
    fusekiReceivedBytes: profile.fusekiReceivedBytes,
    fusekiEngineMs: profile.fusekiEngineMs,
    postgresStatements: profile.postgresStatements,
    accountCalls: profile.accountCalls,
    otherFetches: profile.otherFetches,
    unclassifiedFetches: profile.unclassifiedFetches,
  };
}

test(
  'Recipe Work page counters stay constant as unrelated Works grow at the first and deepest continuation pages',
  async () => {
    const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
    if (!sourceRunId || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL)
      throw new Error('Run through goalctl integration QA');
    const sourceDirectory = join(root, '.temp/stack', `rezics-qa-${sourceRunId}`);
    if (readEnv(join(sourceDirectory, 'compose.env')).REZICS_STACK_STORAGE !== 'persistent')
      throw new Error('Recipe page growth needs the persistent catalogue-disk QA project');

    const sink = startWorkProfileSink({ settleMs: 25 });
    startTelemetry('recipe-page-growth', { ...process.env, ...sink.env });
    const { startMediaStack } = await import('./media-support.ts');
    let source: MediaStack | undefined;
    let sourceRelay: Pool | undefined;
    let sourceMember: Member | undefined;
    let sourceApi: CorpusApi | undefined;
    let restoreStack: MediaStack | undefined;
    let restoreMember: Member | undefined;
    let restoreFusekiUrl: string | undefined;
    let recipeActor = '';
    let recipeWork = '';
    let recipeMainVersion = '';
    let recipeStructure = '';
    let expectedWorkCount = 0;
    const works: PublicWork[] = [];
    const restoreTargets: string[] = [];
    const sizes = { small: 4, medium: 16, large: 64 } as const;
    const measured = {
      firstPage: [] as WorkProfile[],
      deepContinuation: [] as WorkProfile[],
    };
    const corpusDirectory = join(root, '.temp/work-profiles', `recipe-page-growth-${sourceRunId}`);
    mkdirSync(corpusDirectory, { recursive: true });

    const apiFor = (stack: MediaStack, token: string) => workProfileCorpusApi('http://main.local', token, {
      fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
    });
    const sourceClient: CorpusApi = {
      command: (key, command, signal) => {
        if (!sourceApi) throw new Error('Recipe corpus source is not open');
        return sourceApi.command(key, command, signal);
      },
      read: (path, signal) => {
        if (!sourceApi) throw new Error('Recipe corpus source is not open');
        return sourceApi.read(path, signal);
      },
    };
    const openSource = async () => {
      source = await startMediaStack('recipe-page-growth-source', { library: true });
      sourceRelay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
      await initializeRelayCheckpoint(
        sourceRelay,
        Bun.env.MAIN_RELAY_CONSUMER!,
        source.env.lineage.dataEpoch,
      );
      sourceMember = await source.member('recipe-page-growth-author', {
        stable: true,
        verified: true,
      });
      sourceApi = apiFor(source, sourceMember.token);
    };

    const recipe: WorkProfileCorpusRecipe = {
      version: recipeVersion,
      fixed: fixedDimensions,
      async initialize(client, key) {
        if (recipeWork) return;
        if (!source || !sourceMember) throw new Error('Recipe corpus source is not open');
        const author = await client.command<{ agent: string }>(`${key}:author`, {
          method: 'POST',
          path: '/v1/agents',
          body: {
            profile: 'agent-provision-v1',
            kind: 'person',
            displayName: 'Recipe page growth author',
          },
        });
        recipeActor = author.agent;
        await grantForRecipeActor(source, sourceMember, recipeActor, 'work:create:root', 'work.create');
        const created = await client.command<{ work: string; mainVersion: string }>(
          `${key}:recipe-work`,
          {
            method: 'POST',
            path: '/v1/works',
            body: {
              profile: 'metadata-only-v1',
              authoring: 'own-work',
              title: 'Recipe page growth fixture',
              language: 'en',
              semanticTypes: ['https://schema.org/Recipe'],
              actingSubject: recipeActor,
            },
          },
        );
        recipeWork = created.work;
        recipeMainVersion = created.mainVersion;
        await grantForRecipeActor(
          source,
          sourceMember,
          recipeActor,
          `work:edit:${recipeWork}`,
          'recipe.edit',
        );
        await grantForRecipeActor(
          source,
          sourceMember,
          recipeActor,
          `work:read:${recipeWork}`,
          'work.read',
        );

        const composition = await client.command<{ structure: string; revision: string }>(
          `${key}:composition`,
          {
            method: 'POST',
            path: '/v1/compositions',
            body: {
              profile: 'recipe-composition',
              work: recipeWork,
              mainVersion: recipeMainVersion,
              actingSubject: recipeActor,
            },
          },
        );
        recipeStructure = composition.structure;
        let revision = composition.revision;
        let parent = recipeStructure;
        for (let depth = 0; depth < sectionCount; depth++) {
          const changed = await client.command<{ revision: string; occurrences: string[] }>(
            `${key}:section:${depth}`,
            {
              method: 'POST',
              path: `/v1/compositions/${shortId(recipeStructure)}/changes`,
              body: {
                profile: 'recipe-composition',
                expectedHead: revision,
                actingSubject: recipeActor,
                operations: [
                  {
                    op: 'insert',
                    parent,
                    position: 'last',
                    role: 'group',
                    label: { value: `Section ${depth + 1}`, language: 'en' },
                  },
                ],
              },
            },
          );
          expect(changed.occurrences).toHaveLength(1);
          revision = changed.revision;
          parent = changed.occurrences[0]!;
        }
        const leaves = [
          ...Array.from({ length: ingredientCount }, (_, index) =>
            ingredient(`1 cup flour ${index + 1}`, parent),
          ),
          ...Array.from({ length: stepCount }, (_, index) =>
            step(`Mix ingredients for step ${index + 1}.`, parent),
          ),
        ];
        for (let offset = 0; offset < leaves.length; offset += 16) {
          const operations = leaves.slice(offset, offset + 16);
          const changed = await client.command<{ revision: string; occurrences: string[] }>(
            `${key}:recipe-leaves:${offset}`,
            {
              method: 'POST',
              path: `/v1/compositions/${shortId(recipeStructure)}/changes`,
              body: {
                profile: 'recipe-composition',
                expectedHead: revision,
                actingSubject: recipeActor,
                operations,
              },
            },
          );
          expect(changed.occurrences).toHaveLength(operations.length);
          revision = changed.revision;
        }
      },
      async grow(client, dimension, index, key) {
        expect(dimension).toBe('unrelatedWorks');
        if (works[index]) return;
        if (!recipeActor) throw new Error('Recipe author was not initialized');
        works[index] = await seedPublicProfileWork(client, key, {
          actingSubject: recipeActor,
          title: `Recipe page growth unrelated Work ${index}`,
          body: `Recipe page growth unrelated Work selected text ${index}`,
        });
        expectedWorkCount = Math.max(expectedWorkCount, index + 1);
      },
      async verify(client) {
        if (!recipeActor || !recipeWork) throw new Error('Recipe corpus target is absent');
        const expectedWorks = works.slice(0, expectedWorkCount);
        expect(expectedWorks).toHaveLength(expectedWorkCount);
        expect(new Set(expectedWorks.map((work) => work.work)).size).toBe(expectedWorkCount);
        for (const [index, created] of expectedWorks.entries()) {
          const selected = await client.read<{
            work: string;
            mainVersion: string;
            contribution: string;
            selectedDraft: string;
            body: string;
          }>(`/v1/main-versions/${shortId(created.mainVersion)}/selection?language=en`);
          expect(selected).toMatchObject({
            work: created.work,
            mainVersion: created.mainVersion,
            contribution: created.contribution,
            selectedDraft: created.draftRevision,
            body: `Recipe page growth unrelated Work selected text ${index}`,
          });
        }
        const first = await client.read<RecipePage>(
          recipePagePath(recipeWork, recipeActor).pathname + recipePagePath(recipeWork, recipeActor).search,
        );
        expect(first.profile).toBe('recipe-work-page-v1');
        expect(first.occurrences).toHaveLength(RECIPE_WORK_PAGE_OCCURRENCES);
        expect(first.next).toBeString();
        const continuation = await client.read<RecipePage>(
          recipePagePath(recipeWork, recipeActor, first.next).pathname +
            recipePagePath(recipeWork, recipeActor, first.next).search,
        );
        expect(continuation.occurrences).toHaveLength(recipeOccurrenceCount - RECIPE_WORK_PAGE_OCCURRENCES);
        expect(continuation.cost.pages).toBeGreaterThan(STRUCTURE_LIMITS.maxDepth);
        return { ...fixedDimensions, unrelatedWorks: expectedWorkCount };
      },
    };

    let nextRestoreExpectedWorks = 0;
    const backupDriverOptions = {
      sourceRunId,
      directory: join(corpusDirectory, 'backups'),
      resumeSource: true,
      async quiesce(signal: AbortSignal) {
        signal.throwIfAborted();
        const stopped = source;
        const relay = sourceRelay;
        source = undefined;
        sourceRelay = undefined;
        sourceApi = undefined;
        sourceMember = undefined;
        await Promise.all([stopped?.stop(), relay?.end()]);
        return async () => openSource();
      },
      async smokeRead(input: {
        target: string;
        runId: string;
        apps: Record<string, string>;
        signal: AbortSignal;
      }) {
        const env = {
          ...input.apps,
          REZICS_QA_RUN_ID: input.runId,
          REZICS_QA_STACK_MODE: 'scale',
          REZICS_QA_STACK_TIER: 'integration',
          REZICS_STACK_PROFILE: 'qa',
        };
        const previous = new Map(Object.keys(env).map((key) => [key, Bun.env[key]]));
        Object.assign(Bun.env, env);
        try {
          restoreStack = await startMediaStack('recipe-page-growth-copy', {
            library: true,
            ownerUrls: {
              access: input.apps.ACCESS_DATABASE_URL!,
              content: input.apps.CONTENT_DATABASE_URL!,
              relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
            },
          });
          restoreFusekiUrl = input.apps.FUSEKI_URL;
          restoreMember = await restoreStack.member('recipe-page-growth-author', {
            stable: true,
            verified: true,
          });
          const restoredApi = apiFor(restoreStack, restoreMember.token);
          expectedWorkCount = nextRestoreExpectedWorks;
          expect(await recipe.verify(restoredApi)).toEqual({
            ...fixedDimensions,
            unrelatedWorks: nextRestoreExpectedWorks,
          });
          input.signal.throwIfAborted();
          return async () => {
            const stopped = restoreStack;
            restoreStack = undefined;
            restoreMember = undefined;
            restoreFusekiUrl = undefined;
            await stopped?.stop();
          };
        } catch (error) {
          const stopped = restoreStack;
          restoreStack = undefined;
          restoreMember = undefined;
          restoreFusekiUrl = undefined;
          await stopped?.stop();
          throw error;
        } finally {
          for (const [key, value] of previous) {
            if (value === undefined) delete Bun.env[key];
            else Bun.env[key] = value;
          }
        }
      },
    };
    const backupDriver = createCorpusBackupDriver(backupDriverOptions);

    const measuredPage = async (cursor: string | undefined, scale: number) => {
      if (!restoreStack || !restoreMember || !restoreFusekiUrl || !recipeWork || !recipeActor)
        throw new Error('Restored Recipe page fixture is unavailable');
      const url = recipePagePath(recipeWork, recipeActor, cursor);
      const { result, profile } = await profileRequest(
        sink,
        async (headers) => {
          headers.set('authorization', `Bearer ${restoreMember!.token}`);
          const response = await restoreStack!.main.handle(new Request(url, { headers }));
          const body = await response.text();
          expect(response.status, body).toBe(200);
          return JSON.parse(body) as RecipePage;
        },
        {
          service: 'recipe-page-growth',
          peers: { fuseki: restoreFusekiUrl },
          flush: flushTelemetryTraces,
        },
      );
      expect(profile.mainCalls).toBe(0);
      expect(profile.request.route).toBe('/v1/recipes/works/:id');
      // The scale helper requires a numeric WorkProfile dimension; carry the
      // corpus scale in mainCalls only after checking and retaining its real count.
      return { result, observedMainCalls: profile.mainCalls, profile: { ...profile, mainCalls: scale } };
    };

    try {
      await openSource();
      const checkpoints = [];
      for (const scale of WORK_PROFILE_SCALES) {
        backupDriverOptions.resumeSource = scale !== 'large';
        const checkpoint = await prepareWorkProfileCorpus({
          recipe,
          api: sourceClient,
          backups: backupDriver,
          dimension: 'unrelatedWorks',
          scale,
          directory: corpusDirectory,
        });
        expect(checkpoint.dimensions.unrelatedWorks).toBe(sizes[scale]);
        checkpoints.push(checkpoint);
      }

      for (const checkpoint of checkpoints) {
        expectedWorkCount = checkpoint.dimensions.unrelatedWorks;
        nextRestoreExpectedWorks = expectedWorkCount;
        const target = `recipe-page-growth-${checkpoint.scale}`;
        const restoreStarted = performance.now();
        await restoreWorkProfileCorpus(checkpoint, target, backupDriver, restoreStarted);
        restoreTargets.push(target);
        expect(performance.now() - restoreStarted).toBeLessThan(600_000);
        const first = await measuredPage(undefined, expectedWorkCount);
        expect(first.result.profile).toBe('recipe-work-page-v1');
        expect(first.result.occurrences).toHaveLength(RECIPE_WORK_PAGE_OCCURRENCES);
        expect(first.result.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
        expect(first.result.next).toBeString();
        expect(first.result.occurrences.filter((item) => item.role === 'group')).toHaveLength(sectionCount);
        measured.firstPage.push(first.profile);

        const continuation = await measuredPage(first.result.next, expectedWorkCount);
        expect(continuation.result.profile).toBe('recipe-work-page-v1');
        expect(continuation.result.structure).toBe(first.result.structure);
        expect(continuation.result.revision).toBe(first.result.revision);
        expect(continuation.result.occurrences).toHaveLength(
          recipeOccurrenceCount - RECIPE_WORK_PAGE_OCCURRENCES,
        );
        expect(continuation.result.cost.pages).toBeGreaterThan(STRUCTURE_LIMITS.maxDepth);
        expect(continuation.result.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
        expect(
          new Set([
            ...first.result.occurrences.map((item) => item.occurrence),
            ...continuation.result.occurrences.map((item) => item.occurrence),
          ]).size,
        ).toBe(recipeOccurrenceCount);
        console.log('recipe-page-growth-checkpoint', JSON.stringify({
          checkpoint: checkpoint.scale,
          unrelatedWorks: expectedWorkCount,
          firstPage: {
            counters: reportedCounters(first.profile, first.observedMainCalls),
            pages: first.result.cost.pages,
            pagesRead: first.result.cost.pagesRead,
            occurrences: first.result.occurrences.length,
          },
          deepContinuation: {
            counters: reportedCounters(continuation.profile, continuation.observedMainCalls),
            pages: continuation.result.cost.pages,
            pagesRead: continuation.result.cost.pagesRead,
            occurrences: continuation.result.occurrences.length,
          },
        }));
        measured.deepContinuation.push(continuation.profile);
        await backupDriver.stop(target);
      }

      assertWorkCostAtScales(
        measured.firstPage,
        recipePageCost,
        'recipe-work-page-unrelated-works-first-page',
      );
      assertWorkCostAtScales(
        measured.deepContinuation,
        recipePageCost,
        'recipe-work-page-unrelated-works-deep-continuation',
      );
    } finally {
      for (const target of restoreTargets.toReversed()) await backupDriver.stop(target);
      const stopped = source;
      const relay = sourceRelay;
      source = undefined;
      sourceRelay = undefined;
      sourceApi = undefined;
      sourceMember = undefined;
      await Promise.all([stopped?.stop(), relay?.end()]);
      await shutdownTelemetry();
      await sink.stop();
    }
  },
  1_800_000,
);
