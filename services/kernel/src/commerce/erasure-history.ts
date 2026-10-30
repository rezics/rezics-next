import type { CommandTransaction } from '../command/command.ts';
import { ACCOUNT_ROLE_BITS } from '../history/contracts.ts';
import type { AccountReference } from '../history/locator.ts';
import { declareCommandHistory, registerCommandHistoryKind, unionHistoryScope } from '../history/record.ts';
import { routeOf } from '../route/route.ts';

// Permanent owner-assigned IDs, shared by API producers and the default worker.
const kinds = {
  'commerce.offer.create': 1000,
  'commerce.offer.delist': 1001,
  'commerce.offer.revise': 1002,
  'commerce.order.create': 1003,
} as const;
for (const [kind, id] of Object.entries(kinds)) registerCommandHistoryKind(kind, id);

/** Only ordinary writes use the shared sink's reject-after-seal protocol. Financial
 * reconciliation must remain available after T and needs the producer's late-copy
 * custody port before conversion. This registration declares no family coverage.
 */
export async function declareCommerceCommandHistory(
  tx: CommandTransaction,
  kind: keyof typeof kinds,
  source: { creatorAccountId: string; buyerAccountId?: string },
): Promise<void> {
  function reference(accountId: string, roles: number): AccountReference {
    const accountRoute = routeOf(accountId);
    if (accountRoute === null) throw new TypeError('Invalid Commerce history account');
    return { accountRoute, accountId, roles };
  }
  const accounts = [reference(source.creatorAccountId, ACCOUNT_ROLE_BITS.creator)];
  if (source.buyerAccountId !== undefined)
    accounts.push(reference(source.buyerAccountId, ACCOUNT_ROLE_BITS.buyer));
  // Access supplies this physical attempt's actor/principal/human/delegate evidence.
  // Native seller/buyer associations also cover copies on another account's home.
  await declareCommandHistory(tx, kind, {
    response: unionHistoryScope('command-receipt/v1', accounts),
    events: [unionHistoryScope('outbox-event/v1', accounts)],
  });
}
