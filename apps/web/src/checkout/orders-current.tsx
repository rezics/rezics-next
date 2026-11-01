import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isNotFound } from '@tanstack/react-router';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { PendingPage } from '../shell/pending';
import { ErrorPage, NotFoundPage } from '../shell/shell';
import { readBuyerOrdersCurrent, type BuyerOrdersAddress, type BuyerOrdersCurrentRead } from './orders';
import { OrdersPage } from './orders-page';

const subscribe = () => () => {};
function matches(
  value: BuyerOrdersCurrentRead | undefined,
  subject: string,
  address: BuyerOrdersAddress,
): value is BuyerOrdersCurrentRead {
  return (
    value?.sessionSubject === subject &&
    value.requested.cursor === address.cursor &&
    value.requested.locale === address.locale
  );
}

/** Identity, admission and address replacement retire the entire private history during render. */
export function OrdersCurrent({
  initial,
  search,
  locale,
}: {
  initial: BuyerOrdersCurrentRead;
  search: { cursor?: string };
  locale: string;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const admitted = useOperation('order.list');
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const allowed = !hydrated || admitted;
  const address = { cursor: search.cursor || null, locale };
  const key = JSON.stringify([subject, allowed, address.cursor, address.locale]);
  const [scope, setScope] = useState({ key, generation: 0, seed: true });
  const origin = useRef({ key, active: true });
  if (origin.current.key !== key) {
    origin.current.active = false;
    origin.current = { key, active: true };
  }
  if (scope.key !== key) {
    setScope({ key, generation: scope.generation + 1, seed: false });
  }
  if (!subject) {
    if (hydrated && session.state === 'signed-out') return <NotFoundPage />;
    if (hydrated && session.state === 'unavailable') return <ErrorPage />;
    return <PendingPage />;
  }
  if (!allowed) return <NotFoundPage />;
  return (
    <CurrentOrdersRead
      key={scope.generation}
      subject={subject}
      address={address}
      initial={initial}
      seed={scope.seed}
      hydrated={hydrated}
      origin={origin.current}
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
}: {
  subject: string;
  address: BuyerOrdersAddress;
  initial: BuyerOrdersCurrentRead;
  seed: boolean;
  hydrated: boolean;
  origin: { active: boolean };
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matches(initial, subject, address) ? initial : undefined));
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery({
    ...personalRead,
    queryKey: ['orders-current', subject, address.cursor, address.locale, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.active || !mounted.current) throw new Error('Obsolete order history read');
      const value = await readBuyerOrdersCurrent({
        data: { ...(address.cursor ? { cursor: address.cursor } : {}), locale: address.locale },
      });
      if (!origin.active || !mounted.current || !matches(value, subject, address))
        throw new Error('Unaccepted order history read');
      return value;
    },
    initialData,
    gcTime: 0,
    retry: false,
    throwOnError: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isError || (query.data && !matches(query.data, subject, address)))
    return isNotFound(query.error) ? (
      <NotFoundPage />
    ) : (
      <ErrorPage
        retrying={query.isFetching}
        onRetry={() => {
          if (origin.active && mounted.current) void query.refetch();
        }}
      />
    );
  if (!matches(query.data, subject, address)) return <PendingPage />;
  return <OrdersPage page={query.data.page} locale={address.locale} />;
}
