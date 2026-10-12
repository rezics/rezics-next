import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fromPlainText } from '@rezics/document';
import { flushTelemetryTraces, shutdownTelemetry, startTelemetry } from '@rezics/observability/runtime';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import {
  createCorpusBackupDriver,
  type CorpusRestoreSmokeInput,
  type ManagedCorpusBackupDriver,
} from '../../../scripts/load/corpus-backup-driver.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import {
  prepareWorkProfileCorpus,
  restoreWorkProfileCorpus,
  workProfileCorpusApi,
  WORK_PROFILE_SCALES,
  type CorpusDimensions,
  type WorkProfileCorpusRecipe,
} from '../../../scripts/load/work-profile-corpus.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkCostField,
  type WorkProfile,
} from '../support/work-profile.ts';
import type { MediaStack } from './media-support.ts';

const fixed: CorpusDimensions = {
  unrelatedWorks: 0,
  unrelatedPosts: 0,
  follows: 0,
  memberships: 0,
  historyDepth: 0,
  realmSize: 0,
  conceptVocabulary: 0,
};

const short = (reference: string) => reference.slice(-36);
const nativeId = () => `https://rezics.com/id/${randomUUID()}`;

function apiFor(stack: MediaStack, token: string) {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
  });
}

async function openRestoredStack(input: CorpusRestoreSmokeInput) {
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
    const { startMediaStack } = await import('./media-support.ts');
    return await startMediaStack(`zone-navigation-growth-${input.target}`, {
      library: true,
      ownerUrls: {
        access: input.apps.ACCESS_DATABASE_URL!,
        content: input.apps.CONTENT_DATABASE_URL!,
        relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
      },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

type SiteWork = Awaited<ReturnType<typeof seedPublicProfileWork>>;
interface SiteFixture {
  zone: string;
  collection: string;
  siteWorks: SiteWork[];
}

// The checker reads its scale from a numeric profile field. Attach the actual
// corpus axis so the shared verdict compares 4/16/64 unrelated Works directly.
type ScaledProfile = WorkProfile & { unrelatedWorks: number };
const corpusAxis = 'unrelatedWorks' as WorkCostField;

function zoneSiteReadCost(owner: {
  maxGraphReads: number;
  maxGraphBytes: number;
  deadlineMs: number;
}): WorkCostContract {
  // Keep each declared class beside the owner's absolute limits: unrelated
  // Works are outside the mounted page and keyed navigation's read set.
  return {
    fusekiRequests: owner.maxGraphReads,
    fusekiSentBytes: owner.maxGraphBytes,
    fusekiReceivedBytes: owner.maxGraphBytes,
    postgresStatements: 512,
    accountCalls: 0,
    mainCalls: 0,
    otherFetches: 100,
    unclassifiedFetches: 0,
    serverLatencyMs: owner.deadlineMs,
    totalLatencyMs: owner.deadlineMs,
    growth: {
      fusekiRequests: { class: 'constant', dimension: corpusAxis },
      fusekiSentBytes: { class: 'constant', dimension: corpusAxis },
      fusekiReceivedBytes: { class: 'constant', dimension: corpusAxis },
      postgresStatements: { class: 'constant', dimension: corpusAxis },
      accountCalls: { class: 'constant', dimension: corpusAxis },
      mainCalls: { class: 'constant', dimension: corpusAxis },
      otherFetches: { class: 'constant', dimension: corpusAxis },
      unclassifiedFetches: { class: 'constant', dimension: corpusAxis },
    },
  };
}

function measuredCounters(profile: ScaledProfile) {
  return {
    unrelatedWorks: profile.unrelatedWorks,
    status: profile.request.status,
    mainCalls: profile.mainCalls,
    fusekiRequests: profile.fusekiRequests,
    fusekiSentBytes: profile.fusekiSentBytes,
    fusekiReceivedBytes: profile.fusekiReceivedBytes,
    fusekiEngineMs: profile.fusekiEngineMs,
    postgresStatements: profile.postgresStatements,
    accountCalls: profile.accountCalls,
    otherFetches: profile.otherFetches,
    unclassifiedFetches: profile.unclassifiedFetches,
    serverLatencyMs: profile.serverLatencyMs,
    totalLatencyMs: profile.totalLatencyMs,
  };
}

test(
  'Zone keyed navigation and a populated mounted page keep constant cost as unrelated Works grow',
  async () => {
    const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
    if (!sourceRunId || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL)
      throw new Error('Run through goalctl integration QA');
    const startedAt = performance.now();
    const sourceDirectory = join(root, '.temp/stack', `rezics-qa-${sourceRunId}`);
    const compose = readEnv(join(sourceDirectory, 'compose.env'));
    expect(compose.REZICS_STACK_STORAGE).toBe('persistent');

    const sink = startWorkProfileSink({ settleMs: 25, maxSpans: 500_000 });
    startTelemetry('main', {
      ...process.env,
      ...sink.env,
      OTEL_SERVICE_NAME: 'main',
      OTEL_TRACES_SAMPLER_ARG: '1',
    });

    let source: MediaStack | undefined;
    let sourceStopped = false;
    let sourceRelay: import('pg').Pool | undefined;
    let driver: ManagedCorpusBackupDriver | undefined;
    let checkpoint: Awaited<ReturnType<typeof prepareWorkProfileCorpus>> | undefined;
    let actor = '';
    let site: SiteFixture | undefined;
    const unrelatedWorks: SiteWork[] = [];
    const restored = new Map<string, MediaStack>();
    const fusekiUrls = new Map<string, string>();
    const collection = nativeId();
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    let authorPrincipalId = '';

    try {
      const [{ Pool }, { initializeRelayCheckpoint }, { startMediaStack }, { ZONE_ROUTE_COST }] =
        await Promise.all([
          import('pg'),
          import('../../../services/main/src/modules/outbox/relay.ts'),
          import('./media-support.ts'),
          import('../../../services/main/src/modules/zone/route-cost.ts'),
        ]);
      source = await startMediaStack('zone-navigation-growth-source', { library: true });
      sourceRelay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
      const member = await source.member('zone-navigation-growth-author', {
        stable: true,
        verified: true,
      });
      authorPrincipalId = member.principalId;
      await initializeRelayCheckpoint(
        sourceRelay,
        Bun.env.MAIN_RELAY_CONSUMER!,
        source.env.lineage.dataEpoch,
      );
      let api = apiFor(source, member.token);

      const grant = async (stack: MediaStack, scope: string, action: string) =>
        grantFixtureAuthority(stack.accessPool, {
          scope,
          requireDispatch: true,
          representations: [
            { principalId: authorPrincipalId, actor, action, lifetime: '7 days' },
          ],
          grant: { actor, action, lifetime: '7 days' },
        });

      const recipe: WorkProfileCorpusRecipe = {
        version: 'zone-navigation-v1',
        fixed,
        async initialize(client, key) {
          const author = await client.command<{ agent: string }>(`${key}:author`, {
            method: 'POST',
            path: '/v1/agents',
            body: {
              profile: 'agent-provision-v1',
              kind: 'person',
              displayName: 'Zone navigation growth author',
            },
          });
          actor = author.agent;
          await grant(source!, 'space:create:root', 'space.create');
          await grant(source!, 'work:create:root', 'work.create');

          const created = await client.command<{
            space: string;
            zone: string;
            navigation: string;
            navigationRevision: string;
          }>(`${key}:space`, {
            method: 'POST',
            path: '/v1/spaces',
            body: {
              profile: 'space-zone-v1',
              name: 'Zone navigation growth site',
              capabilities: ['zone'],
              actingSubject: actor,
            },
          });
          await grant(source!, `zone:edit:${created.zone}`, 'zone.edit');
          await grant(source!, `collection:edit:${collection}`, 'collection.edit');
          await grant(source!, `semantic:read:${collection}`, 'semantic.read');

          const curated = await client.command<{ structure: string; revision: string }>(
            `${key}:collection`,
            {
              method: 'POST',
              path: '/v1/collections',
              body: {
                collection,
                name: 'Mounted reading list',
                disclosure: 'public',
                actingSubject: actor,
              },
            },
          );
          const siteWorks: SiteWork[] = [];
          for (let index = 0; index < 3; index++) {
            siteWorks[index] = await seedPublicProfileWork(
              client,
              `${key}:site-work:${index}`,
              {
                actingSubject: actor,
                title: `Mounted Zone Work ${index}`,
                body: `Mounted page text ${index}`,
              },
            );
          }
          await client.command(
            `${key}:collection-members`,
            {
              method: 'POST',
              path: `/v1/collections/${short(collection)}/changes`,
              body: {
                expectedHead: curated.revision,
                actingSubject: actor,
                operations: siteWorks.map((work) => ({
                  op: 'insert',
                  role: 'member',
                  parent: curated.structure,
                  position: 'last',
                  target: work.work,
                  selection: { mode: 'follow-context' },
                })),
              },
            },
          );
          const mounted = await client.command<{ revision: string }>(`${key}:mount`, {
            method: 'POST',
            path: `/v1/zones/${short(created.zone)}/mounts`,
            body: {
              expectedHead: created.navigationRevision,
              collection,
              routeSegment: 'reading',
              disclosure: 'public',
              position: 'last',
              actingSubject: actor,
            },
          });
          const draft = await client.command<{
            revisionId: string;
            byteDigest: string;
            sourcePosition: { dataEpoch: string };
          }>(`${key}:home-draft`, {
            method: 'POST',
            path: '/v1/content-drafts',
            body: {
              profile: 'content-text-v1',
              resourceId: created.zone,
              variantId,
              expectedHead: null,
              document: fromPlainText('A fixed mounted Zone home', 'blocks'),
              language: { kind: 'tag', tag: 'en', originalTag: 'en' },
              direction: 'ltr',
              actingSubject: actor,
            },
          });
          const configuration = await client.read<{ revision: string }>(
            `/v1/zones/${short(created.zone)}/configuration?actingSubject=${encodeURIComponent(actor)}`,
          );
          await client.command(`${key}:site-publication`, {
            method: 'POST',
            path: `/v1/zones/${short(created.zone)}/site-publications`,
            body: {
              routesRevision: mounted.revision,
              navigationRevision: mounted.revision,
              expectedHead: configuration.revision,
              actingSubject: actor,
              pages: [
                {
                  page: created.zone,
                  variantId,
                  revisionId: draft.revisionId,
                  byteDigest: draft.byteDigest,
                  contentEpoch: draft.sourcePosition.dataEpoch,
                },
              ],
            },
          });
          site = {
            zone: created.zone,
            collection,
            siteWorks,
          };
        },
        async grow(client, dimension, index, key) {
          expect(dimension).toBe('unrelatedWorks');
          unrelatedWorks[index] = await seedPublicProfileWork(client, key, {
            actingSubject: actor,
            title: `Unrelated Zone corpus Work ${index}`,
            body: `Unrelated zone corpus text ${index}`,
          });
        },
        async verify(client) {
          if (!site) throw new Error('Zone corpus site was not initialized');
          for (const [index, work] of unrelatedWorks.entries()) {
            const selected = await client.read<{
              work: string;
              mainVersion: string;
              contribution: string;
              selectedDraft: string;
              body: string;
            }>(`/v1/main-versions/${short(work.mainVersion)}/selection?language=en`);
            expect(selected).toMatchObject({
              work: work.work,
              mainVersion: work.mainVersion,
              contribution: work.contribution,
              selectedDraft: work.draftRevision,
              body: `Unrelated zone corpus text ${index}`,
            });
          }
          const presentation = await client.read<{
            navigation: Array<{ segment: string; target: string; kind: string }>;
          }>(`/v1/zones/${short(site.zone)}/presentation`);
          expect(presentation.navigation.map(({ segment, target, kind }) => ({ segment, target, kind }))).toEqual([
            { segment: 'reading', target: site.collection, kind: 'index' },
          ]);
          const page = await client.read<{
            kind: string;
            items: Array<{ id: string; inZone: boolean }>;
          }>(`/v1/zones/${short(site.zone)}/routes?path=%2Freading`);
          expect(page.kind).toBe('index');
          expect(page.items.map(({ id, inZone }) => ({ id, inZone }))).toEqual(
            site.siteWorks.map(({ work }) => ({ id: work, inZone: true })),
          );
          const uniqueWorks = new Set(unrelatedWorks.map(({ work }) => work));
          expect(uniqueWorks.size).toBe(unrelatedWorks.length);
          return { ...fixed, unrelatedWorks: uniqueWorks.size };
        },
      };

      const makeBackupDriver = (resumeSource: boolean) => createCorpusBackupDriver({
        sourceRunId,
        directory: join(root, '.temp/work-profiles/zone-navigation-growth/backups', sourceRunId),
        resumeSource,
        async quiesce(signal) {
          signal.throwIfAborted();
          const relay = sourceRelay;
          sourceRelay = undefined;
          await relay?.end();
          await source!.stop();
          sourceStopped = true;
          return async () => {
            const apps = readEnv(join(root, '.temp/stack', `rezics-qa-${sourceRunId}`, 'apps.env'));
            Object.assign(Bun.env, apps);
            for (;;) {
              signal.throwIfAborted();
              try {
                await source!.objects('media/').initialize();
                break;
              } catch (error) {
                if (!(error instanceof Error) || error.message !== 'cannot reach immutable object bucket')
                  throw error;
                await Bun.sleep(100);
              }
            }
            source = await startMediaStack('zone-navigation-growth-source', { library: true });
            sourceStopped = false;
            const resumedMember = await source.member('zone-navigation-growth-author', {
              stable: true,
              verified: true,
            });
            api = apiFor(source, resumedMember.token);
          };
        },
        async smokeRead(input) {
          const copy = await openRestoredStack(input);
          restored.set(input.target, copy);
          fusekiUrls.set(input.target, input.apps.FUSEKI_URL!);
          try {
            const copyMember = await copy.member('zone-navigation-growth-author', {
              stable: true,
              verified: true,
            });
            const copyApi = apiFor(copy, copyMember.token);
            const actual = await recipe.verify(copyApi);
            expect(actual).toEqual(checkpoint!.dimensions);
            return async () => {
              restored.delete(input.target);
              fusekiUrls.delete(input.target);
              await copy.stop();
            };
          } catch (error) {
            restored.delete(input.target);
            fusekiUrls.delete(input.target);
            await copy.stop();
            throw error;
          }
        },
      });

      const sinkProfile = async (
        stack: MediaStack,
        fusekiUrl: string,
        path: string,
      ): Promise<ScaledProfile> => {
        sink.clear();
        const { result, profile } = await profileRequest(
          sink,
          async (headers) => {
            const response = await stack.main.handle(
              new Request(`http://main.local${path}`, { headers }),
            );
            const text = await response.text();
            expect(response.status, text).toBe(200);
            return JSON.parse(text) as Record<string, unknown>;
          },
          { service: 'main', peers: { fuseki: fusekiUrl }, flush: flushTelemetryTraces },
        );
        expect(profile.postgresStatements).not.toBeNull();
        expect(result).toBeDefined();
        return { ...profile, unrelatedWorks: checkpoint!.dimensions.unrelatedWorks };
      };

      const manifestDirectory = join(
        root,
        '.temp/work-profiles/zone-navigation-growth/manifests',
        sourceRunId,
      );
      const routeProfiles: ScaledProfile[] = [];
      const presentationProfiles: ScaledProfile[] = [];
      for (const scale of WORK_PROFILE_SCALES) {
        const backupDriver = makeBackupDriver(scale !== 'large');
        driver = backupDriver;
        const checkpointInput = {
          recipe,
          api,
          backups: backupDriver,
          dimension: 'unrelatedWorks' as const,
          scale,
          directory: manifestDirectory,
          startedAt,
        };
        checkpoint = await prepareWorkProfileCorpus(checkpointInput);
        expect(checkpoint.dimensions.unrelatedWorks).toBe(
          scale === 'small' ? 4 : scale === 'medium' ? 16 : 64,
        );

        const target = `zone-navigation-${sourceRunId}-${scale}`;
        const restoredAt = performance.now();
        const restoreMs = await restoreWorkProfileCorpus(
          checkpoint,
          target,
          backupDriver,
          restoredAt,
        );
        console.log(
          'Zone navigation corpus checkpoint',
          JSON.stringify({ scale, unrelatedWorks: checkpoint.dimensions.unrelatedWorks, restoreMs }),
        );
        expect(restoreMs).toBeLessThan(600_000);

        const copy = restored.get(target);
        const fusekiUrl = fusekiUrls.get(target);
        if (!copy || !fusekiUrl) throw new Error(`Zone navigation restore ${target} did not open`);
        const routeProfile = await sinkProfile(
          copy,
          fusekiUrl,
          `/v1/zones/${short(site!.zone)}/routes?path=%2Freading`,
        );
        const presentationProfile = await sinkProfile(
          copy,
          fusekiUrl,
          `/v1/zones/${short(site!.zone)}/presentation`,
        );
        routeProfiles.push(routeProfile);
        presentationProfiles.push(presentationProfile);
        console.log(
          'Zone navigation checkpoint counters',
          JSON.stringify({
            scale,
            route: measuredCounters(routeProfile),
            presentation: measuredCounters(presentationProfile),
          }),
        );
        await backupDriver.stop(target);
        expect(performance.now() - restoredAt).toBeLessThan(600_000);
      }

      const cost = zoneSiteReadCost(ZONE_ROUTE_COST);
      assertWorkCostAtScales(routeProfiles, cost, 'zone-navigation-route-growth');
      assertWorkCostAtScales(
        presentationProfiles,
        cost,
        'zone-navigation-presentation-growth',
      );
      expect(performance.now() - startedAt).toBeLessThan(600_000);
    } finally {
      for (const target of [...restored.keys()]) await driver?.stop(target);
      await sourceRelay?.end();
      if (source && !sourceStopped) await source.stop();
      await shutdownTelemetry();
      await sink.stop();
    }
  },
  600_000,
);
