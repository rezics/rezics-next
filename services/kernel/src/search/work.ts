import { collectionPublicationScopeRuntimes } from './scope-runtime.ts';
import { readSearchConfig } from './config.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { runCommand, noEffect } from '../command/command.ts';
import { readErasureStatus } from '../access/erasure.ts';
import { routeOf, partitionOf, PARTITIONS } from '../route/route.ts';
import './recent-searches.ts';
import { trendingSearchStore } from './trending-searches.ts';
import { createKernel } from '../http/kernel.ts';
import { createDefaultPublicFilterRuntime } from './public-runtime.ts';
import { createPublicPreparation, type PublicPreparation } from './public-preparation.ts';
import { createScopePreparation } from './scope-preparation.ts';
import { createScopePreparationStore, SCOPE_PREPARATION_WORKFLOW } from './scope-preparation-store.ts';
import { PUBLIC_PREPARATION_WORKFLOW } from './public-preparation-store.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { createOpenSearch, SearchUnavailableError } from './opensearch.ts';
import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import type { DiscoveryProducerEntry } from './index.ts';
import { REVIEW_DISCOVERY_CHANGED } from '../content/review-discovery-events.ts';
import { requestReviewDiscoveryReceiving } from './review-discovery-receiving.ts';
import { startSearchIndexing } from './runner.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import { registerSearchErasure, markSearchPersonalErasure, stepSearchErasure } from './erasure.ts';
import type { SubjectSource } from './source.ts';
import type { CreditSearchSource } from './credit-search.ts';
import type { FacetAccessObservationPort } from './facet-access-port.ts';

/** DBOS recovers workflows during launch, before addService offers the live preparation. */
export function createSearchServiceGate<T>(unavailable: () => Error) {
  let value: T | undefined;
  let stopped = false;
  let resolve!: (next: T) => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void pending.catch(() => {});
  return {
    get current() {
      return value;
    },
    async ready(): Promise<T> {
      if (stopped) throw unavailable();
      if (value) return value;
      return pending;
    },
    offer(next: T) {
      if (stopped) throw unavailable();
      if (value) throw new Error('Search preparation service is already running');
      value = next;
      resolve(next);
    },
    stop() {
      stopped = true;
      value = undefined;
      reject(unavailable());
    },
  };
}

export { collectionPublicationScopeRuntime } from './scope-runtime.ts';

export { readSearchConfig, type SearchConfig } from './config.ts';

type SearchDiscoveryComposer = (input: {
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  tokens: KeyRing;
  clock: KernelClock;
  subjects: SubjectSource;
}) => DiscoveryProducerEntry;

type SearchRuntimeDefaults = Required<
  Pick<
    Parameters<typeof createKernel>[0],
    'tokens' | 'receiptKeys' | 'writeRate' | 'rateAttribution' | 'clock' | 'access'
  >
> & {
  facetAccess: FacetAccessObservationPort;
  libraryScope: import('./library-scope-port.ts').SearchLibraryScopePort;
};
type SearchRuntimeDefaultsComposer = (input: { env: NodeJS.ProcessEnv; clock: KernelClock }) => SearchRuntimeDefaults;
type CreditSearchSourceComposer = (pool: Pool, routeKey: Uint8Array) => CreditSearchSource;

export function createSearchWorkModule(
  composeDiscovery: SearchDiscoveryComposer,
  composeRuntimeDefaults: SearchRuntimeDefaultsComposer,
  composeCreditSearch?: CreditSearchSourceComposer,
): WorkModule {
  return {
    name: 'search',
    async register(context) {
      const trends = trendingSearchStore(context.pool, context.clock);
      type Withdrawal = { kind: 'account' | 'source'; identity: string; sequence: number };
      const withdraw = DBOS.registerStep(
        async (kind: Withdrawal['kind'], identity: string) => (await trends.withdraw(kind, identity)).value,
        { name: 'search.withdrawTrending', ...COMMAND_STEP_RETRIES },
      );
      const acknowledge = DBOS.registerStep(
        async (accountId: string) => markSearchPersonalErasure(context.pool, accountId),
        { name: 'search.acknowledgeErasure', ...COMMAND_STEP_RETRIES },
      );
      const enqueueWithdrawal = async (input: Withdrawal) => {
        await context.client.enqueue(
          {
            workflowName: 'search.trendingWithdrawal',
            workflowID: `search:trending:${input.kind}:${input.identity}:${input.sequence}`,
            workflowIDReusePolicy: 'return-existing',
            queueName: 'maintenance',
          },
          input,
        );
      };
      const continueWithdrawal = DBOS.registerStep(enqueueWithdrawal, {
        name: 'search.continueTrendingWithdrawal',
        ...COMMAND_STEP_RETRIES,
      });
      const withdrawSegment = async (input: Withdrawal) => {
        // Bound each command and workflow history; this records only personal-copy completion.
        for (let page = 0; page < 100; page++) {
          if ((await withdraw(input.kind, input.identity)) === 'complete') {
            if (input.kind === 'account') await acknowledge(input.identity);
            return;
          }
        }
        await continueWithdrawal({ ...input, sequence: input.sequence + 1 });
      };
      DBOS.registerWorkflow(withdrawSegment, { name: 'search.trendingWithdrawal' });
      // Personal PostgreSQL custody is installed even when public indexing is disabled.
      const erase = DBOS.registerStep(
        async (accountId: string) => {
          const route = routeOf(accountId);
          if (route === null) throw new TypeError('Invalid erasure account');
          await stepSearchErasure(context.pool, accountId, false);
          await runCommand(context.pool, { partition: partitionOf(route) }, async (tx) => {
            const status = await readErasureStatus(tx, accountId);
            if (!status || !status.participants.search)
              throw new Error('Search erasure requires its committed obligation');
            const account = await tx.query(
              'SELECT state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
              [route, accountId],
            );
            if (account.rows[0]?.state !== 'deleted' || !account.rows[0]?.authn_fenced)
              throw new Error('Search erasure requires the terminal account fence');
            // Capture personal applicability before either owner removes its last native row.
            await tx.query(
              `UPDATE search.erasure_progress SET ever_applied=ever_applied OR
              EXISTS(SELECT 1 FROM search.recent_search_state WHERE partition_no=$1 AND route=$2 AND account_id=$3)
              OR EXISTS(SELECT 1 FROM search.trending_member WHERE route=0 AND account_id=$3)
              WHERE partition_no=$1 AND account_id=$3`,
              [partitionOf(route), route, accountId],
            );
            await tx.query(
              'DELETE FROM search.recent_search_state WHERE partition_no=$1 AND route=$2 AND account_id=$3',
              [partitionOf(route), route, accountId],
            );
            return noEffect(null);
          });
        },
        { name: 'search.eraseRecent', ...COMMAND_STEP_RETRIES },
      );
      DBOS.registerWorkflow(
        async (accountId: string) => {
          await erase(accountId);
          await withdrawSegment({ kind: 'account', identity: accountId, sequence: 0 });
        },
        { name: 'search.eraseAccount' },
      );
      context.addEffects([
        {
          name: 'search_account_erasure',
          types: ['com.rezics.access.account-tombstoned.v1'],
          async run(event) {
            const data = event.data as { accountId?: string };
            if (!data.accountId || data.accountId !== event.subject)
              throw new TypeError('Invalid Search erasure event');
            await context.client.enqueue(
              {
                workflowName: 'search.eraseAccount',
                workflowID: `search:erase:${data.accountId}`,
                workflowIDReusePolicy: 'return-existing',
                queueName: 'workflows',
              },
              data.accountId,
            );
          },
        },
      ]);
      const prune = DBOS.registerStep(
        async (partition: number, cutoff: string) =>
          (
            await runCommand(context.pool, { partition }, async (tx) => {
              const removed = await tx.query(
                `WITH due AS MATERIALIZED (
            SELECT partition_no,route,account_id,id FROM search.recent_search
            WHERE partition_no=$1 AND expires_at<=$2 ORDER BY expires_at,route,account_id,id LIMIT 100
          ) DELETE FROM search.recent_search r USING due d WHERE
            (r.partition_no,r.route,r.account_id,r.id)=(d.partition_no,d.route,d.account_id,d.id) AND r.expires_at<=$2`,
                [partition, cutoff],
              );
              return noEffect(removed.rowCount ?? 0);
            })
          ).value,
        { name: 'search.pruneRecent', ...COMMAND_STEP_RETRIES },
      );
      type Segment = { root: string; sequence: number; cutoff: string; partition: number };
      const continuation = DBOS.registerStep(
        async (input: Segment) => {
          await context.client.enqueue(
            {
              workflowName: 'search.recentRetentionSegment',
              queueName: 'maintenance',
              workflowID: `search:retention:${input.root}:${input.sequence}`,
              workflowIDReusePolicy: 'return-existing',
            },
            input,
          );
        },
        { name: 'search.recentRetentionContinue', ...COMMAND_STEP_RETRIES },
      );
      const segment = async (input: Segment) => {
        let partition = input.partition;
        // Drain indexed due ranges, with bounded transactions and resumable bounded workflow histories.
        for (let n = 0; n < 100 && partition < PARTITIONS; n++)
          if ((await prune(partition, input.cutoff)) < 100) partition++;
        if (partition < PARTITIONS) await continuation({ ...input, partition, sequence: input.sequence + 1 });
      };
      DBOS.registerWorkflow(segment, { name: 'search.recentRetentionSegment' });
      DBOS.registerWorkflow(
        async () => {
          const cutoff = await DBOS.runStep(async () => context.clock().toISOString(), {
            name: 'search.retentionTime',
          });
          await segment({ root: DBOS.workflowID!, sequence: 0, cutoff, partition: 0 });
        },
        { name: 'search.recentRetention' },
      );
      await context.client.applySchedules([
        {
          scheduleName: 'search.recentRetention.hourly',
          workflowName: 'search.recentRetention',
          schedule: '0 * * * *',
          queueName: 'maintenance',
          cronTimezone: 'UTC',
          automaticBackfill: false,
        },
      ]);
      context.addEffects([
        {
          name: 'search_trending_withdrawal',
          types: ['com.rezics.subject.visibility_changed.v1'],
          async run(event) {
            const data = event.data as { id: string; visibility: string };
            if (data.visibility !== 'visible')
              await enqueueWithdrawal({ kind: 'source', identity: data.id, sequence: 0 });
          },
        },
      ]);
      context.addService(() => {
        let stopped = false;
        let running: Promise<unknown> | undefined;
        const timer = setInterval(() => {
          if (stopped || running) return;
          running = trends
            .expire()
            .catch(() => {
              /* retry next bounded tick */
            })
            .finally(() => {
              running = undefined;
            });
        }, 60_000);
        return {
          async stop() {
            stopped = true;
            clearInterval(timer);
            await running;
          },
        };
      });
      const config = readSearchConfig(context.env);
      const bindErasureAccess = registerSearchErasure(context, config, composeCreditSearch);
      if (!config) return;
      const routeKey = readMembershipRouteKey(context.env);
      const creditSearch = composeCreditSearch?.(context.pool, routeKey);
      const search = createOpenSearch(config.url);
      const source = createRatedSubjectSource(context.pool, routeKey, creditSearch).source;
      collectionPublicationScopeRuntimes.set(context, {
        pool: context.pool,
        client: search,
        prefix: config.prefix,
        source,
        clock: context.clock,
      });
      const listing = subjectListingSource(context.pool);
      context.addEffects([
        {
          name: 'search_review_discovery_receiving',
          types: [REVIEW_DISCOVERY_CHANGED],
          async run(event) {
            await requestReviewDiscoveryReceiving(context.pool, config.prefix, event.data);
          },
        },
      ]);
      const preparationGate = createSearchServiceGate<PublicPreparation>(
        () => new SearchUnavailableError('Search preparation service is not running'),
      );
      const scopeGate = createSearchServiceGate<ReturnType<typeof createScopePreparation>>(
        () => new SearchUnavailableError('Search scope preparation service is not running'),
      );
      const scopeStore = createScopePreparationStore(context.pool, config.prefix, context.client);
      const scopeStep = DBOS.registerStep(
        async (scopeId: string, revision: string) => {
          await (await scopeGate.ready()).run(scopeId, revision);
        },
        { name: 'search.scopePreparationStep', ...COMMAND_STEP_RETRIES },
      );
      DBOS.registerWorkflow(
        async (input: { scopeId: string; revision: string }) => {
          await scopeStep(input.scopeId, input.revision);
        },
        { name: SCOPE_PREPARATION_WORKFLOW },
      );
      const step = DBOS.registerStep(
        async (id: string, revision: string) => {
          await (await preparationGate.ready()).run(id, revision);
        },
        { name: 'search.publicPreparationStep', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1 },
      );
      DBOS.registerWorkflow(
        async (input: { id: string; revision: string; notBefore: number }) => {
          const delay = input.notBefore - Date.now();
          if (delay > 0) await DBOS.sleep(delay);
          await step(input.id, input.revision);
        },
        { name: PUBLIC_PREPARATION_WORKFLOW },
      );
      context.addService(async () => {
        const defaults = composeRuntimeDefaults({ env: { ...context.env }, clock: context.clock });
        const published = collectionPublicationScopeRuntimes.get(context);
        if (published)
          collectionPublicationScopeRuntimes.set(context, { ...published, library: defaults.libraryScope });
        let runtime: ReturnType<typeof createDefaultPublicFilterRuntime> | undefined;
        let discoveryProducers: DiscoveryProducerEntry | undefined;
        let searchAccess: Access | undefined;
        try {
          createKernel({
            pool: context.pool,
            routeKey,
            ...defaults,
            workClient: context.client,
            onAccessReady(access) {
              searchAccess = access;
              bindErasureAccess(access);
              discoveryProducers = composeDiscovery({
                pool: context.pool,
                routeKey,
                access,
                tokens: defaults.tokens,
                clock: context.clock,
                subjects: source,
              });
              scopeGate.offer(
                createScopePreparation({
                  search,
                  pool: context.pool,
                  prefix: config.prefix,
                  routeKey,
                  access,
                  clock: context.clock,
                }),
              );
              runtime = createDefaultPublicFilterRuntime({
                pool: context.pool,
                routeKey,
                access,
                search,
                prefix: config.prefix,
                clock: context.clock,
                facetAccess: defaults.facetAccess,
                ...(creditSearch === undefined ? {} : { creditSearch }),
              });
            },
          });
        } catch (error) {
          preparationGate.stop();
          scopeGate.stop();
          throw error;
        }
        if (!runtime || !discoveryProducers || !searchAccess) {
          preparationGate.stop();
          scopeGate.stop();
          throw new Error('Search worker Access composition is incomplete');
        }
        const publicRuntime = runtime;
        let scopeTick: Promise<void> | undefined;
        let scopeStopped = false;
        const scopeTimer = setInterval(() => {
          if (scopeStopped || scopeTick) return;
          scopeTick = scopeStore
            .due()
            .catch(() => {
              /* the next bounded discovery retries */
            })
            .finally(() => {
              scopeTick = undefined;
            });
        }, 1000);
        const halt = async () => {
          scopeStopped = true;
          clearInterval(scopeTimer);
          await scopeTick;
          preparationGate.stop();
          scopeGate.stop();
        };
        const preparation = createPublicPreparation({
          pool: context.pool,
          work: context.client,
          search,
          source,
          listing,
          runtime,
          prefix: config.prefix,
        });
        try {
          preparationGate.offer(preparation);
        } catch (error) {
          await halt();
          await publicRuntime.close();
          throw error;
        }
        let runner: Awaited<ReturnType<typeof startSearchIndexing>>;
        try {
          runner = await startSearchIndexing({
            pool: context.pool,
            search,
            source,
            listing,
            prefix: config.prefix,
            concurrency: 2,
            discovery: { routeKey, producers: discoveryProducers },
            publicPreparation: preparation,
          });
        } catch (error) {
          await halt();
          try {
            await preparation.stop();
          } finally {
            await publicRuntime.close();
          }
          throw error;
        }
        return {
          pause: runner.pause,
          resume: runner.resume,
          refresh: runner.refresh,
          async stop() {
            await halt();
            try {
              await runner.stop();
            } finally {
              try {
                await preparation.stop();
              } finally {
                await publicRuntime.close();
              }
            }
          },
        };
      });
    },
  };
}
