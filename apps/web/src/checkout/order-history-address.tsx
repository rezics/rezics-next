import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { purchaseHistoryHref, purchaseHistorySearch, type PurchaseHistoryPosition } from './purchase-return';

export type OrderHistorySearch = PurchaseHistoryPosition & { cursor?: unknown };

/** Keep malformed read positions available for served recovery, never as first-page input. */
export function orderHistorySearch(search: Record<string, unknown>): OrderHistorySearch {
  return {
    ...purchaseHistorySearch(search),
    ...(search.cursor === undefined || search.cursor === '' ? {} : { cursor: search.cursor }),
  };
}

export function orderHistoryAddress(cursor: unknown): { kind: 'ready'; cursor: string | null } | { kind: 'malformed' } {
  if (cursor === undefined || cursor === '') return { kind: 'ready', cursor: null };
  if (typeof cursor !== 'string' || cursor.length > 4096) return { kind: 'malformed' };
  return { kind: 'ready', cursor };
}

/** A document navigation makes the choice explicit and reloads with current reader authority. */
export function OrderHistoryAddressPage({ locale, history }: { locale: string; history: PurchaseHistoryPosition }) {
  return (
    <section className="max-w-4xl space-y-6" aria-labelledby="buyer-orders-address-heading">
      <PageHeading id="buyer-orders-address-heading">{m.buyer_orders_address_heading()}</PageHeading>
      <p>{m.buyer_orders_address_explanation()}</p>
      <a
        href={purchaseHistoryHref(locale, 'orders', { entitlementsCursor: history.entitlementsCursor })}
        className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
      >
        {m.buyer_orders_address_restart()}
      </a>
    </section>
  );
}
