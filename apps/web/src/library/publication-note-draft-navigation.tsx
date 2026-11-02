import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
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

type DraftState = { active: boolean; dirty: boolean; locked: boolean };
type DraftRegistration = {
  state: () => DraftState;
  discard: () => void;
};
type DraftOptions = {
  identity: object;
  state: DraftState;
  getState?: () => DraftState;
  subscribe?: (listener: () => void) => () => void;
  discard: () => void;
};

/** A Progress page has one navigation decision for its editor and publication note. */
class ProgressDeparture {
  private drafts = new Set<DraftRegistration>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private decision: { resolve: (stay: boolean) => void } | null = null;
  private focusTarget: HTMLElement | null = null;
  private suppressFocusReturn = false;

  snapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get waiting() {
    return this.decision !== null;
  }
  get returningFocus() {
    return this.focusTarget;
  }
  get shouldSuppressFocusReturn() {
    return this.suppressFocusReturn;
  }

  private notify() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }

  private current() {
    return [...this.drafts].map((draft) => ({ draft, state: draft.state() })).filter(({ state }) => state.active);
  }

  needsDecision = () => this.current().some(({ state }) => state.dirty || state.locked);
  isLocked = () => this.current().some(({ state }) => state.locked);

  register(draft: DraftRegistration) {
    this.drafts.add(draft);
    this.refresh();
    return () => {
      this.drafts.delete(draft);
      this.refresh();
    };
  }

  refresh = () => {
    if (this.decision && !this.needsDecision()) this.settle(false);
    else this.notify();
  };

  requestNavigation = (focused: HTMLElement | null) => {
    if (!this.needsDecision()) return false;
    if (this.decision) return true;
    this.focusTarget = focused;
    this.suppressFocusReturn = false;
    return new Promise<boolean>((resolve) => {
      this.decision = { resolve };
      this.notify();
    });
  };

  stay = () => this.settle(true);

  discard = () => {
    if (this.isLocked()) return;
    for (const { draft, state } of this.current()) if (state.dirty) draft.discard();
    this.settle(false);
  };

  private settle(stay: boolean) {
    const decision = this.decision;
    if (!decision) return;
    this.decision = null;
    this.suppressFocusReturn = !stay;
    this.notify();
    decision.resolve(stay);
  }
}

const DepartureContext = createContext<ProgressDeparture | null>(null);

export function PublicationNoteDraftNavigation({
  children,
  messages = 'publication-note',
}: {
  children: ReactNode;
  messages?: 'publication-note' | 'progress';
}) {
  const [navigation] = useState(() => new ProgressDeparture());
  useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const stayButton = useRef<HTMLButtonElement>(null);

  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search))
        return false;
      return navigation.requestNavigation(
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      );
    },
    withResolver: false,
    enableBeforeUnload: () => navigation.needsDecision(),
  });

  return (
    <DepartureContext.Provider value={navigation}>
      {children}
      <AlertDialog
        open={navigation.waiting}
        onOpenChange={(open) => {
          if (!open) navigation.stay();
        }}
      >
        <AlertDialogContent
          initialFocus={stayButton}
          finalFocus={() =>
            navigation.shouldSuppressFocusReturn
              ? false
              : navigation.returningFocus?.isConnected
                ? navigation.returningFocus
                : undefined
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {messages === 'progress'
                ? m.library_progress_draft_navigation_title()
                : m.library_publication_note_draft_navigation_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {messages === 'progress'
                ? navigation.isLocked()
                  ? m.library_progress_draft_navigation_pending()
                  : m.library_progress_draft_navigation_description()
                : navigation.isLocked()
                  ? m.library_publication_note_draft_navigation_pending()
                  : m.library_publication_note_draft_navigation_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stayButton} onClick={navigation.stay}>
              {messages === 'progress'
                ? m.library_progress_draft_navigation_stay()
                : m.library_publication_note_draft_navigation_stay()}
            </AlertDialogCancel>
            {!navigation.isLocked() ? (
              <AlertDialogAction onClick={navigation.discard}>
                {messages === 'progress'
                  ? m.library_progress_draft_navigation_discard()
                  : m.library_publication_note_draft_navigation_discard()}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DepartureContext.Provider>
  );
}

export function hasMeaningfulPublicationNote(note: string) {
  return note.trim().length > 0;
}

export function usePublicationNoteDraftNavigation(options: DraftOptions) {
  const navigation = useContext(DepartureContext);
  const latest = useRef(options);
  latest.current = options;
  const { active, dirty, locked } = options.state;

  useLayoutEffect(() => {
    if (!navigation) return;
    const remove = navigation.register({
      state: () => latest.current.getState?.() ?? latest.current.state,
      discard: () => latest.current.discard(),
    });
    const unsubscribe = latest.current.subscribe?.(navigation.refresh);
    return () => {
      unsubscribe?.();
      remove();
    };
  }, [navigation, options.identity]);

  useLayoutEffect(() => navigation?.refresh(), [navigation, active, dirty, locked, options.identity]);

  return {
    requestNavigation: () =>
      Promise.resolve(
        navigation?.requestNavigation(
          document.activeElement instanceof HTMLElement ? document.activeElement : null,
        ) ?? false,
      ),
  };
}
