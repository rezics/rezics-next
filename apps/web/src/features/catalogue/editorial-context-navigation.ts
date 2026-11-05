import { useBlocker, useRouter } from '@tanstack/react-router';
import { createElement, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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

// Reuse localized departure copy; unresolved commands warn that leaving loses retry recovery but does not cancel the request.
/** Protects this editor's creation draft and unresolved lifecycle command. */
export function EditorialContextNavigation({
  locale,
  dirty,
  unsettled,
  onLeave,
}: {
  locale: string;
  dirty: boolean;
  unsettled: boolean;
  onLeave: () => void;
}) {
  const protect = dirty || unsettled;
  const router = useRouter({ warn: false });
  return router ? createElement(RouterDepartureGuard, { locale, protect, unsettled, onLeave }) : null;
}

function RouterDepartureGuard({
  locale,
  protect,
  unsettled,
  onLeave,
}: {
  locale: string;
  protect: boolean;
  unsettled: boolean;
  onLeave: () => void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const resolved = useRef(false);
  const leaving = useRef(false);
  const shouldBlockFn = useCallback(() => {
    if (!protect) return false;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    resolved.current = false;
    leaving.current = false;
    return true;
  }, [protect]);
  const blocker = useBlocker({
    shouldBlockFn,
    disabled: !protect,
    enableBeforeUnload: () => protect,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useLayoutEffect(
    () => () => {
      const pending = blockerRef.current;
      if (pending.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        pending.reset();
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
    if (leave) {
      onLeave();
      blocker.proceed();
    } else blocker.reset();
  }

  const o = { locale: locale as never };
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
        createElement(AlertDialogTitle, null, m.zone_editor_leave({}, o)),
        createElement(
          AlertDialogDescription,
          null,
          unsettled ? m.thread_authoring_leave_pending({}, o) : m.thread_authoring_leave_unsaved({}, o),
        ),
      ),
      createElement(
        AlertDialogFooter,
        null,
        createElement(AlertDialogCancel, { ref: stayButton }, m.thread_authoring_stay({}, o)),
        createElement(
          AlertDialogAction,
          { variant: 'destructive', onClick: () => resolve(true) },
          unsettled ? m.thread_authoring_leave({}, o) : m.zone_editor_discard({}, o),
        ),
      ),
    ),
  );
}
