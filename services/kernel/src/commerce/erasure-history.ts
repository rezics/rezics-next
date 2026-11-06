import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { declareCommandHistory } from '../history/application/index.ts';
import { ACCOUNT_ROLE_BITS, type AccountReference, unionHistoryScope } from '../history/contract/index.ts';

// Permanent owner-assigned IDs, shared by API producers and the default worker.
type CommerceHistoryKind =
  | 'commerce.offer.create'
  | 'commerce.offer.delist'
  | 'commerce.offer.revise'
  | 'commerce.order.create';

/** Only ordinary writes use the shared sink's reject-after-seal protocol. Financial
 * reconciliation must remain available after T and needs the producer's late-copy
 * custody port before conversion. This registration declares no family coverage.
 */
export async function declareCommerceCommandHistory(
  tx: CommandTransaction,
  kind: CommerceHistoryKind,
  source: { creatorAccountId: string; buyerAccountId?: string },
): Promise<void> {
  function reference(accountId: string, roles: number): AccountReference {
    const accountRoute = routeOf(accountId);
    if (accountRoute === null) throw new TypeError('Invalid Commerce history account');
    return { accountRoute, accountId, roles };
  }
  const accounts = [reference(source.creatorAccountId, ACCOUNT_ROLE_BITS.creator)];
  if (source.buyerAccountId !== undefined) accounts.push(reference(source.buyerAccountId, ACCOUNT_ROLE_BITS.buyer));
  // Access supplies this physical attempt's actor/principal/human/delegate evidence.
  // Native seller/buyer associations also cover copies on another account's home.
  await declareCommandHistory(tx, kind, {
    response: unionHistoryScope('command-receipt/v1', accounts),
    events: [unionHistoryScope('outbox-event/v1', accounts)],
  });
}
