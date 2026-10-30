import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
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
import { sessionQuery, useSession } from '../session/query';
import type { PreferenceChange, ReadingPreferences } from './preferences';
import { sameReading, type ReadingValues } from './reading-preferences';

type DraftKind = 'reading' | 'profile';
type Draft = { kind: DraftKind; needsDecision: () => boolean };

export function readingNeedsNavigationDecision(state: {
  known: ReadingPreferences;
  draft: ReadingValues;
  pending: Readonly<PreferenceChange> | null;
}) {
  return state.pending !== null || !sameReading(state.known, state.draft);
}

/** Only mounted settings editors register here. No draft or command is copied into the navigation owner. */
export class SettingsNavigationDrafts {
  private drafts = new Set<Draft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private resolve: ((stay: boolean) => void) | null = null;
  private active = true;
  snapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  kinds = () =>
    this.active
      ? new Set([...this.drafts].filter((draft) => draft.needsDecision()).map((draft) => draft.kind))
      : new Set<DraftKind>();
  needsDecision = () => this.kinds().size > 0;
  get blocked() {
    return this.resolve !== null;
  }
  refresh = () => {
    if (this.blocked && !this.needsDecision()) this.leave();
    else {
      this.revision++;
      this.listeners.forEach((listener) => listener());
    }
  };
  register = (draft: Draft) => {
    this.drafts.add(draft);
    this.refresh();
    return () => {
      this.drafts.delete(draft);
      this.refresh();
    };
  };
  block = (currentPathname: string, nextPathname: string): boolean | Promise<boolean> => {
    if (currentPathname === nextPathname || !this.needsDecision()) return false;
    // A second attempt cannot replace the destination of the decision already on screen.
    if (this.blocked) return true;
    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
      this.refresh();
    });
  };
  private settle(stay: boolean) {
    const resolve = this.resolve;
    this.resolve = null;
    this.refresh();
    resolve?.(stay);
  }
  stay = () => this.settle(true);
  leave = () => this.settle(false);
  activate = () => {
    this.active = true;
    this.refresh();
  };
  deactivate = () => {
    this.active = false;
    this.leave();
  };
}

const DraftsContext = createContext<SettingsNavigationDrafts | null>(null);

export function useSettingsNavigationOwner() {
  return useContext(DraftsContext);
}

export function useSettingsNavigationDraft(
  kind: DraftKind,
  dirty: boolean,
  needsDecision: () => boolean,
  owner?: object,
) {
  const navigation = useSettingsNavigationOwner();
  const latest = useRef(needsDecision);
  latest.current = needsDecision;
  useLayoutEffect(
    () => navigation?.register({ kind, needsDecision: () => latest.current() }),
    [kind, navigation, owner],
  );
  useLayoutEffect(() => navigation?.refresh(), [dirty, navigation]);
}

/** One router blocker and one accessible decision cover reading, profile, activity and avatar changes. */
export function SettingsNavigationProvider({ children }: { children: ReactNode }) {
  const [navigation] = useState(() => new SettingsNavigationDrafts());
  useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const returnFocus = useRef<HTMLElement | null>(null);
  const stay = useRef<HTMLButtonElement | null>(null);
  const shouldBlockFn = useCallback<ShouldBlockFn>(
    ({ current, next }) => {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const result = navigation.block(current.pathname, next.pathname);
      if (result instanceof Promise) returnFocus.current = focused;
      return result;
    },
    [navigation],
  );
  // Own the resolver synchronously: teardown can release even between shouldBlockFn and the router's await.
  useBlocker({ shouldBlockFn, withResolver: false, enableBeforeUnload: navigation.needsDecision });
  useLayoutEffect(() => {
    navigation.activate();
    // Native sign-out must never wait for a draft decision or a beforeunload prompt.
    const signingOut = (event: SubmitEvent) => {
      const form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
      const action = new URL(form.action);
      if (action.origin === window.location.origin && action.pathname === '/auth/sign-out') navigation.deactivate();
    };
    document.addEventListener('submit', signingOut);
    return () => {
      document.removeEventListener('submit', signingOut);
      navigation.deactivate();
    };
  }, [navigation]);
  const kinds = navigation.kinds();
  const reading = kinds.has('reading');
  const combined = reading && kinds.has('profile');
  return (
    <DraftsContext.Provider value={navigation}>
      {children}
      <AlertDialog
        open={navigation.blocked && kinds.size > 0}
        onOpenChange={(open) => {
          if (!open) navigation.stay();
        }}
      >
        <AlertDialogContent
          initialFocus={stay}
          finalFocus={returnFocus}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {combined
                ? m.settings_drafts_leave_title()
                : reading
                  ? m.settings_reading_leave_title()
                  : m.settings_profile_leave_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {combined
                ? m.settings_drafts_leave_description()
                : reading
                  ? m.settings_reading_leave_description()
                  : m.settings_profile_leave_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stay} className="min-h-11" onClick={navigation.stay}>
              {m.settings_profile_stay()}
            </AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={navigation.leave}>
              {m.settings_profile_leave()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DraftsContext.Provider>
  );
}

const alwaysCurrent = () => true;
const ReadingOwnerContext = createContext(alwaysCurrent);
export function useReadingNavigationCurrent() {
  return useContext(ReadingOwnerContext);
}

/** Retire this mounted reading card when its session changes, even while the route loader is stale. */
export function ReadingNavigation({ csrfToken, children }: { csrfToken: string | null; children: ReactNode }) {
  const session = useSession();
  const client = useQueryClient();
  const owner = useRef<{ token: string; subject: string | null } | null>(null);
  const retired = useRef(false);
  if (!owner.current && session.state === 'signed-in' && session.csrfToken)
    owner.current = { token: session.csrfToken, subject: session.subject ?? null };
  const isCurrent = useCallback(() => {
    const current = client.getQueryData(sessionQuery.queryKey);
    return (
      !retired.current &&
      !!owner.current &&
      current?.state === 'signed-in' &&
      current.csrfToken === owner.current.token &&
      (current.subject ?? null) === owner.current.subject &&
      csrfToken === owner.current.token
    );
  }, [client, csrfToken]);
  if ((owner.current && !isCurrent()) || session.state === 'signed-out') retired.current = true;
  return retired.current ? (
    <div className="space-y-3">
      <h2 id="settings-reading-heading">{m.settings_reading_heading()}</h2>
      <p role="status">{m.settings_reading_session_changed()}</p>
      <Button type="button" variant="outline" onClick={() => window.location.reload()}>
        {m.settings_reload()}
      </Button>
    </div>
  ) : (
    <ReadingOwnerContext.Provider value={isCurrent}>{children}</ReadingOwnerContext.Provider>
  );
}
