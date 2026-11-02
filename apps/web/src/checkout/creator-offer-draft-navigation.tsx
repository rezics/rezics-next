import { useBlocker, useRouter } from '@tanstack/react-router';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../paraglide/messages.js';
import type { CreatorOfferGuard } from './creator-offers';

type Draft = {
  guard: CreatorOfferGuard;
  dirty: boolean;
  mayCommit: boolean;
  discard(): void;
};
type Registry = {
  drafts: Map<string, { current: Draft }>;
  update(): void;
};
const Drafts = createContext<Registry | null>(null);
const protectedDrafts = (registry: Registry) =>
  [...registry.drafts.values()].map((ref) => ref.current)
    .filter((draft) => draft.guard.isCurrent() && (draft.dirty || draft.mayCommit));

/** One departure decision covers every edited offer on this mounted page. */
export function CreatorOfferDraftNavigation({ children }: { children: ReactNode }) {
  const [, render] = useState(0);
  const [registry] = useState<Registry>(() => ({ drafts: new Map(), update: () => render((n) => n + 1) }));
  const [prompt, setPrompt] = useState(false);
  const resolver = useRef<((stay: boolean) => void) | null>(null);
  const field = useRef<HTMLElement | null>(null);
  const leaving = useRef(false);
  const nativeLeaving = useRef(false);
  const stayButton = useRef<HTMLButtonElement>(null);
  const router = useRouter({ warn: false });
  const settle = useCallback((stay: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPrompt(false);
    resolve?.(stay);
  }, []);
  const request = useCallback(() => {
    if (!protectedDrafts(registry).length) return false;
    leaving.current = false;
    if (resolver.current) return true;
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPrompt(true);
    });
  }, [registry]);
  const drafts = protectedDrafts(registry);
  const mayCommit = drafts.some((draft) => draft.mayCommit);
  useEffect(() => {
    if (!drafts.length && resolver.current) settle(true);
  });
  useEffect(() => () => {
    resolver.current?.(true);
    resolver.current = null;
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (nativeLeaving.current || !protectedDrafts(registry).length) return;
      event.preventDefault();
      event.returnValue = '';
    };
    // Existing native anchors still get the same explicit choice as router links.
    const anchor = async (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const next = new URL(link.href, window.location.href);
      if (next.origin !== window.location.origin || !/^https?:$/.test(next.protocol)) return;
      if (next.pathname === window.location.pathname && next.search === window.location.search && next.hash) return;
      if (!protectedDrafts(registry).length) return;
      event.preventDefault();
      if (!(await request())) {
        nativeLeaving.current = true;
        window.location.assign(next.href);
      }
    };
    const restore = () => { nativeLeaving.current = false; };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('pageshow', restore);
    document.addEventListener('click', anchor);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('pageshow', restore);
      document.removeEventListener('click', anchor);
    };
  }, [registry, request]);
  function leave() {
    if (!protectedDrafts(registry).length) return settle(true);
    for (const draft of protectedDrafts(registry)) {
      // An unresolved command remains exclusively owned by its existing intent store.
      if (!draft.mayCommit) draft.discard();
    }
    leaving.current = true;
    settle(false);
  }
  return (
    <Drafts.Provider value={registry}>
      <div onFocusCapture={(event) => {
        if (event.target.matches('input, select, textarea')) field.current = event.target;
      }}>
        {children}
      </div>
      {router && <RouterDraftNavigation request={request} />}
      <AlertDialog open={prompt && drafts.length > 0} onOpenChange={(open) => { if (!open) settle(true); }}>
        <AlertDialogContent initialFocus={stayButton} finalFocus={() =>
          !leaving.current && field.current?.isConnected ? field.current : false
        }>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.creator_offer_draft_navigation_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {mayCommit ? m.creator_offer_draft_navigation_uncertain() : m.creator_offer_draft_navigation_discard()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stayButton} onClick={() => settle(true)}>{m.creator_offer_draft_navigation_stay()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={leave}>{m.creator_offer_draft_navigation_leave()}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Drafts.Provider>
  );
}

function RouterDraftNavigation({ request }: { request(): boolean | Promise<boolean> }) {
  useBlocker({ shouldBlockFn: request, withResolver: false, enableBeforeUnload: false });
  return null;
}

/** Live state uses exact raw fields, including incomplete and invalid input. */
export function CreatorOfferDraftState(props: Draft) {
  const registry = useContext(Drafts);
  const id = useId();
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    if (!registry) return;
    registry.drafts.set(id, latest);
    registry.update();
    return () => { registry.drafts.delete(id); registry.update(); };
  }, [registry, id]);
  useLayoutEffect(() => { registry?.update(); }, [registry, props.dirty, props.mayCommit, props.guard]);
  return (
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
      {props.guard.isCurrent() && (props.mayCommit
        ? m.creator_offer_draft_navigation_uncertain()
        : props.dirty ? m.creator_offer_draft_navigation_unsaved() : '')}
    </p>
  );
}
