import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { addressLease, type AddressLease } from '../../../../session';
import { subjectVisitReturn } from '../../../pages/subject-visit-navigation';
import type { ScreenEpisodeRead } from '../read';
import {
  SCREEN_EPISODE_VISIT_LIMIT,
  screenEpisodeContinuationHref,
  screenEpisodeCursorIntent,
  screenEpisodeEntryElementId,
  screenEpisodeReadingAddress,
  screenEpisodeRestartHref,
  screenEpisodeWindowAddress,
  type ScreenEpisodeOrigin,
} from '../navigation';

type NavigationKind = 'continue' | 'previous' | 'start';
type Address = {
  key: string;
  reading: string;
  href: string;
  cursor?: string;
  previous?: string;
};
type NavigationState = { source: string; addresses: Address[] };
type PendingNavigation = {
  source: string;
  target: string;
  from: string;
  kind: NavigationKind;
};
type FocusTicket = {
  source: string;
  target: string;
  membership?: string;
  element: Element | null;
  allowBody: boolean;
  lease: AddressLease;
};

type ReturnReceipt = {
  from: string;
  child: string;
  target: string;
  parentReturn?: string;
  focusMembership?: string;
  observation: object;
};

let returnReceipt: ReturnReceipt | undefined;

function canonicalAddress(value: string, removeVia = false): string | undefined {
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 32768) return;
  try {
    const url = new URL(value, 'https://rezics.invalid');
    if (url.origin !== 'https://rezics.invalid') return;
    if (removeVia) url.searchParams.delete('via');
    const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    );
    const query = new URLSearchParams(entries).toString();
    return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
  } catch {
    return;
  }
}

function routeAddress(origin: ScreenEpisodeOrigin): string {
  return `${origin.pathname}${origin.searchStr}${origin.hash ?? ''}`;
}

function routeWithoutVia(value: string): string | undefined {
  return canonicalAddress(value, true);
}

function originFromHref(href: string): ScreenEpisodeOrigin | undefined {
  const address = canonicalAddress(href);
  if (!address) return;
  const url = new URL(address, 'https://rezics.invalid');
  return { pathname: url.pathname, searchStr: url.search, hash: url.hash };
}

function localActivation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

function setEntryReceipt({
  from,
  childHref,
  parentReturn,
  locale,
  observation,
}: {
  from: string;
  childHref: string;
  parentReturn?: string;
  locale: string;
  observation: object;
}) {
  const target = originFromHref(childHref);
  if (!target) return;
  const targetUrl = new URL(childHref, 'https://rezics.invalid');
  const via = subjectVisitReturn(targetUrl.searchParams.get('via'), locale);
  const child = routeWithoutVia(`${target.pathname}${target.searchStr}`);
  const expected = via && canonicalAddress(via);
  const safeParentReturn = parentReturn ? subjectVisitReturn(parentReturn, locale) : undefined;
  if (!child || !expected) return;
  returnReceipt = {
    from: canonicalAddress(from) ?? from,
    child,
    target: expected,
    ...(safeParentReturn ? { parentReturn: safeParentReturn } : {}),
    observation,
  };
}

function setReturnReceipt({
  from,
  target,
  focusMembership,
  locale,
  observation,
}: {
  from: string;
  target: string;
  focusMembership?: string;
  locale: string;
  observation: object;
}) {
  const safeTarget = subjectVisitReturn(target, locale);
  const child = routeWithoutVia(from);
  const expected = safeTarget && canonicalAddress(safeTarget);
  if (!child || !expected) return;
  const previous = returnReceipt;
  const inherited =
    previous?.observation === observation && previous.child === child ? previous.parentReturn : undefined;
  returnReceipt = {
    from: canonicalAddress(from) ?? from,
    child,
    target: expected,
    ...(inherited ? { parentReturn: inherited } : {}),
    ...(focusMembership ? { focusMembership } : {}),
    observation,
  };
}

function resolveReturnReceipt(
  current: string,
  childSearch: string,
  locale: string,
  observation: object,
): { parentReturn?: string; focusMembership?: string } | undefined {
  const saved = returnReceipt;
  if (!saved) return;
  if (saved.observation !== observation) {
    returnReceipt = undefined;
    return;
  }
  const currentAddress = canonicalAddress(current);
  if (currentAddress === saved.target) {
    returnReceipt = undefined;
    return {
      ...(saved.parentReturn ? { parentReturn: saved.parentReturn } : {}),
      ...(saved.focusMembership ? { focusMembership: saved.focusMembership } : {}),
    };
  }
  const safeVia = subjectVisitReturn(new URLSearchParams(childSearch).get('via'), locale);
  if (routeWithoutVia(current) === saved.child && safeVia === saved.target)
    return saved.parentReturn ? { parentReturn: saved.parentReturn } : {};
  if (currentAddress !== saved.from) returnReceipt = undefined;
  return;
}

export function useScreenEpisodeVisit({
  sourceKey,
  pageKey,
  origin,
  locale,
  observation,
  observationCurrent,
  read,
  loading,
  settledKey,
  directReturn,
}: {
  sourceKey: string;
  pageKey: string;
  origin: ScreenEpisodeOrigin;
  locale: string;
  observation: object;
  observationCurrent: () => boolean;
  read?: ScreenEpisodeRead;
  loading: boolean;
  settledKey: string;
  directReturn?: { href: string; membershipId: string };
}) {
  const currentHref = routeAddress(origin);
  const currentAddress = screenEpisodeWindowAddress(origin);
  const currentCursor = screenEpisodeCursorIntent(origin.searchStr);
  const reading = `${sourceKey}:${screenEpisodeReadingAddress(origin)}`;
  const ownerRef = useRef<{ source: string; lease: AddressLease } | undefined>(undefined);
  if (ownerRef.current?.source !== sourceKey) {
    ownerRef.current?.lease.retire();
    const owner = { source: sourceKey, lease: undefined as unknown as AddressLease };
    owner.lease = addressLease(() => ownerRef.current === owner && observationCurrent());
    ownerRef.current = owner;
  }
  const owner = ownerRef.current!;
  useEffect(() => () => owner.lease.retire(), [owner]);

  const [navigation, setNavigation] = useState<NavigationState>({ source: sourceKey, addresses: [] });
  if (navigation.source !== sourceKey) setNavigation({ source: sourceKey, addresses: [] });
  const addresses = navigation.source === sourceKey ? navigation.addresses : [];
  const pending = useRef<PendingNavigation | undefined>(undefined);
  const focus = useRef<FocusTicket | undefined>(undefined);
  const lastPage = useRef(pageKey);
  if (lastPage.current !== pageKey) {
    lastPage.current = pageKey;
    const intent = pending.current;
    if (intent && (intent.source !== sourceKey || intent.target !== currentAddress)) {
      pending.current = undefined;
      focus.current = undefined;
    }
    if (focus.current && (focus.current.source !== sourceKey || focus.current.target !== currentAddress))
      focus.current = undefined;
  }
  const [resolvedReturn, setResolvedReturn] = useState<{ page: string; href?: string }>();
  useLayoutEffect(() => {
    const restored = resolveReturnReceipt(currentHref, origin.searchStr, locale, observation);
    if (!restored) {
      setResolvedReturn(undefined);
      return;
    }
    setResolvedReturn({ page: pageKey, ...(restored.parentReturn ? { href: restored.parentReturn } : {}) });
    if (restored.focusMembership) {
      focus.current = {
        source: sourceKey,
        target: currentAddress,
        membership: restored.focusMembership,
        element: null,
        allowBody: true,
        lease: owner.lease,
      };
    }
  }, [currentHref, currentAddress, pageKey, sourceKey, locale, observation, owner]);

  const chosenReturn =
    directReturn ??
    (resolvedReturn?.page === pageKey && resolvedReturn.href
      ? (() => {
          const value = subjectVisitReturn(resolvedReturn.href, locale);
          if (!value) return undefined;
          const url = new URL(value, 'https://rezics.invalid');
          const membershipId = new URLSearchParams(url.search).get('screenSelection');
          return membershipId ? { href: value, membershipId } : undefined;
        })()
      : undefined);

  useEffect(() => {
    if (!owner.lease.current() || loading || !read?.ok) return;
    setNavigation((previous) => {
      const previousAddresses = previous.source === sourceKey ? previous.addresses : [];
      const intent = pending.current;
      const matches = intent?.source === sourceKey && intent.target === currentAddress;
      let addressesForReading = previousAddresses;
      if (matches && intent.kind === 'start')
        addressesForReading = addressesForReading.filter((address) => address.reading !== reading);
      const known = addressesForReading.find((address) => address.key === currentAddress);
      if (known)
        return previous.source === sourceKey && addressesForReading === previousAddresses
          ? previous
          : { source: sourceKey, addresses: addressesForReading };
      const previousKey = matches && intent.kind === 'continue' ? intent.from : undefined;
      const cursor = currentCursor.kind === 'cursor' ? currentCursor.cursor : undefined;
      const next: Address = {
        key: currentAddress,
        reading,
        href: currentAddress,
        ...(cursor ? { cursor } : {}),
        ...(previousKey ? { previous: previousKey } : {}),
      };
      return { source: sourceKey, addresses: [...addressesForReading, next].slice(-SCREEN_EPISODE_VISIT_LIMIT) };
    });
    if (pending.current?.source === sourceKey && pending.current.target === currentAddress) pending.current = undefined;
  }, [owner, sourceKey, currentAddress, reading, currentCursor, read, loading, settledKey]);

  useEffect(() => {
    const consume = () => {
      focus.current = undefined;
    };
    const onFocus = (event: FocusEvent) => {
      const ticket = focus.current;
      if (!ticket || event.target === document.body) return;
      if (event.target !== ticket.element && (ticket.element?.isConnected || !ticket.allowBody)) consume();
    };
    document.addEventListener('pointerdown', consume, true);
    document.addEventListener('keydown', consume, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('pointerdown', consume, true);
      document.removeEventListener('keydown', consume, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, []);

  useLayoutEffect(() => {
    const ticket = focus.current;
    if (loading || !ticket || ticket.source !== sourceKey || ticket.target !== currentAddress) return;
    focus.current = undefined;
    if (!ticket.lease.current()) return;
    const active = document.activeElement;
    if (active !== ticket.element && !(ticket.allowBody && active === document.body)) return;
    const selected =
      ticket.membership && read?.ok && read.entries.some((entry) => entry.membershipId === ticket.membership);
    const admittedEntry = selected
      ? document.getElementById(screenEpisodeEntryElementId(ticket.membership!) ?? '')
      : null;
    const element =
      admittedEntry ??
      (read?.ok
        ? document.querySelector('[data-screen-episode-list]')
        : (document.querySelector('[data-screen-episode-recovery]') ??
          document.querySelector('[data-screen-episode-list]')));
    (element as HTMLElement | null)?.focus();
  }, [loading, read, settledKey, sourceKey, currentAddress]);

  const currentDescriptor = addresses.find((address) => address.key === currentAddress);
  const pendingPrevious =
    pending.current?.source === sourceKey &&
    pending.current.target === currentAddress &&
    pending.current.kind === 'continue'
      ? addresses.find((address) => address.key === pending.current?.from)
      : undefined;
  const previous = currentDescriptor?.previous
    ? addresses.find((address) => address.key === currentDescriptor.previous)
    : pendingPrevious;
  const startHref =
    currentCursor.kind === 'cursor' || !!new URLSearchParams(origin.searchStr).get('screenSelection')
      ? screenEpisodeRestartHref(origin)
      : undefined;

  const sameReading = addresses.filter((address) => address.reading === reading);
  const repeatedCursor =
    read?.ok &&
    read.next !== null &&
    (read.next === (currentCursor.kind === 'cursor' ? currentCursor.cursor : undefined) ||
      sameReading.some((address) => address.cursor === read.next));
  const atLimit = read?.ok && read.next !== null && sameReading.length >= SCREEN_EPISODE_VISIT_LIMIT;
  const canContinue = read?.ok && read.next !== null && !repeatedCursor && !atLimit;

  function onNavigate(kind: NavigationKind, href: string, event: MouseEvent<HTMLAnchorElement>) {
    if (!localActivation(event) || !owner.lease.current()) return;
    const targetOrigin = originFromHref(href);
    if (!targetOrigin) return;
    const target = screenEpisodeWindowAddress(targetOrigin);
    pending.current = { source: sourceKey, target, from: currentAddress, kind };
    focus.current = { source: sourceKey, target, element: event.currentTarget, allowBody: true, lease: owner.lease };
  }

  function onRetry(event: MouseEvent<HTMLButtonElement>) {
    if (!owner.lease.current()) return;
    focus.current = {
      source: sourceKey,
      target: currentAddress,
      element: event.currentTarget,
      allowBody: true,
      lease: owner.lease,
    };
  }

  function onEntryNavigate(href: string, event: MouseEvent<HTMLAnchorElement>) {
    if (!localActivation(event) || !owner.lease.current()) return;
    setEntryReceipt({
      from: currentHref,
      childHref: href,
      ...(chosenReturn?.href ? { parentReturn: chosenReturn.href } : {}),
      locale,
      observation,
    });
    focus.current = undefined;
  }

  function onReturnNavigate(href: string, membershipId: string, event: MouseEvent<HTMLAnchorElement>) {
    if (!localActivation(event) || !owner.lease.current()) return;
    setReturnReceipt({ from: currentHref, target: href, focusMembership: membershipId, locale, observation });
    focus.current = undefined;
  }

  return {
    previousHref: previous?.href,
    startHref,
    canContinue: !!canContinue,
    stopped: atLimit ? ('limit' as const) : repeatedCursor ? ('cycle' as const) : undefined,
    visitKey: `${sourceKey}:${pageKey}:${settledKey}`,
    returnHref: chosenReturn?.href,
    returnMembershipId: chosenReturn?.membershipId,
    onNavigate,
    onRetry,
    onEntryNavigate,
    onReturnNavigate,
    current: () => owner.lease.current(),
  };
}
