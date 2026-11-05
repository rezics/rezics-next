import { useLayoutEffect, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import { useRouter, type AnyRouter } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { browserObservation } from '../session/observation';
import { purchaseReaderOriginFromState } from './purchase-return';
import type { BuyerCurrentOrigin } from './buyer-current-origin';
import {
  BuyerHistoryWindows,
  type BuyerHistoryIntent,
  type BuyerHistoryList,
  type BuyerHistoryMovement,
} from './buyer-history-windows';

export type BuyerHistoryNavigation = {
  previous: string | null | undefined;
  move: (movement: BuyerHistoryMovement, cursor: string | null, event: ReactMouseEvent<HTMLAnchorElement>) => void;
};

function ordinary(
  event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  anchor: HTMLAnchorElement,
) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!anchor.target || anchor.target === '_self') &&
    !anchor.hasAttribute('download')
  );
}

function buyerRoute(href: string) {
  const url = new URL(href, 'https://buyer.invalid');
  const match = /^\/(?:([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\/)?(orders|entitlements|editions)(?:\/([^/]+))?\/?$/.exec(
    url.pathname,
  );
  return match ? { locale: match[1], list: match[2], id: match[3], url } : undefined;
}

/** One navigation-only carrier in the existing Router/QueryClient composition. */
export class BuyerHistoryVisit {
  windows = new BuyerHistoryWindows();
  private revision = 0;
  private binding: string | undefined;
  private locale: string | undefined;
  private listeners = new Set<() => void>();
  private focus: { ticket: BuyerHistoryIntent; initiator: Element } | undefined;
  private connected = false;
  constructor(private readonly client: QueryClient) {}

  snapshot = () => this.revision;
  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    return () => {
      this.listeners.delete(notify);
    };
  };
  private publish() {
    this.revision++;
    browserObservation(this.client).publish(() => this.listeners.forEach((notify) => notify()));
  }
  clear = () => {
    this.windows.retire();
    this.windows = new BuyerHistoryWindows();
    this.binding = undefined;
    this.focus = undefined;
    this.publish();
  };

  observeLocale(locale: string) {
    if (this.locale !== undefined && this.locale !== locale) this.clear();
    this.locale = locale;
  }

  bind(origin: BuyerCurrentOrigin, locale: string) {
    this.observeLocale(locale);
    const binding = JSON.stringify([origin.observed.readId]);
    if (this.binding !== undefined && this.binding !== binding) this.clear();
    this.binding = binding;
    return this.windows;
  }

  /** No observer, root provider, private body cache, global registry or persistent storage. */
  mount(router: AnyRouter) {
    this.connected = true;
    const observation = browserObservation(this.client);
    const retirement = observation.subscribeRetirement(this.clear);
    const cache = observation.subscribeCache((event) => {
      const current = observation.getSnapshot();
      const key = event.query.queryKey;
      if (
        current.state === 'signed-in' &&
        key[0] === 'exposure' &&
        key[1] === 'viewer' &&
        key[2] === current.observation.subject &&
        key[3] === current.observation.id &&
        event.type === 'updated' &&
        ['success', 'error', 'invalidate'].includes(event.action.type)
      )
        this.clear();
    });
    const navigation = router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
      if (fromLocation?.href === toLocation.href) return;
      const from = fromLocation && buyerRoute(fromLocation.publicHref);
      const to = buyerRoute(toLocation.publicHref);
      let eligible = !!from && !!to && (from.locale ?? this.locale) === (to.locale ?? this.locale);
      if (eligible && to?.list === 'editions') {
        const origin = purchaseReaderOriginFromState(toLocation.state, to.id!, (to.locale ?? this.locale)!);
        eligible =
          !!origin &&
          from?.list === (origin.kind === 'order' ? 'orders' : 'entitlements') &&
          from.id === origin.recordId;
      } else if (eligible && from?.list === 'editions') {
        const origin = purchaseReaderOriginFromState(fromLocation!.state, from.id!, (from.locale ?? this.locale)!);
        eligible =
          !!origin && to?.list === (origin.kind === 'order' ? 'orders' : 'entitlements') && to.id === origin.recordId;
      }
      if (!eligible) this.clear();
      else if (this.focus && to?.list !== this.focus.ticket.list) this.focus = undefined;
    });
    const focus = (event: FocusEvent) => {
      if (this.focus && event.target !== this.focus.initiator) this.focus = undefined;
    };
    const cancelFocus = () => {
      this.focus = undefined;
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || !ordinary(event, anchor)) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin) return;
      const from = buyerRoute(router.state.location.publicHref);
      const to = buyerRoute(url.href);
      if (!from || !to || (from.locale ?? this.locale) !== (to.locale ?? this.locale) || to.list === 'editions') return;
      // The originating control has already made its departure decision. Never dispatch one here.
      // Native malformed/stale First recovery may have no ready pagination control to stage it.
      if (!to.id && !to.url.searchParams.has('cursor')) {
        const list = to.list as BuyerHistoryList;
        const path = this.windows.window(list);
        if (path.current !== undefined && path.pending?.cursor !== null && (path.current !== null || path.pending)) {
          if (path.pending) this.windows.cancel(path.pending);
          const ticket = this.windows.stage(list, 'first');
          if (ticket) this.initiateFocus(ticket, event.detail === 0, anchor);
        }
      }
      event.preventDefault();
      void router.navigate({ href: `${url.pathname}${url.search}${url.hash}` });
    };
    document.addEventListener('click', click);
    document.addEventListener('focusin', focus);
    document.addEventListener('pointerdown', cancelFocus);
    document.addEventListener('keydown', cancelFocus);
    return () => {
      this.connected = false;
      retirement();
      cache();
      navigation();
      document.removeEventListener('click', click);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('pointerdown', cancelFocus);
      document.removeEventListener('keydown', cancelFocus);
      this.clear();
    };
  }

  private initiateFocus(ticket: BuyerHistoryIntent, keyboard: boolean, initiator: Element) {
    this.focus = keyboard && document.activeElement === initiator ? { ticket, initiator } : undefined;
  }
  move(
    router: AnyRouter,
    windows: BuyerHistoryWindows,
    origin: BuyerCurrentOrigin,
    list: BuyerHistoryList,
    movement: BuyerHistoryMovement,
    cursor: string | null,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) {
    if (!ordinary(event, event.currentTarget)) return;
    event.preventDefault();
    if (!this.connected || this.windows !== windows || !origin.isCurrent()) {
      return;
    }
    const ticket = windows.stage(list, movement, cursor);
    if (!ticket) return;
    this.initiateFocus(ticket, event.detail === 0, event.currentTarget);
    this.publish();
    const href = event.currentTarget.getAttribute('href')!;
    if (this.windows === windows && origin.isCurrent()) void router.navigate({ href });
  }
  retryFocus(
    windows: BuyerHistoryWindows,
    origin: BuyerCurrentOrigin,
    list: BuyerHistoryList,
    cursor: string | null,
    event: ReactMouseEvent<HTMLElement>,
  ) {
    const ticket = windows.window(list).pending;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (this.windows === windows && origin.isCurrent() && ticket?.cursor === cursor && button)
      this.initiateFocus(
        ticket,
        event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey,
        button,
      );
  }
  receive(
    windows: BuyerHistoryWindows,
    origin: BuyerCurrentOrigin,
    list: BuyerHistoryList,
    cursor: string | null,
    ticket: BuyerHistoryIntent | undefined,
  ) {
    if (this.windows !== windows || !origin.isCurrent()) return;
    if (ticket) {
      if (ticket.cursor !== cursor || !windows.admit(ticket)) return;
    } else windows.admitEntry(list, cursor);
    this.publish();
  }
  failed(windows: BuyerHistoryWindows) {
    if (this.windows === windows) this.focus = undefined;
  }
  focusHeading(windows: BuyerHistoryWindows, list: BuyerHistoryList, cursor: string | null) {
    const pending = this.focus;
    if (
      this.windows !== windows ||
      !pending ||
      pending.ticket.list !== list ||
      pending.ticket.cursor !== cursor ||
      windows.window(list).pending
    )
      return;
    this.focus = undefined;
    document.getElementById(`${list}-heading`)?.focus();
  }
}

const noSubscribe = () => () => {};
const zero = () => 0;

/** Each receiver captures the precise visit, current origin and staged ticket before dispatch. */
export function useBuyerHistoryNavigation(
  list: BuyerHistoryList,
  cursor: string | null,
  locale: string,
  origin: BuyerCurrentOrigin,
) {
  const router = useRouter({ warn: false });
  const visit = router?.options.context?.buyerHistory as BuyerHistoryVisit | undefined;
  useSyncExternalStore(visit?.subscribe ?? noSubscribe, visit?.snapshot ?? zero, zero);
  const windows = visit?.bind(origin, locale);
  const path = windows?.window(list);
  const ticket = path?.pending;
  return {
    controls:
      visit && windows
        ? {
            previous: path?.previous,
            move: (movement: BuyerHistoryMovement, next: string | null, event: ReactMouseEvent<HTMLAnchorElement>) =>
              visit.move(router!, windows, origin, list, movement, next, event),
          }
        : undefined,
    retry: (event: ReactMouseEvent<HTMLElement>) => {
      if (windows) visit!.retryFocus(windows, origin, list, cursor, event);
    },
    ready: () => {
      if (windows) visit!.receive(windows, origin, list, cursor, ticket);
    },
    failed: () => {
      if (windows) visit!.failed(windows);
    },
    focus: () => {
      if (windows && origin.isCurrent()) visit!.focusHeading(windows, list, cursor);
    },
  };
}

export function useBuyerHistoryFocus(
  navigation: ReturnType<typeof useBuyerHistoryNavigation>,
  ready: boolean,
  failed: boolean,
) {
  useLayoutEffect(() => {
    if (failed) navigation.failed();
    else if (ready) navigation.focus();
  }, [navigation, ready, failed]);
}
