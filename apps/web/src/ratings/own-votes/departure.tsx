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

type SelectionMovement = { kind: 'selection'; returnFocus: HTMLElement | null };
export type OwnVotesDepartureControl = {
  confirm: (movement?: SelectionMovement) => Promise<boolean>;
  allowNavigation: () => void;
  clearNavigation: () => void;
};
export type OwnVotesDepartureRef = { current: OwnVotesDepartureControl | null };

type Decision = {
  owner: object;
  returnFocus: HTMLElement | null;
  resolve: (leave: boolean) => void;
};

/** One editor owns one draft and command; selection and navigation share one decision. */
export function OwnVotesDeparture({
  owner,
  dirty,
  locked,
  isCurrent,
  onLeave,
  onStay,
  confirmMovement,
}: {
  owner: object;
  dirty: boolean;
  locked: boolean;
  isCurrent: () => boolean;
  onLeave?: () => void;
  onStay?: () => void;
  confirmMovement?: OwnVotesDepartureRef | undefined;
}) {
  const live = useRef({ owner, dirty, locked, isCurrent, onLeave, onStay });
  const previousOwner = live.current.owner;
  live.current = { owner, dirty, locked, isCurrent, onLeave, onStay };
  const [decision, setDecision] = useState<Decision | null>(null);
  const waiting = useRef<Decision | null>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const connected = useRef(true);
  const approvedMovement = useRef(false);
  const protectedNow = () => live.current.isCurrent() && (live.current.dirty || live.current.locked);

  // Retire during render: a replacement must never inherit a prompt, approval or focus restoration.
  if (previousOwner !== owner) approvedMovement.current = false;
  if (waiting.current && (waiting.current.owner !== owner || !protectedNow())) {
    waiting.current.resolve(false);
    waiting.current = null;
    setDecision(null);
  }
  const visibleDecision = decision?.owner === owner && decision === waiting.current && isCurrent() ? decision : null;

  function choose(leave: boolean) {
    const pending = waiting.current;
    if (!pending || pending.owner !== owner || (leave && live.current.locked)) return;
    waiting.current = null;
    setDecision(null);
    const current = live.current.owner === pending.owner && live.current.isCurrent();
    if (current && !leave) live.current.onStay?.();
    pending.resolve(current && leave);
  }

  function confirm(movement?: SelectionMovement): Promise<boolean> {
    if (waiting.current || !live.current.isCurrent()) return Promise.resolve(false);
    if (!protectedNow()) return Promise.resolve(true);
    const returnFocus = movement
      ? movement.returnFocus
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return new Promise((resolve) => {
      const pending = { owner, returnFocus, resolve };
      waiting.current = pending;
      setDecision(pending);
    });
  }

  const decide = (movement?: SelectionMovement) => {
    const originalAuthority = live.current.isCurrent;
    return confirm(movement).then((leave) => {
      const admittedLeave =
        leave &&
        connected.current &&
        live.current.owner === owner &&
        originalAuthority() &&
        live.current.isCurrent() &&
        !live.current.locked;
      // Same-page selection discards the editor only after its exact target is admitted by the workspace.
      if (admittedLeave && !movement) live.current.onLeave?.();
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
    connected.current = true;
    return () => {
      connected.current = false;
      waiting.current?.resolve(false);
      waiting.current = null;
      approvedMovement.current = false;
    };
  }, []);

  return (
    <AlertDialog open={!!visibleDecision} onOpenChange={(next) => !next && choose(false)}>
      {visibleDecision ? (
        <AlertDialogContent
          initialFocus={stay}
          finalFocus={() =>
            connected.current &&
            live.current.owner === visibleDecision.owner &&
            live.current.isCurrent() &&
            visibleDecision.returnFocus?.isConnected
              ? visibleDecision.returnFocus
              : false
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_my_ratings_departure_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {locked ? m.library_my_ratings_departure_locked() : m.library_my_ratings_departure_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              ref={stay}
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
              onClick={() => choose(false)}
            >
              {m.library_my_ratings_stay()}
            </AlertDialogCancel>
            {!locked ? (
              <AlertDialogAction
                className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
                onClick={() => choose(true)}
              >
                {m.library_my_ratings_leave()}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
