import { useBlocker, useRouter } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  const departure = useContext(DepartureContext);
  const protectedNow = () => live.current.active && live.current.isCurrent();

  function choose(discard: boolean) {
    const resolve = pending.current;
    pending.current = null;
    discarded.current = discard;
    setOpen(false);
    if (!discard) departure?.stayed();
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

  useEffect(() => {
    if (!active && !departure) return;
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
      const target = event.target;
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || (!protectedNow() && !departure)) return;
      const destination = sameOriginDocumentDestination(anchor, event, window.location.href);
      if (!destination) return;
      if (
        !protectedNow() &&
        departure &&
        router &&
        (new URL(destination).pathname !== window.location.pathname ||
          new URL(destination).search !== window.location.search)
      ) {
        event.preventDefault();
        void router.navigate({ href: destination });
        return;
      }
      event.preventDefault();
      void (protectedNow() ? confirmRef.current() : Promise.resolve(true)).then((discard) => {
        if (!discard || (departure && !departure.beforeLeave(destination))) return;
        approvedDocumentDeparture.current = true;
        window.location.assign(destination);
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('click', documentLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('click', documentLink, true);
    };
  }, [active, departure]);

  return (
    <>
      {router ? (
        <RouterDraftBoundary protectedNow={protectedNow} confirm={() => confirmRef.current()} departure={departure} />
      ) : null}
      <AlertDialog open={open && protectedNow()} onOpenChange={(value) => !value && pending.current && choose(false)}>
        {open && protectedNow() ? (
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
  useBlocker({
    shouldBlockFn: async ({ next }) => {
      if (protectedNow() && !(await confirm())) return true;
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(next.search)) {
        if (typeof value === 'string') search.set(key, value);
      }
      const query = search.toString();
      const href = `${next.pathname}${query ? `?${query}` : ''}`;
      return departure ? !departure.beforeLeave(href) : false;
    },
    enableBeforeUnload: false,
  });
  return null;
}
