import { DBOS } from '@dbos-inc/dbos-sdk';
import { Value } from 'typebox/value';
import { ERASURE_PARTICIPANTS } from '../access/erasure.ts';
import { ACCESS_EVENTS } from '../access/events.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { purgeAccountFactsPage } from './account-fact-purge.ts';
import { requireRoute, workStepDeadline } from './command-support.ts';
import scope from './erasure-scope.sql';
import probe from './erasure-probe.sql';

const TOMBSTONED = 'com.rezics.access.account-tombstoned.v1';
const WORKFLOW = 'library.accountErasure';

// These gaps apply even when every indexed native root is absent. Never turn a
// missing producer/locator/minimizer into an attestation that no data applies.
const BLOCKERS = Object.freeze([
  'bulk_target/bulk_effect: no account-leading operation/selection locator',
  'collection_listing_history: no curator locator after parent removal',
  'shared receipt/outbox/write_basis/work payloads: no exact Library producer custody/minimizer handoff',
  'listing effects: no account-home locator fence or committed late-item disposition',
  'logs/caches/exports/replicas/backups: no complete Library custody inventory',
]);

export const libraryErasureWorkflowId = (accountId: string) => {
  requireRoute(accountId);
  // Access creates exactly one immutable terminal obligation per never-reused account.
  return `library:erasure:${accountId}`;
};

/** Registration and honest partial progress, not the full Library erasure graph.
 * No native complete-proof path exists yet; therefore this module cannot ACK.
 * See erasure-participant.md for every remaining producer and cleanup obligation.
 */
export function registerLibraryErasure({ pool, client, addEffects }: WorkContext): void {
  const inspect = DBOS.registerStep(
    async (accountId: string) => {
      const route = requireRoute(accountId);
      return (
        await runCommand(pool, { partition: partitionOf(route), deadline: workStepDeadline() }, async (tx) => {
          const current = await scope.run(tx, { route, account_id: accountId });
          if (!current) throw new Error('Library erasure requires the committed current account tombstone');
          if (current.version !== 1 || !ERASURE_PARTICIPANTS[1].includes('library'))
            throw new Error('Unsupported Library erasure participant version');
          if (current.outcome !== null && current.outcome !== 'none' && current.outcome !== 'erased')
            throw new Error('Invalid immutable Library erasure acknowledgement');
          const remaining = current.outcome === null ? await probe.run(tx, { route, account_id: accountId }) : [];
          return noEffect({ outcome: current.outcome, remainingStores: remaining.map((row) => row.store) });
        })
      ).value;
    },
    { name: 'library.inspectErasure', ...COMMAND_STEP_RETRIES },
  );
  type FactInput = Parameters<typeof purgeAccountFactsPage>[1];
  const purgePage = DBOS.registerStep(
    async (accountId: string, kind: FactInput['kind'], after: FactInput['after']) => {
      // A commit before the DBOS checkpoint replays the identical native receipt.
      // Neither a retry nor physical purge allocates an owner state-write sequence.
      const stepKey = `erasure:${accountId}:${kind}:${after?.id ?? 'start'}`;
      return (await purgeAccountFactsPage({ pool }, { accountId, kind, after, limit: 100, stepKey })).value;
    },
    { name: 'library.purgeErasureFactsPage', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (accountId: string) => {
      const initial = await inspect(accountId);
      // An immutable acknowledgement is never reopened by duplicate/stale work.
      if (initial.outcome !== null) return { state: 'acknowledged', outcome: initial.outcome };
      const facts = { pages: 0, examined: 0, removed: 0 };
      let continuation: { kind: FactInput['kind']; after: FactInput['after'] } | null = null;
      factsSegment: for (const kind of ['entry', 'copy', 'follow'] as const) {
        let after: FactInput['after'] = null;
        for (;;) {
          if (facts.pages === 100) {
            continuation = { kind, after };
            break factsSegment;
          }
          const page = await purgePage(accountId, kind, after);
          facts.pages++;
          facts.examined += page.examined;
          facts.removed += page.removed;
          if (page.exhausted) break;
          if (page.after === null) throw new Error('Library erasure page made no progress');
          after = page.after;
        }
      }
      const final = await inspect(accountId);
      if (final.outcome !== null) return { state: 'acknowledged', outcome: final.outcome };
      // Exhaustion attests only to these three native namespaces. Even zero roots
      // cannot close unindexed roles or copies committed before their locator effect.
      return {
        state: 'pending',
        facts,
        continuation,
        remainingStores: final.remainingStores,
        blockers: continuation
          ? [...BLOCKERS, 'fact pages: 100-page segment limit reached; native continuation remains pending']
          : BLOCKERS,
      };
    },
    { name: WORKFLOW },
  );
  addEffects([
    {
      name: 'library_account_erasure',
      types: [TOMBSTONED],
      async run(event) {
        if (!Value.Check(ACCESS_EVENTS[TOMBSTONED], event.data)) throw new TypeError('Invalid Library erasure event');
        const { accountId } = event.data as { accountId: string };
        if (event.subject !== accountId) throw new TypeError('Invalid Library erasure event address');
        await client.enqueue(
          {
            workflowName: WORKFLOW,
            workflowID: libraryErasureWorkflowId(accountId),
            workflowIDReusePolicy: 'return-existing',
            queueName: 'workflows',
          },
          accountId,
        );
      },
    },
  ]);
}
