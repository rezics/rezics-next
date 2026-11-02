import { purchaseHistorySearch, type PurchaseHistoryPosition } from './purchase-return';
import { orderHistoryAddress, OrderHistoryAddressPage, type OrderHistorySearch } from './order-history-address';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isNotFound } from '@tanstack/react-router';
import { personalRead } from '../kernel/query';
import { PendingPage } from '../shell/pending';
import { ErrorPage, NotFoundPage } from '../shell/shell';
import { readBuyerOrdersCurrent, type BuyerOrdersAddress, type BuyerOrdersCurrentRead } from './orders';
import { OrdersPage } from './orders-page';
import { useBuyerCurrentOrigin, type BuyerCurrentOrigin } from './buyer-current-origin';

function matches(
  value: BuyerOrdersCurrentRead | null | undefined,
  subject: string,
  address: BuyerOrdersAddress,
): value is BuyerOrdersCurrentRead {
  return (
    value?.sessionSubject === subject &&
    value.requested.cursor === address.cursor &&
    value.requested.locale === address.locale
  );
}

/** The actual observed viewer, admission and address own the entire private history. */
export function OrdersCurrent({
  initial,
  search,
  locale,
}: {
  initial: BuyerOrdersCurrentRead | null;
  search: OrderHistorySearch;
  locale: string;
}) {
  const position = orderHistoryAddress(search.cursor);
  const address = { cursor: position.kind === 'ready' ? position.cursor : null, locale };
  const session = useBuyerCurrentOrigin('order.list', JSON.stringify([locale, search]));
  const { hydrated, admitted, origin } = session;
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial?.sessionSubject;
  const allowed = !hydrated || admitted;
  if (position.kind === 'malformed')
    return <OrderHistoryAddressPage locale={locale} history={purchaseHistorySearch(search)} />;
  if (!subject) {
    if (hydrated && session.state === 'signed-out') return <NotFoundPage />;
    if (hydrated && session.state === 'unavailable') return <ErrorPage />;
    return <PendingPage />;
  }
  if (!allowed) return <NotFoundPage />;
  return (
    <CurrentOrdersRead
      key={session.generation}
      subject={subject}
      address={address}
      initial={initial}
      seed={session.seed}
      hydrated={hydrated}
      origin={origin}
      history={{ ...search, ordersCursor: address.cursor ?? undefined }}
    />
  );
}

function CurrentOrdersRead({
  subject,
  address,
  initial,
  seed,
  hydrated,
  origin,
  history,
}: {
  subject: string;
  address: BuyerOrdersAddress;
  initial: BuyerOrdersCurrentRead | null;
  seed: boolean;
  hydrated: boolean;
  origin: BuyerCurrentOrigin;
  history: PurchaseHistoryPosition;
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? initial : undefined));
  const query = useQuery({
    ...personalRead,
    queryKey: ['orders-current', subject, address.cursor, address.locale, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.isCurrent()) throw new Error('Obsolete order history read');
      const value = await readBuyerOrdersCurrent({
        data: { ...(address.cursor ? { cursor: address.cursor } : {}), locale: address.locale },
      });
      if (!origin.isCurrent() || !matches(value, subject, address)) throw new Error('Unaccepted order history read');
      return value;
    },
    initialData,
    refetchOnMount: !initialData,
    gcTime: 0,
    retry: false,
    throwOnError: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (hydrated && !origin.isCurrent()) return <PendingPage />;
  if (query.isError || (query.data && !matches(query.data, subject, address)))
    return isNotFound(query.error) ? (
      <NotFoundPage />
    ) : (
      <ErrorPage
        retrying={query.isFetching}
        onRetry={() => {
          if (origin.isCurrent()) void query.refetch();
        }}
      />
    );
  if (!matches(query.data, subject, address)) return <PendingPage />;
  return (
    <OrdersPage
      page={query.data.page}
      locale={address.locale}
      continuation={address.cursor !== null}
      history={history}
    />
  );
}
