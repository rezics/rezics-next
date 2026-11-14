import { useBlocker } from '@tanstack/react-router';
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

type CollectionDraftNavigationOptions = {
  dirty: boolean;
  locked: boolean;
  isCurrent: () => boolean;
  /** A new Collection can discard its caller without undoing an already dispatched creation. */
  creation?: { commandMayHaveApplied: boolean; discard: () => void };
};

/** Protects departure only; the caller continues to own every draft and command. */
export function useCollectionDraftNavigation(options: CollectionDraftNavigationOptions) {
  const live = useRef(options);
  live.current = options;
  const [open, setOpen] = useState(false);
  const pending = useRef<((leave: boolean) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const leaving = useRef(false);
  const owner = useRef({ active: false });
  const protectedNow = () =>
    !leaving.current && live.current.isCurrent() && (live.current.dirty || live.current.locked);

  function settle(leave: boolean) {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(leave);
  }
  function choose(leave: boolean) {
    if (!pending.current) return;
    if (leave) {
      if (!live.current.isCurrent()) {
        settle(!live.current.creation);
        return;
      }
      if (live.current.locked && !live.current.creation) return;
      if (live.current.creation) {
        leaving.current = true;
        live.current.creation.discard();
      }
    }
    settle(leave);
  }
  function confirm(): Promise<boolean> {
    if (!protectedNow()) return Promise.resolve(true);
    if (pending.current) return Promise.resolve(false);
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useLayoutEffect(() => {
    // A create acknowledgement owns its destination. Retirement must cancel its old departure request.
    // Existing Collection saves still release the destination requested by their editor.
    if (pending.current && !protectedNow()) settle(!live.current.creation);
  });
  useLayoutEffect(() => {
    const current = { active: true };
    owner.current = current;
    return () => {
      current.active = false;
      pending.current?.(!live.current.creation);
      pending.current = null;
    };
  }, []);

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
        destination.href === window.location.href ||
        (destination.hash &&
          destination.origin === window.location.origin &&
          destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const caller = owner.current;
      void confirmRef.current().then((leave) => {
        if (!leave || !caller.active) return;
        leaving.current = true;
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
      const caller = owner.current;
      void confirmRef.current().then((leave) => {
        if (!leave || !caller.active || !form.isConnected) return;
        leaving.current = true;
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

  return (
    <>
      <RouterDraftBoundary protectedNow={protectedNow} confirm={() => confirmRef.current()} />
      {options.dirty && options.isCurrent() ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_collection_draft_navigation_unsaved()}
        </p>
      ) : null}
      <AlertDialog open={open && options.isCurrent()} onOpenChange={(value) => !value && choose(false)}>
        {open && options.isCurrent() ? (
          <AlertDialogContent
            initialFocus={stayButton}
            finalFocus={() =>
              !leaving.current && live.current.isCurrent() && returnFocus.current?.isConnected
                ? returnFocus.current
                : false
            }
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{m.library_collection_draft_navigation_title()}</AlertDialogTitle>
              <AlertDialogDescription>
                {options.creation
                  ? options.creation.commandMayHaveApplied
                    ? m.library_collection_create_departure_unknown()
                    : m.library_collection_create_departure_description()
                  : options.locked
                    ? m.library_collection_draft_navigation_pending()
                    : m.library_collection_draft_navigation_description()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11" ref={stayButton} onClick={() => choose(false)}>
                {m.library_collection_draft_navigation_stay()}
              </AlertDialogCancel>
              {!options.locked || options.creation ? (
                <AlertDialogAction className="min-h-11" onClick={() => choose(true)}>
                  {m.library_collection_draft_navigation_leave()}
                </AlertDialogAction>
              ) : null}
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
    shouldBlockFn: ({ current, next }) =>
      current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search)
        ? false
        : protectedNow()
          ? confirm().then((leave) => !leave)
          : false,
    enableBeforeUnload: false,
  });
  return null;
}
