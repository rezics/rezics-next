import { useBlocker, useRouter, type ShouldBlockFn } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../paraglide/messages.js';
import { validPaymentReference } from './creator-payment-attestation-state';

type Departure = { beforeLeave(href: string): boolean; stayed(): void };
const DepartureContext = createContext<Departure | null>(null);

export function PaymentReferenceDepartureProvider({
  beforeLeave,
  stayed,
  children,
}: Departure & { children: ReactNode }) {
  return <DepartureContext.Provider value={{ beforeLeave, stayed }}>{children}</DepartureContext.Provider>;
}

export function hasUnsentPaymentReference(value: string, hasCapturedAttempt: boolean) {
  return !hasCapturedAttempt && validPaymentReference(value);
}

/** Click targets may be text, composed nodes, or another Window's Element type. */
export function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  if (!target || typeof target !== 'object') return null;
  const node = target as {
    nodeType?: number;
    parentElement?: Element | null;
    closest?: Element['closest'];
  };
  if (node.nodeType === 1 && typeof node.closest === 'function') return target as Element;
  return node.parentElement ?? null;
}

export function sameOriginDocumentDestination(
  anchor: HTMLAnchorElement,
  event: MouseEvent,
  currentHref: string,
): string | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    anchor.hasAttribute('download')
  )
    return null;

  const target = anchor.target.trim().toLowerCase();
  if (target && target !== '_self') return null;

  let current: URL;
  let destination: URL;
  try {
    current = new URL(currentHref);
    destination = new URL(anchor.href, current);
  } catch {
    return null;
  }
  if (destination.origin !== current.origin) return null;
  if (
    destination.pathname === current.pathname &&
    destination.search === current.search &&
    (destination.hash !== current.hash || anchor.getAttribute('href')?.includes('#'))
  )
    return null;
  return destination.href;
}

/** One Stay/Discard owner; notify before returning so the prompt is on the document while the blocker waits. */
class PaymentReferenceDeparture {
  private listeners = new Set<() => void>();
  private revision = 0;
  private decision: { resolve: (discard: boolean) => void } | null = null;
  focusTarget: HTMLElement | null = null;
  discarded = false;
  approvedDocumentDeparture = false;

  snapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get waiting() {
    return this.decision !== null;
  }

  private notify() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }

  request(focus: HTMLElement | null, needed: boolean): Promise<boolean> {
    if (!needed) return Promise.resolve(true);
    if (this.decision) return Promise.resolve(false);
    this.focusTarget = focus;
    this.discarded = false;
    return new Promise((resolve) => {
      this.decision = { resolve };
      this.notify();
    });
  }

  choose(discard: boolean, stayed?: () => void) {
    const decision = this.decision;
    if (!decision) return;
    this.decision = null;
    this.discarded = discard;
    if (!discard) stayed?.();
    this.notify();
    decision.resolve(discard);
  }
}

export function PaymentReferenceDraftNavigation({
  active,
  isCurrent,
  draftIsCurrent,
  focus,
}: {
  active: boolean;
  isCurrent: () => boolean;
  draftIsCurrent?: () => boolean;
  focus: () => HTMLElement | null;
}) {
  const [navigation] = useState(() => new PaymentReferenceDeparture());
  useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const live = useRef({ active, isCurrent: draftIsCurrent ?? isCurrent, focus });
  live.current = { active, isCurrent: draftIsCurrent ?? isCurrent, focus };
  const stayButton = useRef<HTMLButtonElement>(null);
  const router = useRouter({ warn: false });
  const routerRef = useRef(router);
  routerRef.current = router;
  const departure = useContext(DepartureContext);
  const departureRef = useRef(departure);
  departureRef.current = departure;
  const protectedNow = () => live.current.active && live.current.isCurrent();
  const confirm = () => navigation.request(live.current.focus(), protectedNow());

  useLayoutEffect(() => {
    if (navigation.waiting && !protectedNow()) navigation.choose(true);
  });
  useLayoutEffect(
    () => () => {
      navigation.choose(true);
    },
    [navigation],
  );

  useLayoutEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (navigation.approvedDocumentDeparture) {
        navigation.approvedDocumentDeparture = false;
        return;
      }
      if (!protectedNow()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const documentLink = (event: MouseEvent) => {
      const from = eventElement(event.target);
      const anchor = from?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || (!protectedNow() && !departureRef.current)) return;
      const destination = sameOriginDocumentDestination(anchor, event, window.location.href);
      if (!destination) return;
      // Window capture runs before the router's document listener; stop this click there.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (
        !protectedNow() &&
        departureRef.current &&
        routerRef.current &&
        (new URL(destination).pathname !== window.location.pathname ||
          new URL(destination).search !== window.location.search)
      ) {
        void routerRef.current.navigate({ href: destination });
        return;
      }
      void (protectedNow() ? confirm() : Promise.resolve(true)).then((discard) => {
        if (!discard || (departureRef.current && !departureRef.current.beforeLeave(destination))) return;
        navigation.approvedDocumentDeparture = true;
        window.location.assign(destination);
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('click', documentLink, true);
    document.addEventListener('click', documentLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('click', documentLink, true);
      document.removeEventListener('click', documentLink, true);
    };
  }, [navigation]);

  return (
    <>
      {router ? (
        <RouterDraftBoundary protectedNow={protectedNow} confirm={confirm} departure={departure} />
      ) : null}
      <AlertDialog
        open={navigation.waiting && protectedNow()}
        onOpenChange={(value) => !value && navigation.waiting && navigation.choose(false, departureRef.current?.stayed)}
      >
        {navigation.waiting && protectedNow() ? (
          <AlertDialogContent
            initialFocus={stayButton}
            finalFocus={() =>
              !navigation.discarded && protectedNow() && navigation.focusTarget?.isConnected
                ? navigation.focusTarget
                : false
            }
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{m.payment_reference_draft_navigation_title()}</AlertDialogTitle>
              <AlertDialogDescription>{m.payment_reference_draft_navigation_description()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                ref={stayButton}
                type="button"
                onClick={() => navigation.choose(false, departureRef.current?.stayed)}
              >
                {m.payment_reference_draft_navigation_stay()}
              </AlertDialogCancel>
              <AlertDialogAction type="button" variant="destructive" onClick={() => navigation.choose(true)}>
                {m.payment_reference_draft_navigation_discard()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}

function RouterDraftBoundary({
  protectedNow,
  confirm,
  departure,
}: {
  protectedNow: () => boolean;
  confirm: () => Promise<boolean>;
  departure: Departure | null;
}) {
  const latest = useRef({ protectedNow, confirm, departure });
  latest.current = { protectedNow, confirm, departure };
  const shouldBlockFn = useCallback<ShouldBlockFn>(({ current, next }) => {
    const live = latest.current;
    if (current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search))
      return false;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(next.search)) {
      if (typeof value === 'string') search.set(key, value);
    }
    const query = search.toString();
    const href = `${next.pathname}${query ? `?${query}` : ''}`;
    const afterLeave = () => (live.departure ? !live.departure.beforeLeave(href) : false);
    return live.protectedNow() ? live.confirm().then((discard) => (discard ? afterLeave() : true)) : afterLeave();
  }, []);
  useBlocker({
    shouldBlockFn,
    withResolver: false,
    enableBeforeUnload: false,
  });
  return null;
}
