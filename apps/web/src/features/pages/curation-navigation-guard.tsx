import { useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
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
import { presentationMessageOptions } from './curate-view-editor-messages';

type GuardProps = {
  dirty: boolean;
  retainedPublication: boolean;
  fallbackFocus: RefObject<HTMLElement | null>;
  locale?: string;
};

/** Protect only this mounted editor; publication recovery remains owned by its publication instance. */
export function CurationNavigationGuard(props: GuardProps) {
  const protect = props.dirty || props.retainedPublication;
  const router = useRouter({ warn: false });
  useEffect(() => {
    if (!protect) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [protect]);

  // Connected embeds and SSR can render the editor without a RouterProvider.
  return router ? <RouterDepartureGuard {...props} protect={protect} /> : null;
}

function RouterDepartureGuard({
  protect,
  retainedPublication,
  fallbackFocus,
  locale,
}: GuardProps & { protect: boolean }) {
  const options = presentationMessageOptions(locale);
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
    // The outer guard owns the single native listener, including in embeds without a router.
    enableBeforeUnload: false,
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
    // If a pending publication finishes without a later draft, close any outstanding prompt by staying.
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

  return (
    <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(open) => !open && resolve(false)}>
      <AlertDialogContent
        initialFocus={stayButton}
        finalFocus={() =>
          leaving.current
            ? false
            : returnFocus.current?.isConnected
              ? returnFocus.current
              : fallbackFocus.current?.isConnected
                ? fallbackFocus.current
                : false
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{m.curation_leave_title({}, options)}</AlertDialogTitle>
          <AlertDialogDescription>
            {retainedPublication ? m.curation_leave_recovery({}, options) : m.curation_leave_warning({}, options)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={stayButton}>{m.curation_stay({}, options)}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => resolve(true)}>
            {m.curation_leave({}, options)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
