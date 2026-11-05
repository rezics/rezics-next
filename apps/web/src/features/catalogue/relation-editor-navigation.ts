import { useBlocker, useRouter } from '@tanstack/react-router';
import { createElement, useEffect, useRef } from 'react';
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

export function RelationEditorNavigation({
  dirty,
  pending,
  isCurrent,
}: {
  dirty: boolean;
  pending: boolean;
  isCurrent: () => boolean;
}) {
  const router = useRouter({ warn: false });
  const { hasOwner } = useAuthoringDeparture(
    () => isCurrent() && (dirty || pending),
    pending,
    JSON.stringify([dirty, pending]),
  );
  // A composed correction page owns the single decision for all its sibling editors.
  if (hasOwner) return null;
  return router ? createElement(RouterRelationEditorNavigation, { dirty, pending, isCurrent }) : null;
}

function RouterRelationEditorNavigation({
  dirty,
  pending,
  isCurrent,
}: {
  dirty: boolean;
  pending: boolean;
  isCurrent: () => boolean;
}) {
  const resolved = useRef(false);
  const active = isCurrent();
  const live = useRef({ active, dirty, pending });
  live.current = { active, dirty, pending };
  const needsChoice = dirty || pending;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      // Same-path state changes, including candidate choices, stay inside this editor.
      if (current.pathname === next.pathname || !live.current.active || !(live.current.dirty || live.current.pending))
        return false;
      resolved.current = false;
      return true;
    },
    disabled: !needsChoice || !active,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;

  useEffect(() => {
    if ((!needsChoice || !active) && blocker.status === 'blocked' && !resolved.current) {
      resolved.current = true;
      blocker.reset();
    }
  }, [active, blocker, needsChoice]);
  useEffect(
    () => () => {
      const pendingBlock = blockerRef.current;
      if (pendingBlock.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        pendingBlock.reset();
      }
    },
    [],
  );
  useEffect(() => {
    if (!needsChoice) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!live.current.active || !(live.current.dirty || live.current.pending)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [needsChoice]);

  function resolve(leave: boolean) {
    if (blocker.status !== 'blocked' || resolved.current) return;
    resolved.current = true;
    if (leave && live.current.active && (live.current.dirty || live.current.pending)) blocker.proceed();
    else blocker.reset();
  }

  return createElement(
    AlertDialog,
    { open: blocker.status === 'blocked', onOpenChange: (open) => !open && resolve(false) },
    blocker.status === 'blocked'
      ? createElement(
          AlertDialogContent,
          null,
          createElement(
            AlertDialogHeader,
            null,
            createElement(AlertDialogTitle, null, m.thread_authoring_leave_title()),
            createElement(
              AlertDialogDescription,
              null,
              pending ? m.thread_authoring_leave_pending() : m.thread_authoring_leave_unsaved(),
            ),
          ),
          createElement(
            AlertDialogFooter,
            null,
            createElement(AlertDialogCancel, { onClick: () => resolve(false) }, m.thread_authoring_stay()),
            createElement(
              AlertDialogAction,
              { variant: 'destructive', onClick: () => resolve(true) },
              m.thread_authoring_leave(),
            ),
          ),
        )
      : null,
  );
}
