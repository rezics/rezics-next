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

/** Object key order is incidental; Boolean structure and every operand array remain ordered. */
export function ruleDraftSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
}

export function useCollectionRuleDraftNavigation(options: {
  dirty: boolean;
  isCurrent: () => boolean;
  focus: () => HTMLElement | null;
}) {
  const live = useRef(options);
  live.current = options;
  const [open, setOpen] = useState(false);
  const pending = useRef<((discard: boolean) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const discarded = useRef(false);
  const leavingDocument = useRef(false);
  const router = useRouter({ warn: false });
  const protectedNow = () => !leavingDocument.current && live.current.dirty && live.current.isCurrent();

  function choose(discard: boolean) {
    const resolve = pending.current;
    pending.current = null;
    discarded.current = discard;
    setOpen(false);
    resolve?.(discard);
  }
  function confirm(needed = live.current.dirty): Promise<boolean> {
    if (!needed || !live.current.isCurrent()) return Promise.resolve(true);
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
    // Retirement and confirmed saves must never wait for a draft choice.
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
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!protectedNow()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const click = (event: MouseEvent) => {
      if (
        !protectedNow() ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute('download') ||
        (anchor.target && anchor.target !== '_self')
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        !['http:', 'https:'].includes(destination.protocol) ||
        (destination.hash &&
          destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void confirmRef.current().then((discard) => {
        if (!discard) return;
        leavingDocument.current = true;
        window.location.assign(destination.href);
      });
    };
    const submit = (event: SubmitEvent) => {
      const form = event.target;
      if (
        !protectedNow() ||
        event.defaultPrevented ||
        !(form instanceof HTMLFormElement) ||
        form.method.toLowerCase() !== 'get' ||
        (form.target && form.target !== '_self')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const submitter = event.submitter;
      void confirmRef.current().then((discard) => {
        if (!discard || !form.isConnected) return;
        leavingDocument.current = true;
        form.requestSubmit(submitter);
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    document.addEventListener('submit', submit, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
      document.removeEventListener('submit', submit, true);
    };
  }, []);

  return {
    confirm,
    boundary: (
      <>
        {router ? <RouterDraftBoundary protectedNow={protectedNow} confirm={() => confirmRef.current()} /> : null}
        <AlertDialog open={open && options.isCurrent()} onOpenChange={(value) => !value && choose(false)}>
          {open && options.isCurrent() ? (
            <AlertDialogContent
              initialFocus={stayButton}
              finalFocus={() =>
                !discarded.current && live.current.isCurrent() && returnFocus.current?.isConnected
                  ? returnFocus.current
                  : false
              }
            >
              <AlertDialogHeader>
                <AlertDialogTitle>{m.library_rule_draft_navigation_title()}</AlertDialogTitle>
                <AlertDialogDescription>{m.library_rule_draft_navigation_description()}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel ref={stayButton} onClick={() => choose(false)}>
                  {m.library_rule_draft_navigation_stay()}
                </AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => choose(true)}>
                  {m.library_rule_draft_navigation_leave()}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          ) : null}
        </AlertDialog>
      </>
    ),
  };
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
