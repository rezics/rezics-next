import { useBlocker, useRouter } from '@tanstack/react-router';
import { createElement, useEffect, useLayoutEffect, useRef } from 'react';
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
import { m } from '../../paraglide/messages.js';

type SubjectTermsNavigationGuardProps = {
  active: boolean;
  dirty: boolean;
  pending: boolean;
  locale: string;
  isActive?: (() => boolean) | undefined;
  leaveLabel?: string | undefined;
};

/** Keep a live Terms editor on the current route until its contributor stays or discards the draft. */
export function SubjectTermsNavigationGuard({
  active,
  dirty,
  pending,
  locale,
  isActive,
  leaveLabel,
}: SubjectTermsNavigationGuardProps) {
  const protect = active && (dirty || pending);
  const router = useRouter({ warn: false });

  useEffect(() => {
    if (!protect) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (isActive && !isActive()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [protect, isActive]);

  return router ? createElement(RouterDepartureGuard, { protect, pending, locale, isActive, leaveLabel }) : null;
}

function RouterDepartureGuard({
  protect,
  pending,
  locale,
  isActive,
  leaveLabel,
}: Omit<SubjectTermsNavigationGuardProps, 'active' | 'dirty'> & { protect: boolean }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const resolved = useRef(false);
  const leaving = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: () => {
      if (!protect || (isActive && !isActive())) return false;
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      resolved.current = false;
      leaving.current = false;
      return true;
    },
    disabled: !protect,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;

  useLayoutEffect(
    () => () => {
      const current = blockerRef.current;
      if (current.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        current.reset();
      }
    },
    [],
  );

  useEffect(() => {
    if (!protect && blocker.status === 'blocked' && !resolved.current) {
      resolved.current = true;
      blocker.reset();
    }
  }, [protect, blocker]);

  function resolve(leave: boolean) {
    if (blocker.status !== 'blocked' || resolved.current) return;
    resolved.current = true;
    leaving.current = leave;
    if (leave) blocker.proceed();
    else blocker.reset();
  }

  const options = { locale: locale as never };
  return createElement(
    AlertDialog,
    { open: blocker.status === 'blocked', onOpenChange: (open) => !open && resolve(false) },
    createElement(
      AlertDialogContent,
      {
        initialFocus: stayButton,
        finalFocus: () => (leaving.current ? false : returnFocus.current?.isConnected ? returnFocus.current : false),
      },
      createElement(
        AlertDialogHeader,
        null,
        createElement(AlertDialogTitle, null, m.zone_editor_leave({}, options)),
        pending && createElement(AlertDialogDescription, null, m.thread_authoring_leave_pending({}, options)),
      ),
      createElement(
        AlertDialogFooter,
        null,
        createElement(AlertDialogCancel, { ref: stayButton }, m.zone_editor_stay({}, options)),
        createElement(
          AlertDialogAction,
          { variant: 'destructive', onClick: () => resolve(true) },
          leaveLabel ?? m.zone_editor_discard({}, options),
        ),
      ),
    ),
  );
}
