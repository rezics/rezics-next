import type { PurchaseHistoryPosition } from './purchase-return';
import { useCallback, useState, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import {
  readBuyerEntitlementCurrent,
  readBuyerEntitlementsCurrent,
  sameEntitlementsAddress,
  type BuyerEntitlementCurrentRead,
  type BuyerEntitlementPage,
  type BuyerEntitlementsCurrentRead,
  type BuyerEntitlementsPage,
  type EntitlementsAddress,
} from './entitlements';
import { EntitlementPage } from './entitlement-page';
import { EntitlementsPage } from './entitlements-page';
import { useBuyerCurrentOrigin, type BuyerCurrentOrigin } from './buyer-current-origin';

type Page = BuyerEntitlementsPage | BuyerEntitlementPage;
type PageProps<T> = {
  page: T;
  locale: string;
  retry?: () => void;
  continuation?: boolean;
  history?: PurchaseHistoryPosition | undefined;
};
type CurrentProps<T extends Page> = {
  initial: BuyerEntitlementsCurrentRead<T>;
  history?: PurchaseHistoryPosition | undefined;
  address: EntitlementsAddress;
  read: (address: EntitlementsAddress) => Promise<BuyerEntitlementsCurrentRead<T>>;
  Presentation: ComponentType<PageProps<T>>;
};
type Outcome<T> = { kind: 'accepted'; value: BuyerEntitlementsCurrentRead<T> } | { kind: 'failed' };

function matches<T>(value: BuyerEntitlementsCurrentRead<T>, subject: string, address: EntitlementsAddress) {
  return value.sessionSubject === subject && sameEntitlementsAddress(value.requested, address);
}

async function readList(address: EntitlementsAddress) {
  if (address.kind !== 'list') throw new Error('Expected entitlement list address');
  return readBuyerEntitlementsCurrent({
    data: { locale: address.locale, ...(address.cursor ? { cursor: address.cursor } : {}) },
  });
}

async function readDetail(address: EntitlementsAddress) {
  if (address.kind !== 'detail') throw new Error('Expected entitlement detail address');
  return readBuyerEntitlementCurrent({ data: { locale: address.locale, id: address.id } });
}

export function EntitlementsCurrent({
  initial,
  locale,
  cursor,
  history,
}: {
  initial: BuyerEntitlementsCurrentRead;
  locale: string;
  cursor?: string | undefined;
  history?: PurchaseHistoryPosition | undefined;
}) {
  return (
    <EntitlementsBoundary
      initial={initial}
      address={{ kind: 'list', locale, cursor: cursor || null }}
      history={{ ...history, entitlementsCursor: cursor || undefined }}
      read={readList}
      Presentation={EntitlementsPage}
    />
  );
}

export function EntitlementCurrent({
  initial,
  locale,
  id,
  history,
}: {
  initial: BuyerEntitlementCurrentRead;
  locale: string;
  id: string;
  history?: PurchaseHistoryPosition | undefined;
}) {
  return (
    <EntitlementsBoundary
      initial={initial}
      address={{ kind: 'detail', locale, id }}
      history={history}
      read={readDetail}
      Presentation={EntitlementPage}
    />
  );
}

/** Observed cache replacement and render-time address replacement permanently retire private work. */
function EntitlementsBoundary<T extends Page>(props: CurrentProps<T>) {
  const { initial, address, Presentation } = props;
  const session = useBuyerCurrentOrigin('entitlement.get', JSON.stringify(address));
  const { hydrated, origin } = session;
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const admitted = hydrated ? session.admitted : !!initial.sessionSubject;
  const retrySession = useCallback(() => {
    if (origin.isObserved() && hydrated) window.location.reload();
  }, [origin, hydrated]);
  if (!subject || !admitted) {
    const kind =
      hydrated && session.state === 'unavailable'
        ? 'unavailable'
        : hydrated && (session.state === 'unknown' || (session.state === 'signed-in' && !subject))
          ? 'preparing'
          : 'denied';
    return <Presentation page={{ kind } as T} locale={address.locale} retry={retrySession} history={props.history} />;
  }
  return (
    <EntitlementsRead
      key={session.generation}
      {...props}
      subject={subject}
      hydrated={hydrated}
      seed={session.seed}
      origin={origin}
    />
  );
}

function EntitlementsRead<T extends Page>({
  initial,
  address,
  read,
  Presentation,
  subject,
  hydrated,
  seed,
  origin,
  history,
}: CurrentProps<T> & { subject: string; hydrated: boolean; seed: boolean; origin: BuyerCurrentOrigin }) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState<Outcome<T> | undefined>(() =>
    seed && matches(initial, subject, address) ? { kind: 'accepted', value: initial } : undefined,
  );
  const query = useQuery<Outcome<T> | null>({
    ...personalRead,
    queryKey: ['buyer-entitlements-current', subject, true, address.kind, address, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.isCurrent()) return null;
      try {
        const value = await read(address);
        return origin.isCurrent() && matches(value, subject, address) ? { kind: 'accepted', value } : null;
      } catch {
        return origin.isCurrent() ? { kind: 'failed' } : null;
      }
    },
    ...(initialData ? { initialData } : {}),
    // The loader already made this lifetime's read. Replacements and deliberate retries read anew.
    refetchOnMount: !initialData,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [display, setDisplay] = useState(() => ({
    observed: initialData as Outcome<T> | undefined,
    page: initialData?.kind === 'accepted' ? initialData.value.page : ({ kind: 'preparing' } as T),
  }));
  // Mismatched results are ignored, including their completion state. Only this lifetime's
  // accepted responses or actual transport failures can replace its current presentation.
  if ((!hydrated || origin.isCurrent()) && query.data && query.data !== display.observed) {
    setDisplay({
      observed: query.data,
      page: query.data.kind === 'accepted' ? query.data.value.page : ({ kind: 'unavailable' } as T),
    });
  }
  const retry = useCallback(() => {
    if (origin.isCurrent()) void query.refetch();
  }, [origin, query.refetch]);
  return (
    <Presentation
      page={hydrated && !origin.isCurrent() ? ({ kind: 'preparing' } as T) : display.page}
      locale={address.locale}
      continuation={address.kind === 'list' && address.cursor !== null}
      retry={retry}
      history={history}
    />
  );
}
