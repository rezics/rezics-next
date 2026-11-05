import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
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

export type CopyDraftNavigationHandle = { requestClose: (onDiscard?: () => void, description?: string) => void };

type Prompt = 'close' | 'navigation';
type State = {
  authorized: boolean;
  dirty: boolean;
  locked: boolean;
  requestNavigation: () => boolean | Promise<boolean>;
};

function RouterBlocker({ state }: { state: State }) {
  const latest = useRef(state);
  latest.current = state;
  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search))
        return false;
      const currentState = latest.current;
      if (!currentState.authorized || (!currentState.dirty && !currentState.locked)) return false;
      return currentState.requestNavigation();
    },
    withResolver: false,
    enableBeforeUnload: () => {
      const currentState = latest.current;
      return currentState.authorized && (currentState.dirty || currentState.locked);
    },
  });
  return null;
}

export const CopyDraftNavigation = forwardRef<
  CopyDraftNavigationHandle,
  {
    authorized: boolean;
    dirty: boolean;
    locked: boolean;
    routeProtection: boolean;
    onDiscard: () => void;
  }
>(function CopyDraftNavigation({ authorized, dirty, locked, routeProtection, onDiscard }, ref) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [discardDescription, setDiscardDescription] = useState<string | null>(null);
  const activePrompt = useRef<Prompt | null>(null);
  const discardAction = useRef<(() => void) | null>(null);
  const resolveNavigation = useRef<((stay: boolean) => void) | null>(null);
  const latest = useRef({ authorized, dirty, locked, onDiscard });
  latest.current = { authorized, dirty, locked, onDiscard };

  const settleNavigation = useCallback((stay: boolean) => {
    const resolve = resolveNavigation.current;
    resolveNavigation.current = null;
    resolve?.(stay);
  }, []);
  const requestNavigation = useCallback(() => {
    const current = latest.current;
    if (!current.authorized || (!current.dirty && !current.locked)) return false;
    if (activePrompt.current) return true;
    return new Promise<boolean>((resolve) => {
      resolveNavigation.current = resolve;
      activePrompt.current = 'navigation';
      setPrompt('navigation');
    });
  }, []);
  const requestClose = useCallback((onDiscard?: () => void, description?: string) => {
    const current = latest.current;
    if (!current.authorized) return;
    if (!current.dirty && !current.locked) {
      (onDiscard ?? current.onDiscard)();
      return;
    }
    if (activePrompt.current) return;
    discardAction.current = onDiscard ?? null;
    setDiscardDescription(description ?? null);
    activePrompt.current = 'close';
    setPrompt('close');
  }, []);
  useImperativeHandle(ref, () => ({ requestClose }), [requestClose]);

  const stay = () => {
    discardAction.current = null;
    const wasNavigation = activePrompt.current === 'navigation';
    activePrompt.current = null;
    setPrompt(null);
    if (wasNavigation) settleNavigation(true);
  };
  const discard = () => {
    const current = latest.current;
    const wasNavigation = activePrompt.current === 'navigation';
    if (!current.authorized) {
      activePrompt.current = null;
      setPrompt(null);
      settleNavigation(false);
      return;
    }
    if (current.locked) return;
    activePrompt.current = null;
    setPrompt(null);
    if (wasNavigation) settleNavigation(false);
    else {
      const action = discardAction.current ?? current.onDiscard;
      discardAction.current = null;
      action();
    }
  };

  useEffect(() => {
    const currentPrompt = activePrompt.current;
    if (!currentPrompt) return;
    if (!authorized) {
      activePrompt.current = null;
      setPrompt(null);
      settleNavigation(false);
      return;
    }
    if (currentPrompt === 'navigation' && !dirty && !locked) {
      activePrompt.current = null;
      setPrompt(null);
      settleNavigation(false);
    }
  }, [authorized, dirty, locked, settleNavigation]);
  useEffect(() => () => settleNavigation(false), [settleNavigation]);

  const state: State = { authorized, dirty, locked, requestNavigation };
  const stayButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      {routeProtection ? <RouterBlocker state={state} /> : null}
      <AlertDialog
        open={prompt !== null && authorized}
        onOpenChange={(open) => {
          if (!open) stay();
        }}
      >
        <AlertDialogContent initialFocus={stayButton} className="min-w-0 max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_copy_draft_navigation_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {locked
                ? m.library_copy_draft_navigation_pending()
                : prompt === 'close' && discardDescription
                  ? discardDescription
                  : m.library_copy_draft_navigation_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="min-w-0 flex-col-reverse sm:flex-row sm:flex-wrap">
            <AlertDialogCancel ref={stayButton} onClick={stay}>
              {m.library_copy_draft_navigation_stay()}
            </AlertDialogCancel>
            {dirty && !locked ? (
              <AlertDialogAction onClick={discard}>{m.library_copy_draft_navigation_discard()}</AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});
