import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBlocker, useRouter } from '@tanstack/react-router';
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

export function RealmAppearanceDeparture({
  active,
  dirty,
  unresolvedSave,
  children,
}: {
  active: boolean;
  dirty: boolean;
  unresolvedSave: boolean;
  children: ReactNode;
}) {
  const router = useRouter({ warn: false });
  const retired = useRef(false);
  const latest = useRef({ active, dirty });
  latest.current = { active: active && !retired.current, dirty: dirty && !retired.current };
  const [sessionRetired, setSessionRetired] = useState(false);
  const [open, setOpen] = useState(false);
  const resolve = useRef<((stay: boolean) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const leaving = useRef(false);

  const settle = useCallback((stay: boolean) => {
    const pending = resolve.current;
    if (!pending) return;
    resolve.current = null;
    leaving.current = !stay;
    setOpen(false);
    pending(stay);
  }, []);

  useEffect(() => {
    if (!active || !dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.active || !latest.current.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [active, dirty]);

  useEffect(() => {
    const signingOut = (event: SubmitEvent) => {
      const form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
      const action = new URL(form.action, window.location.href);
      if (action.origin !== window.location.origin || action.pathname !== '/auth/sign-out') return;
      retired.current = true;
      latest.current = { active: false, dirty: false };
      setSessionRetired(true);
      settle(false);
    };
    document.addEventListener('submit', signingOut);
    return () => document.removeEventListener('submit', signingOut);
  }, [settle]);

  useEffect(() => {
    if (active && dirty) return;
    settle(false);
  }, [active, dirty, settle]);

  useEffect(
    () => () => {
      const pending = resolve.current;
      resolve.current = null;
      pending?.(false);
    },
    [],
  );

  const stayButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      {sessionRetired ? null : children}
      {router ? (
        <RouterDeparture
          latest={latest}
          resolve={resolve}
          returnFocus={returnFocus}
          leaving={leaving}
          setOpen={setOpen}
        />
      ) : null}
      <AlertDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) settle(true);
        }}
      >
        <AlertDialogContent
          className="min-w-0 max-w-lg grid-cols-[minmax(0,1fr)] gap-6 p-5 text-start sm:max-w-xl sm:p-6"
          initialFocus={stayButton}
          finalFocus={() =>
            leaving.current ? false : returnFocus.current?.isConnected ? returnFocus.current : undefined
          }
        >
          <AlertDialogHeader className="min-w-0 grid-cols-[minmax(0,1fr)] place-items-stretch gap-3 text-start">
            <AlertDialogTitle className="text-lg leading-snug">{m.realm_appearance_leave_title()}</AlertDialogTitle>
            <AlertDialogDescription className="min-w-0 text-start leading-relaxed [overflow-wrap:anywhere]">
              {unresolvedSave ? m.realm_appearance_leave_recovery() : m.realm_appearance_leave_unsaved()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-3 sm:flex-row sm:justify-end">
            <AlertDialogCancel
              ref={stayButton}
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-3 text-center leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
              onClick={() => settle(true)}
            >
              <span className="min-w-0">{m.realm_appearance_stay()}</span>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-3 text-center leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
              onClick={() => settle(false)}
            >
              <span className="min-w-0">{m.realm_appearance_leave()}</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type MutableCell<T> = { current: T };

function RouterDeparture({
  latest,
  resolve,
  returnFocus,
  leaving,
  setOpen,
}: {
  latest: MutableCell<{ active: boolean; dirty: boolean }>;
  resolve: MutableCell<((stay: boolean) => void) | null>;
  returnFocus: MutableCell<HTMLElement | null>;
  leaving: MutableCell<boolean>;
  setOpen: (open: boolean) => void;
}) {
  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (!latest.current.active || !latest.current.dirty || current.pathname === next.pathname) return false;
      if (resolve.current) return true;
      return new Promise<boolean>((done) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        leaving.current = false;
        resolve.current = done;
        setOpen(true);
      });
    },
    withResolver: false,
    enableBeforeUnload: false,
  });
  return null;
}
