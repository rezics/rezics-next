import { useBlocker, useRouter, type ShouldBlockFn } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
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
  const live = useRef({ active, isCurrent: draftIsCurrent ?? isCurrent, focus });
  live.current = { active, isCurrent: draftIsCurrent ?? isCurrent, focus };
  const [open, setOpen] = useState(false);
  const pending = useRef<((discard: boolean) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const discarded = useRef(false);
  const approvedDocumentDeparture = useRef(false);
  const router = useRouter({ warn: false });
  const routerRef = useRef(router);
  routerRef.current = router;
  const departure = useContext(DepartureContext);
  const departureRef = useRef(departure);
  departureRef.current = departure;
  const protectedNow = () => live.current.active && live.current.isCurrent();

  function choose(discard: boolean) {
    const resolve = pending.current;
    pending.current = null;
    discarded.current = discard;
    setOpen(false);
    if (!discard) departureRef.current?.stayed();
    resolve?.(discard);
  }

  function confirm(): Promise<boolean> {
    if (!protectedNow()) return Promise.resolve(true);
    if (pending.current) return Promise.resolve(false);
    returnFocus.current = live.current.focus();
    discarded.current = false;
    setOpen(true);
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }

  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useLayoutEffect(() => {
    if (pending.current && !protectedNow()) choose(true);
  });
  useLayoutEffect(
    () => () => {
      pending.current?.(true);
      pending.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (approvedDocumentDeparture.current) {
        approvedDocumentDeparture.current = false;
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
      void (protectedNow() ? confirmRef.current() : Promise.resolve(true)).then((discard) => {
        if (!discard || (departureRef.current && !departureRef.current.beforeLeave(destination))) return;
        approvedDocumentDeparture.current = true;
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
  }, []);

  return (
    <>
      {router ? (
        <RouterDraftBoundary protectedNow={protectedNow} confirm={() => confirmRef.current()} departure={departure} />
      ) : null}
      <AlertDialog open={open && protectedNow()} onOpenChange={(value) => !value && pending.current && choose(false)}>
        <AlertDialogContent
          initialFocus={stayButton}
          finalFocus={() =>
            !discarded.current && protectedNow() && returnFocus.current?.isConnected ? returnFocus.current : false
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{m.payment_reference_draft_navigation_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.payment_reference_draft_navigation_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stayButton} type="button" onClick={() => choose(false)}>
              {m.payment_reference_draft_navigation_stay()}
            </AlertDialogCancel>
            <AlertDialogAction type="button" variant="destructive" onClick={() => choose(true)}>
              {m.payment_reference_draft_navigation_discard()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
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
