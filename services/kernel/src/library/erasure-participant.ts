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
import { purgeOwnedGraphPage } from './erasure-owned-graph.ts';
import { initialGraphCheckpoint, runOwnedGraphSegment, type GraphCheckpoint } from './erasure-owned-work.ts';

const TOMBSTONED = 'com.rezics.access.account-tombstoned.v1';
const WORKFLOW = 'library.accountErasure';

// These gaps apply even when every indexed native root is absent. Never turn a
// missing producer/locator/minimizer into an attestation that no data applies.
const BLOCKERS = Object.freeze([
  'bulk_effect: target-home effects have no account-home producer locator or late-disposition fence',
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

/** Default terminal cleanup of indexed local stores.
 * Shared/foreign custody still has no complete-proof path; this module cannot ACK.
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
  const graphPage = DBOS.registerStep(
    async (input: Parameters<typeof purgeOwnedGraphPage>[1]) => purgeOwnedGraphPage(pool, input),
    { name: 'library.purgeErasureOwnedPage', ...COMMAND_STEP_RETRIES },
  );
  type Continuation = { segment: number; factKind: number; factAfter: FactInput['after']; graph: GraphCheckpoint };
  const continueErasure = DBOS.registerStep(
    async (accountId: string, next: Continuation) => {
      await client.enqueue(
        {
          workflowName: WORKFLOW,
          workflowID: `${libraryErasureWorkflowId(accountId)}:${next.segment}`,
          workflowIDReusePolicy: 'return-existing',
          queueName: 'workflows',
        },
        accountId,
        next,
      );
    },
    { name: 'library.continueAccountErasure', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (accountId: string, start?: Continuation) => {
      const initial = await inspect(accountId);
      // An immutable acknowledgement is never reopened by duplicate/stale work.
      if (initial.outcome !== null) return { state: 'acknowledged', outcome: initial.outcome };
      const cursor: Continuation = start ?? {
        segment: 0,
        factKind: 0,
        factAfter: null,
        graph: initialGraphCheckpoint(),
      };
      const facts = { pages: 0, examined: 0, removed: 0 };
      const kinds = ['entry', 'copy', 'follow'] as const;
      while (cursor.factKind < kinds.length && facts.pages < 100) {
        const page = await purgePage(accountId, kinds[cursor.factKind]!, cursor.factAfter);
        facts.pages++;
        facts.examined += page.examined;
        facts.removed += page.removed;
        if (page.exhausted) {
          cursor.factKind++;
          cursor.factAfter = null;
        } else {
          if (page.after === null) throw new Error('Library erasure page made no progress');
          cursor.factAfter = page.after;
        }
      }
      const graph =
        cursor.factKind === kinds.length
          ? await runOwnedGraphSegment(accountId, cursor.segment, cursor.graph, graphPage)
          : null;
      if (graph) cursor.graph = graph.cursor;
      const continuation =
        cursor.factKind < kinds.length || !graph?.exhausted ? { ...cursor, segment: cursor.segment + 1 } : null;
      if (continuation) await continueErasure(accountId, continuation);
      const final = await inspect(accountId);
      if (final.outcome !== null) return { state: 'acknowledged', outcome: final.outcome };
      // Local exhaustion is not proof of foreign copies or shared producer custody.
      return {
        state: 'pending',
        facts,
        owned: graph?.stats ?? { pages: 0, removed: 0 },
        continuation,
        remainingStores: final.remainingStores,
        blockers: [
          ...BLOCKERS,
          ...(cursor.graph.blockedCollection === null
            ? []
            : [
                `collection:${cursor.graph.blockedCollection}: public-history destination withdrawal/fence not committed; source retained`,
              ]),
        ],
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
