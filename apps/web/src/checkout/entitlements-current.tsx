import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
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

const subscribe = () => () => {};
type Page = BuyerEntitlementsPage | BuyerEntitlementPage;
type PageProps<T> = { page: T; locale: string; retry?: () => void; continuation?: boolean };
type CurrentProps<T extends Page> = {
  initial: BuyerEntitlementsCurrentRead<T>;
  address: EntitlementsAddress;
  read: (address: EntitlementsAddress) => Promise<BuyerEntitlementsCurrentRead<T>>;
  Presentation: ComponentType<PageProps<T>>;
};
type Origin = { active: boolean };
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
}: {
  initial: BuyerEntitlementsCurrentRead;
  locale: string;
  cursor?: string | undefined;
}) {
  return (
    <EntitlementsBoundary
      initial={initial}
      address={{ kind: 'list', locale, cursor: cursor || null }}
      read={readList}
      Presentation={EntitlementsPage}
    />
  );
}

export function EntitlementCurrent({
  initial,
  locale,
  id,
}: {
  initial: BuyerEntitlementCurrentRead;
  locale: string;
  id: string;
}) {
  return (
    <EntitlementsBoundary
      initial={initial}
      address={{ kind: 'detail', locale, id }}
      read={readDetail}
      Presentation={EntitlementPage}
    />
  );
}

/** Retire during render so no private child survives an observed authority or address replacement. */
function EntitlementsBoundary<T extends Page>(props: CurrentProps<T>) {
  const { initial, address, Presentation } = props;
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const purchases = useOperation('entitlement.get');
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const admitted = hydrated ? purchases : !!initial.sessionSubject;
  const key = JSON.stringify([subject ?? null, admitted, address]);
  const [scope, setScope] = useState(() => ({ key, generation: 0, seed: true, origin: { active: true } }));
  if (scope.key !== key) {
    scope.origin.active = false;
    setScope({ key, generation: scope.generation + 1, seed: false, origin: { active: true } });
  }
  useLayoutEffect(() => {
    scope.origin.active = true;
    return () => {
      scope.origin.active = false;
    };
  }, [scope.origin]);
  const retrySession = useCallback(() => {
    if (scope.origin.active && hydrated) window.location.reload();
  }, [scope.origin, hydrated]);
  if (!subject || !admitted) {
    const kind =
      hydrated && session.state === 'unavailable'
        ? 'unavailable'
        : hydrated && (session.state === 'unknown' || (session.state === 'signed-in' && !subject))
          ? 'preparing'
          : 'denied';
    return <Presentation page={{ kind } as T} locale={address.locale} retry={retrySession} />;
  }
  return (
    <EntitlementsRead
      key={scope.generation}
      {...props}
      subject={subject}
      hydrated={hydrated}
      seed={scope.seed}
      origin={scope.origin}
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
}: CurrentProps<T> & { subject: string; hydrated: boolean; seed: boolean; origin: Origin }) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState<Outcome<T> | undefined>(() =>
    seed && matches(initial, subject, address) ? { kind: 'accepted', value: initial } : undefined,
  );
  const query = useQuery<Outcome<T> | null>({
    ...personalRead,
    queryKey: ['buyer-entitlements-current', subject, true, address.kind, address, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.active) return null;
      try {
        const value = await read(address);
        return origin.active && matches(value, subject, address) ? { kind: 'accepted', value } : null;
      } catch {
        return origin.active ? { kind: 'failed' } : null;
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
  if (query.data && query.data !== display.observed) {
    setDisplay({
      observed: query.data,
      page: query.data.kind === 'accepted' ? query.data.value.page : ({ kind: 'unavailable' } as T),
    });
  }
  const retry = useCallback(() => {
    if (origin.active) void query.refetch();
  }, [origin, query.refetch]);
  return (
    <Presentation
      page={display.page}
      locale={address.locale}
      continuation={address.kind === 'list' && address.cursor !== null}
      retry={retry}
    />
  );
}
