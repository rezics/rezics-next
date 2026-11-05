import { useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
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

export type OwnVotesDepartureControl = {
  confirm: () => Promise<boolean>;
  allowNavigation: () => void;
  clearNavigation: () => void;
};
export type OwnVotesDepartureRef = { current: OwnVotesDepartureControl | null };

/** One editor owns one draft and command; a pending or uncertain command cannot leave without review. */
export function OwnVotesDeparture({
  dirty,
  locked,
  isCurrent,
  onLeave,
  onStay,
  confirmMovement,
}: {
  dirty: boolean;
  locked: boolean;
  isCurrent: () => boolean;
  onLeave?: () => void;
  onStay?: () => void;
  confirmMovement?: OwnVotesDepartureRef | undefined;
}) {
  const live = useRef<{
    dirty: boolean;
    locked: boolean;
    isCurrent: () => boolean;
    onLeave: (() => void) | undefined;
    onStay: (() => void) | undefined;
  }>({
    dirty,
    locked,
    isCurrent,
    onLeave,
    onStay,
  });
  live.current = { dirty, locked, isCurrent, onLeave, onStay };
  const [open, setOpen] = useState(false);
  const waiting = useRef<((leave: boolean) => void) | null>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const approvedMovement = useRef(false);
  const protectedNow = () => live.current.isCurrent() && (live.current.dirty || live.current.locked);

  function choose(leave: boolean) {
    if (leave && live.current.locked) return;
    const resolve = waiting.current;
    waiting.current = null;
    setOpen(false);
    if (resolve && !leave) live.current.onStay?.();
    resolve?.(leave);
  }

  function confirm(): Promise<boolean> {
    if (!protectedNow()) return Promise.resolve(true);
    if (waiting.current) return Promise.resolve(false);
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    return new Promise((resolve) => {
      waiting.current = resolve;
    });
  }

  const decide = () => {
    const originalAuthority = live.current.isCurrent;
    return confirm().then((leave) => {
      const admittedLeave = leave && originalAuthority() && live.current.isCurrent();
      if (admittedLeave) live.current.onLeave?.();
      return admittedLeave;
    });
  };
  if (confirmMovement)
    confirmMovement.current = {
      confirm: decide,
      allowNavigation: () => {
        approvedMovement.current = true;
      },
      clearNavigation: () => {
        approvedMovement.current = false;
      },
    };

  useBlocker({
    shouldBlockFn: () => {
      if (approvedMovement.current) {
        approvedMovement.current = false;
        return false;
      }
      return protectedNow() ? decide().then((leave) => !leave) : false;
    },
    enableBeforeUnload: dirty || locked,
  });

  useEffect(() => {
    if (waiting.current && !protectedNow()) choose(true);
  });

  useEffect(
    () => () => {
      waiting.current?.(true);
      waiting.current = null;
    },
    [],
  );

  return (
    <AlertDialog open={open && isCurrent()} onOpenChange={(next) => !next && choose(false)}>
      {open && isCurrent() ? (
        <AlertDialogContent
          initialFocus={stay}
          finalFocus={() => (isCurrent() && returnFocus.current?.isConnected ? returnFocus.current : false)}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_my_ratings_departure_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {locked ? m.library_my_ratings_departure_locked() : m.library_my_ratings_departure_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stay} onClick={() => choose(false)}>
              {m.library_my_ratings_stay()}
            </AlertDialogCancel>
            {!locked ? (
              <AlertDialogAction onClick={() => choose(true)}>{m.library_my_ratings_leave()}</AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
