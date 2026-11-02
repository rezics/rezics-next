import { useBlocker, useRouter, type ShouldBlockFn } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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

type ConsentLocation = { routeId: string; pathname: string; params: object; search: object };

export function isStatementConsentDeparture(current: ConsentLocation, next: ConsentLocation) {
  return (
    current.routeId !== next.routeId ||
    current.pathname !== next.pathname ||
    JSON.stringify(current.params) !== JSON.stringify(next.params) ||
    JSON.stringify(current.search) !== JSON.stringify(next.search)
  );
}

/** Protect only a submitted consent command; confirmation and ownership checks remain freely navigable. */
export function StatementConsentNavigation({ active, locale }: { active: boolean; locale: string }) {
  const latest = useRef(active);
  latest.current = active;
  const router = useRouter({ warn: false });

  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [active]);

  return router ? <RouterDepartureGuard active={active} locale={locale} /> : null;
}

function RouterDepartureGuard({ active, locale }: { active: boolean; locale: string }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const resolved = useRef(false);
  const leaving = useRef(false);
  const latest = useRef(active);
  latest.current = active;
  const shouldBlockFn = useCallback<ShouldBlockFn>(({ current, next }) => {
    if (!latest.current || !isStatementConsentDeparture(current, next)) return false;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    resolved.current = false;
    leaving.current = false;
    return true;
  }, []);
  const blocker = useBlocker({
    shouldBlockFn,
    disabled: !active,
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
    if (!active && blocker.status === 'blocked' && !resolved.current) {
      resolved.current = true;
      blocker.reset();
    }
  }, [active, blocker]);

  function resolve(leave: boolean) {
    if (blocker.status !== 'blocked' || resolved.current) return;
    resolved.current = true;
    leaving.current = leave;
    if (leave && latest.current) blocker.proceed();
    else blocker.reset();
  }

  const options = { locale: locale as never };
  return (
    <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(open) => !open && resolve(false)}>
      {blocker.status === 'blocked' && (
        <AlertDialogContent
          initialFocus={stayButton}
          finalFocus={() => (leaving.current ? false : returnFocus.current?.isConnected ? returnFocus.current : false)}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{m.statement_consent_title({}, options)}</AlertDialogTitle>
            <AlertDialogDescription>{m.statement_consent_leave_warning({}, options)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stayButton} onClick={() => resolve(false)}>
              {m.thread_authoring_stay({}, options)}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => resolve(true)}>
              {m.thread_authoring_leave({}, options)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
