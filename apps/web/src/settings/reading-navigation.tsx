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
import type { PreferenceChange, ReadingPreferences } from './preferences';
import { sameReading, type ReadingValues } from './reading-preferences';
import { SettingsSessionContext, useSettingsCurrent, useSettingsSessionOwner } from './settings-session-owner';

type DraftKind = 'watches' | 'reading' | 'profile' | 'notifications' | 'collection-privacy' | 'verification';
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

/** A mounted editor cannot lend an old viewer's draft to a new session, even before React tears it down. */
export function useSettingsNavigationCurrent(csrfToken: string | null) {
  return useSettingsCurrent(csrfToken, true);
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

/** One router blocker and one accessible decision cover every mounted Settings editor. */
export function SettingsNavigationProvider({ children }: { children: ReactNode }) {
  const [navigation] = useState(() => new SettingsNavigationDrafts());
  const sessionOwner = useContext(SettingsSessionContext);
  useLayoutEffect(
    () =>
      sessionOwner?.subscribe(() => {
        if (!sessionOwner.readCurrent()) navigation.deactivate();
      }),
    [navigation, sessionOwner],
  );
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
  const additional = kinds.has('notifications') || kinds.has('collection-privacy') || kinds.has('verification');
  const title = additional
    ? kinds.size > 1
      ? m.settings_all_drafts_leave_title()
      : kinds.has('notifications')
        ? m.settings_notifications_leave_title()
        : kinds.has('collection-privacy')
          ? m.settings_privacy_leave_title()
          : m.settings_verification_leave_title()
    : combined
      ? m.settings_drafts_leave_title()
      : reading
        ? m.settings_reading_leave_title()
        : m.settings_profile_leave_title();
  const description = additional
    ? m.settings_other_drafts_leave_description()
    : combined
      ? m.settings_drafts_leave_description()
      : reading
        ? m.settings_reading_leave_description()
        : m.settings_profile_leave_description();
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
          className="min-w-0 w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-w-sm overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:max-w-lg"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="min-w-0 flex-col-reverse sm:flex-row sm:flex-wrap">
            <AlertDialogCancel
              ref={stay}
              className="h-auto min-h-11 min-w-0 w-full max-w-full py-2 whitespace-normal wrap-anywhere sm:w-auto"
              onClick={navigation.stay}
            >
              {m.settings_profile_stay()}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-auto min-h-11 min-w-0 w-full max-w-full py-2 whitespace-normal wrap-anywhere sm:w-auto"
              onClick={navigation.leave}
            >
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
  const owner = useSettingsSessionOwner(csrfToken);
  const isCurrent = owner?.isCurrent ?? alwaysCurrent;
  return owner && !owner.readCurrent() ? (
    <div className="min-w-0 max-w-full space-y-3">
      <h2 id="settings-reading-heading">{m.settings_reading_heading()}</h2>
      <p role="status">{m.settings_reading_session_changed()}</p>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 min-w-11 w-full max-w-sm py-2 whitespace-normal wrap-anywhere"
        onClick={() => window.location.reload()}
      >
        {m.settings_reload()}
      </Button>
    </div>
  ) : (
    <ReadingOwnerContext.Provider value={isCurrent}>{children}</ReadingOwnerContext.Provider>
  );
}
