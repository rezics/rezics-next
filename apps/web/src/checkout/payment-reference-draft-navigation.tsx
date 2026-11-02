import { useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export function hasUnsentPaymentReference(value: string, hasCapturedAttempt: boolean) {
  return !hasCapturedAttempt && validPaymentReference(value);
}

export function PaymentReferenceDraftNavigation({
  active,
  isCurrent,
  focus,
}: {
  active: boolean;
  isCurrent: () => boolean;
  focus: () => HTMLElement | null;
}) {
  const live = useRef({ active, isCurrent, focus });
  live.current = { active, isCurrent, focus };
  const [open, setOpen] = useState(false);
  const pending = useRef<((discard: boolean) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const discarded = useRef(false);
  const router = useRouter({ warn: false });
  const protectedNow = () => live.current.active && live.current.isCurrent();

  function choose(discard: boolean) {
    const resolve = pending.current;
    pending.current = null;
    discarded.current = discard;
    setOpen(false);
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
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!protectedNow()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [active]);

  return (
    <>
      {router ? <RouterDraftBoundary protectedNow={protectedNow} confirm={() => confirmRef.current()} /> : null}
      <AlertDialog
        open={open && protectedNow()}
        onOpenChange={(value) => !value && pending.current && choose(false)}
      >
        {open && protectedNow() ? (
          <AlertDialogContent
            initialFocus={stayButton}
            finalFocus={() =>
              !discarded.current && protectedNow() && returnFocus.current?.isConnected
                ? returnFocus.current
                : false
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
}: {
  protectedNow: () => boolean;
  confirm: () => Promise<boolean>;
}) {
  useBlocker({
    shouldBlockFn: () => (protectedNow() ? confirm().then((discard) => !discard) : false),
    enableBeforeUnload: false,
  });
  return null;
}
