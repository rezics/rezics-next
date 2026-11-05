import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { purchaseHistoryHref, type PurchaseHistoryPosition } from './purchase-return';
import type { BuyerHistoryList, BuyerHistoryMovement } from './buyer-history-windows';
import type { BuyerHistoryNavigation } from './buyer-history-visit';

export function BuyerHistoryControls({
  list,
  locale,
  history,
  continuation,
  next,
  navigation,
  label,
}: {
  list: BuyerHistoryList;
  locale: string;
  history: PurchaseHistoryPosition;
  continuation: boolean;
  next: string | null;
  navigation?: BuyerHistoryNavigation | undefined;
  label: string;
}) {
  const previous = navigation?.previous;
  if (!continuation && !next && previous === undefined) return null;
  const position = (cursor: string | null) => ({
    ...history,
    [list === 'orders' ? 'ordersCursor' : 'entitlementsCursor']: cursor ?? undefined,
  });
  const action = (movement: BuyerHistoryMovement, cursor: string | null, text: string) => (
    <a
      href={purchaseHistoryHref(locale, list, position(cursor))}
      onClick={(event) => navigation?.move(movement, cursor, event)}
      className={buttonVariants({ variant: 'outline', className: 'min-h-11 whitespace-normal text-center' })}
    >
      {text}
    </a>
  );
  return (
    <nav aria-label={label} className="flex flex-wrap gap-3">
      {previous !== undefined ? action('previous', previous, m.buyer_history_previous()) : null}
      {continuation ? action('first', null, m.buyer_history_first()) : null}
      {next ? action('next', next, m.buyer_history_next()) : null}
    </nav>
  );
}
