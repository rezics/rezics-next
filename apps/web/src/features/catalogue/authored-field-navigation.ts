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
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import { authoredDraftHasContent, type AuthoredDraft } from './authored-field-state';

export function authoredFieldNavigationState(
  drafts: Readonly<Record<string, AuthoredDraft>>,
  pending: boolean,
  confirmed: boolean,
) {
  const dirty = !confirmed && Object.values(drafts).some(authoredDraftHasContent);
  return { dirty, pending, protect: dirty || pending };
}

export function AuthoredFieldNavigation({
  drafts,
  pending,
  confirmed,
}: {
  drafts: Readonly<Record<string, AuthoredDraft>>;
  pending: boolean;
  confirmed: boolean;
}) {
  const { dirty, protect } = authoredFieldNavigationState(drafts, pending, confirmed);
  const { hasOwner } = useAuthoringDeparture(protect, pending, JSON.stringify([drafts, pending, confirmed]));
  const router = useRouter({ warn: false });
  useEffect(() => {
    if (!protect || hasOwner) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [protect, hasOwner]);

  return !hasOwner && router ? createElement(RouterAuthoredDeparture, { dirty, pending, protect }) : null;
}

function RouterAuthoredDeparture({ dirty, pending, protect }: { dirty: boolean; pending: boolean; protect: boolean }) {
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
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useLayoutEffect(
    () => () => {
      const pendingBlocker = blockerRef.current;
      if (pendingBlocker.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        pendingBlocker.reset();
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

  return createElement(
    AlertDialog,
    { open: blocker.status === 'blocked', onOpenChange: (open: boolean) => !open && resolve(false) },
    createElement(
      AlertDialogContent,
      {
        initialFocus: stayButton,
        finalFocus: () => (leaving.current ? false : returnFocus.current?.isConnected ? returnFocus.current : false),
      },
      createElement(
        AlertDialogHeader,
        null,
        createElement(AlertDialogTitle, null, m.thread_authoring_discard_title()),
        createElement(
          AlertDialogDescription,
          null,
          pending ? m.thread_authoring_discard_pending() : m.thread_authoring_discard_unsaved(),
        ),
      ),
      createElement(
        AlertDialogFooter,
        null,
        createElement(AlertDialogCancel, { ref: stayButton }, m.thread_authoring_stay()),
        createElement(
          AlertDialogAction,
          { variant: 'destructive', onClick: () => resolve(true) },
          m.thread_authoring_discard(),
        ),
      ),
    ),
  );
}
