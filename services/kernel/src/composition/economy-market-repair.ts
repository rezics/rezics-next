import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { PLATFORM_RESOURCE } from '../access/bootstrap-governance.ts';
import { lockNativeEconomyAdmission } from '../access/index.ts';
import {
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { isEconomyBookId } from '../economy/contract.ts';
import type { EconomyMarketRepairPort, MarketRepairAcceptance } from '../economy/market-repair-routes.ts';
import { ProblemError } from '../http/problem-error.ts';
import { partitionOf } from '../route/route.ts';

type MarketRepairOwner = Readonly<{ bookId: string; node: string; itemHomeId: string }>;
export type MarketRepairEnqueue = (
  tx: CommandTransaction,
  input: MarketRepairOwner & Readonly<{ transactionId: string; tradeId: string }>,
) => Promise<Readonly<{ kind: 'queued' | 'replayed' | 'conflict' | 'not_found' | 'invalid_owner_request' }>>;

/** Accept a single existing trade into the private owner's queue. The command does not advance owner work. */
export function createNativeEconomyMarketRepair(
  pool: Pool,
  { bookId, itemHomeId, node }: MarketRepairOwner,
  enqueue: MarketRepairEnqueue,
): EconomyMarketRepairPort {
  if (!isEconomyBookId(bookId) || !isEconomyBookId(itemHomeId) || !node.trim() || node.length > 255)
    throw new TypeError('Invalid market repair owner binding');

  return {
    async request({ actor, tradeId, key, deadline, authorization: parent }) {
      if (
        !actor.scopes.includes('market:repair') ||
        parent.action !== 'market:repair' ||
        parent.resource.route !== PLATFORM_RESOURCE.route ||
        parent.resource.id !== PLATFORM_RESOURCE.id
      )
        throw new ProblemError('forbidden');
      if (!/^[0-9a-f]{64}$/.test(tradeId)) throw new ProblemError('invalid_request');
      const authorization: CommandAuthorization = {
        ...parent,
        async authorize(tx, attempt, evidence) {
          const admitted = await lockNativeEconomyAdmission(tx, { accountId: actor.accountId, node });
          if (admitted === 'unavailable') throw new ProblemError('dependency_unavailable');
          if (admitted !== 'allowed') throw new ProblemError('platform_closed');
          if ((await parent.authorize(tx, attempt, evidence)) !== 'execute') throw parent.denied();
          return 'execute';
        },
      };
      const identity = principalCommandIdentity(actor);
      const kind = 'economy.market.repair';
      const digest = createHash('sha256')
        .update(JSON.stringify([identity, kind, bookId, node, itemHomeId, tradeId]))
        .digest();
      return runCommand<MarketRepairAcceptance>(
        pool,
        {
          ...identity,
          partition: partitionOf(PLATFORM_RESOURCE.route),
          deadline,
          authorization,
          receipt: { kind, key, digest },
        },
        async (tx, { transactionId }) => {
          const result = await enqueue(tx, { bookId, itemHomeId, node, tradeId, transactionId });
          switch (result.kind) {
            case 'not_found':
              throw new ProblemError('not_found');
            case 'conflict':
              throw new ProblemError('idempotency_conflict');
            case 'invalid_owner_request':
              throw new ProblemError('dependency_unavailable');
            case 'queued':
            case 'replayed':
              return {
                value: { reconciliation: 'queued' },
                events: [{ type: 'com.rezics.economy.market.repair_accepted.v1', data: {} }],
              };
          }
        },
      );
    },
  };
}
