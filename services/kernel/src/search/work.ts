import { DBOS } from '@dbos-inc/dbos-sdk';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { runCommand, noEffect } from '../command/command.ts';
import { acknowledgeErasure, readErasureStatus } from '../access/erasure.ts';
import { routeOf, partitionOf, PARTITIONS } from '../route/route.ts';
import './recent-searches.ts';
import { trendingSearchStore } from './trending-searches.ts';
import { ConfigError } from '../commerce/config.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import type { WorkModule } from '../work/registry.ts';
import { createOpenSearch } from './opensearch.ts';
import { startSearchIndexing } from './runner.ts';
import { createRatedSubjectSource } from './rated-source.ts';

export type SearchConfig = { url: string; prefix: string };

const PREFIX = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** `undefined` when search is not configured. The URL and prefix are refused by name. */
export function readSearchConfig(env: { readonly [name: string]: string | undefined }): SearchConfig | undefined {
  const url = env.OPENSEARCH_URL;
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('OPENSEARCH_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ConfigError('OPENSEARCH_URL');
  const prefix = env.KERNEL_SEARCH_PREFIX ?? 'rezics-';
  if (!PREFIX.test(prefix)) throw new ConfigError('KERNEL_SEARCH_PREFIX');
  return { url, prefix };
}

export const searchWorkModule: WorkModule = {
  name: 'search',
  async register(context) {
    // Personal PostgreSQL custody is installed even when public indexing is disabled.
    const erase = DBOS.registerStep(
      async (accountId: string) => {
        const route = routeOf(accountId);
        if (route === null) throw new TypeError('Invalid erasure account');
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
          await tx.query(
            'DELETE FROM search.recent_search_state WHERE partition_no=$1 AND route=$2 AND account_id=$3',
            [partitionOf(route), route, accountId],
          );
          return noEffect(null);
        });
        await acknowledgeErasure({ pool: context.pool }, { accountId, participant: 'search', outcome: 'erased' });
      },
      { name: 'search.eraseRecent', ...COMMAND_STEP_RETRIES },
    );
    DBOS.registerWorkflow(async (accountId: string) => erase(accountId), { name: 'search.eraseAccount' });
    context.addEffects([
      {
        name: 'search_account_erasure',
        types: ['com.rezics.access.account-tombstoned.v1'],
        async run(event) {
          const data = event.data as { accountId?: string };
          if (!data.accountId || data.accountId !== event.subject) throw new TypeError('Invalid Search erasure event');
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
        const cutoff = await DBOS.runStep(async () => context.clock().toISOString(), { name: 'search.retentionTime' });
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
    const trends = trendingSearchStore(context.pool, context.clock);
    context.addEffects([
      {
        name: 'search_trending_withdrawal',
        types: ['com.rezics.access.account-tombstoned.v1', 'com.rezics.subject.visibility_changed.v1'],
        async run(event) {
          const data = event.data as { accountId?: string; id?: string; visibility?: string };
          if (data.accountId) {
            while ((await trends.withdraw('account', data.accountId)).value === 'progress') {
              /* bounded committed pages */
            }
          } else if (data.id && data.visibility !== 'visible') {
            while ((await trends.withdraw('source', data.id)).value === 'progress') {
              /* bounded committed pages */
            }
          }
        },
      },
    ]);
    context.addService(() => {
      let stopped = false;
      let running: Promise<unknown> = Promise.resolve();
      const timer = setInterval(() => {
        running = running
          .then(() => (stopped ? undefined : trends.expire()))
          .catch(() => {
            /* retry next bounded tick */
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
    if (!config) return;
    const routeKey = readMembershipRouteKey(context.env);
    context.addService(() =>
      startSearchIndexing({
        pool: context.pool,
        search: createOpenSearch(config.url),
        source: createRatedSubjectSource(context.pool, routeKey).source,
        listing: subjectListingSource(context.pool),
        prefix: config.prefix,
        concurrency: 2,
        discovery: { routeKey },
      }),
    );
  },
};
