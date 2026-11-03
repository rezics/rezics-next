import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useBlocker, useRouter } from '@tanstack/react-router';
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
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';

type DepartureKind = 'realm-claim' | 'realm-ban' | 'container-lifecycle';
type Draft = {
  needsDecision: () => boolean;
  unresolved: () => boolean;
  discard: () => void;
  leave?: () => void;
  messages?: () => NavigationMessages | undefined;
  navigationContext?: NavigationContext | undefined;
  kind?: DepartureKind | undefined;
};
type Decision = { kind: 'navigation'; resolve: (stay: boolean) => void } | { kind: 'discard'; draftId: number };

export type AuthoringLocation = { pathname: string; search: Record<string, unknown> };
type NavigationContext = (location: AuthoringLocation) => string;
type NavigationMessages = {
  title: string;
  unsaved: string;
  pending: string;
  discardTitle?: string;
  discardUnsaved?: string;
  discardPending?: string;
  discardAction?: string;
};
const pathnameContext: NavigationContext = (location) => location.pathname;

/** A page-local registry keeps editors' state in their owners while presenting one shared decision. */
export class AuthoringDepartureState {
  private drafts = new Map<number, Draft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private nextId = 0;
  private active = true;
  private decision: Decision | null = null;
  private focusTarget: HTMLElement | null = null;
  private leaving = false;

  constructor(private readonly onNavigationLeave: () => void = () => {}) {}

  snapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get prompt() {
    return this.decision;
  }
  get returningFocus() {
    return this.focusTarget;
  }
  get suppressFocusReturn() {
    return this.leaving;
  }
  needsDecision = () => this.active && [...this.drafts.values()].some((draft) => draft.needsDecision());
  hasRealmClaim = () =>
    this.active && [...this.drafts.values()].some((draft) => draft.kind === 'realm-claim' && draft.needsDecision());
  hasRealmBan = () =>
    this.active && [...this.drafts.values()].some((draft) => draft.kind === 'realm-ban' && draft.needsDecision());
  get promptMessages() {
    const selected = this.decision?.kind === 'discard' ? this.drafts.get(this.decision.draftId) : undefined;
    const candidates = selected
      ? [selected].filter((draft): draft is Draft => draft.needsDecision())
      : [...this.drafts.values()].filter((draft) => draft.needsDecision());
    const draft =
      candidates.find((candidate) => candidate.kind === 'container-lifecycle' && candidate.unresolved()) ??
      candidates.find((candidate) => candidate.unresolved()) ??
      candidates.find((candidate) => candidate.kind === 'container-lifecycle') ??
      candidates[0];
    return draft?.messages?.();
  }
  unresolved = () => {
    const id = this.decision?.kind === 'discard' ? this.decision.draftId : undefined;
    return (
      this.active &&
      [...this.drafts.entries()].some(
        ([draftId, draft]) => (id === undefined || id === draftId) && draft.needsDecision() && draft.unresolved(),
      )
    );
  };

  private notify() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }

  private settleNavigation(stay: boolean) {
    const decision = this.decision;
    if (decision?.kind !== 'navigation') return;
    this.decision = null;
    if (!stay) {
      this.retireNavigation();
    }
    this.leaving = !stay;
    this.notify();
    decision.resolve(stay);
  }

  private retireNavigation() {
    for (const draft of [...this.drafts.values()]) draft.leave?.();
    this.onNavigationLeave();
  }

  /** Local selectors and continuation buttons share the router's single decision. */
  requestNavigation = (proceed: () => void, focused: HTMLElement | null) => {
    if (!this.active) return;
    const blocked = this.block('', 'local-navigation', focused);
    if (blocked === false) {
      this.retireNavigation();
      proceed();
    } else if (blocked instanceof Promise) {
      void blocked.then((stay) => {
        if (!stay && this.active) proceed();
      });
    }
  };

  register(draft: Draft) {
    const id = ++this.nextId;
    if (this.active) this.drafts.set(id, draft);
    this.refresh();
    return {
      id,
      remove: () => {
        this.drafts.delete(id);
        if (this.decision?.kind === 'discard' && this.decision.draftId === id) this.decision = null;
        this.refresh();
      },
    };
  }

  refresh = () => {
    if (this.decision?.kind === 'navigation' && !this.needsDecision()) this.settleNavigation(false);
    else if (this.decision?.kind === 'discard' && !this.drafts.get(this.decision.draftId)?.needsDecision())
      this.decision = null;
    this.notify();
  };

  block = (currentContext: string, nextContext: string, focused: HTMLElement | null) => {
    if (!this.active || currentContext === nextContext || !this.needsDecision()) return false;
    if (this.decision) return true;
    this.focusTarget = focused;
    this.leaving = false;
    return new Promise<boolean>((resolve) => {
      this.decision = { kind: 'navigation', resolve };
      this.notify();
    });
  };

  blockLocation = (
    current: AuthoringLocation,
    next: AuthoringLocation,
    defaultContext: NavigationContext,
    focused: HTMLElement | null,
  ) => {
    const changed = [...this.drafts.values()].some((draft) => {
      const context = draft.navigationContext ?? defaultContext;
      return draft.needsDecision() && context(current) !== context(next);
    });
    return changed ? this.block('current', 'next', focused) : false;
  };

  requestDiscard = (draftId: number, focused: HTMLElement | null) => {
    const draft = this.drafts.get(draftId);
    if (!draft) return;
    if (!this.active || !draft.needsDecision()) {
      draft.discard();
      return;
    }
    if (this.decision) return;
    this.focusTarget = focused;
    this.leaving = false;
    this.decision = { kind: 'discard', draftId };
    this.notify();
  };

  stay = () => {
    const decision = this.decision;
    if (!decision) return;
    if (decision.kind === 'navigation') this.settleNavigation(true);
    else {
      this.decision = null;
      this.notify();
    }
  };

  leave = () => {
    const decision = this.decision;
    if (!decision) return;
    if (decision.kind === 'navigation') {
      this.settleNavigation(false);
    } else {
      this.decision = null;
      this.leaving = true;
      this.notify();
      this.drafts.get(decision.draftId)?.discard();
    }
  };

  deactivate = () => {
    if (!this.active) return;
    this.active = false;
    this.drafts.clear();
    const decision = this.decision;
    this.decision = null;
    this.leaving = true;
    this.notify();
    if (decision?.kind === 'navigation') decision.resolve(false);
  };
}

const DepartureContext = createContext<AuthoringDepartureState | null>(null);

/** Use one page owner for sibling reply and inline-edit composers. */
export function AuthoringDepartureProvider({
  children,
  navigationContext = pathnameContext,
  onNavigationLeave,
  navigationMessages,
  sessionBound = true,
}: {
  children: ReactNode;
  navigationContext?: NavigationContext;
  onNavigationLeave?: () => void;
  navigationMessages?: NavigationMessages;
  /** `subject` treats a same-account token refresh as the same session; `true` also binds the token. */
  sessionBound?: boolean | 'subject';
}) {
  const leave = useRef(onNavigationLeave);
  leave.current = onNavigationLeave;
  const [navigation] = useState(() => new AuthoringDepartureState(() => leave.current?.()));
  const revision = useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const router = useRouter({ warn: false });
  const client = useContext(QueryClientContext);
  const sessionSubscribe = useCallback(
    (listener: () => void) => client?.getQueryCache().subscribe(listener) ?? (() => {}),
    [client],
  );
  const sessionSnapshot = useCallback(() => client?.getQueryData(sessionQuery.queryKey), [client]);
  const session = useSyncExternalStore(sessionSubscribe, sessionSnapshot, sessionSnapshot);
  const owner = useRef<{ subject: string | null; csrfToken: string | null } | null>(null);
  const retired = useRef(false);
  if (sessionBound && session?.state === 'signed-in') {
    if (!owner.current) owner.current = { subject: session.subject ?? null, csrfToken: session.csrfToken };
    else if (
      owner.current.subject !== (session.subject ?? null) ||
      (sessionBound === true && owner.current.csrfToken !== session.csrfToken)
    )
      retired.current = true;
  } else if (sessionBound && owner.current) retired.current = true;

  useLayoutEffect(() => {
    if (retired.current) navigation.deactivate();
  }, [navigation, session]);

  useEffect(() => {
    if (!navigation.needsDecision()) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!navigation.needsDecision()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [navigation, revision]);

  useEffect(() => {
    const signingOut = (event: SubmitEvent) => {
      const form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
      const action = new URL(form.action, window.location.href);
      if (action.origin === window.location.origin && action.pathname === '/auth/sign-out') {
        leave.current?.();
        navigation.deactivate();
      }
    };
    document.addEventListener('submit', signingOut);
    return () => document.removeEventListener('submit', signingOut);
  }, [navigation]);

  return (
    <DepartureContext.Provider value={navigation}>
      {retired.current ? (
        <div
          role="alert"
          className="mx-auto grid min-w-0 max-w-2xl grid-cols-[minmax(0,1fr)] gap-4 rounded-2xl border border-border bg-card p-5 text-start text-foreground sm:p-6"
        >
          <p className="min-w-0 text-base leading-relaxed [overflow-wrap:anywhere]">
            {m.thread_authoring_session_changed()}
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-3 text-center leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring sm:w-fit"
            onClick={() => window.location.reload()}
          >
            <span className="min-w-0">{m.settings_reload()}</span>
          </Button>
        </div>
      ) : (
        children
      )}
      {router ? <RouterDeparture navigation={navigation} navigationContext={navigationContext} /> : null}
      <AlertDialog
        open={navigation.prompt !== null}
        onOpenChange={(open) => {
          if (!open) navigation.stay();
        }}
      >
        <DepartureDialog navigation={navigation} messages={navigationMessages} />
      </AlertDialog>
    </DepartureContext.Provider>
  );
}

function RouterDeparture({
  navigation,
  navigationContext,
}: {
  navigation: AuthoringDepartureState;
  navigationContext: NavigationContext;
}) {
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      navigation.blockLocation(
        current,
        next,
        navigationContext,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      ),
    withResolver: false,
    enableBeforeUnload: false,
  });
  return null;
}

function DepartureDialog({
  navigation,
  messages,
}: {
  navigation: AuthoringDepartureState;
  messages?: NavigationMessages | undefined;
}) {
  const stayButton = useRef<HTMLButtonElement>(null);
  const discard = navigation.prompt?.kind === 'discard';
  const recovery = navigation.unresolved();
  const claim = !discard && navigation.hasRealmClaim();
  const ban = !discard && !claim && navigation.hasRealmBan();
  const promptMessages = messages ?? navigation.promptMessages;
  return (
    <AlertDialogContent
      className="min-w-0 max-w-lg grid-cols-[minmax(0,1fr)] gap-6 p-5 text-start sm:max-w-xl sm:p-6"
      initialFocus={stayButton}
      finalFocus={() =>
        navigation.suppressFocusReturn
          ? false
          : navigation.returningFocus?.isConnected
            ? navigation.returningFocus
            : undefined
      }
    >
      <AlertDialogHeader className="min-w-0 grid-cols-[minmax(0,1fr)] place-items-stretch gap-3 text-start sm:group-data-[size=default]/alert-dialog-content:place-items-stretch sm:group-data-[size=default]/alert-dialog-content:text-start">
        <AlertDialogTitle className="min-w-0 text-xl leading-snug [overflow-wrap:anywhere]">
          {discard
            ? (messages?.discardTitle ?? m.thread_authoring_discard_title())
            : claim
              ? m.realm_claim_leave_title()
              : ban
                ? m.realm_bans_leave_title()
                : (promptMessages?.title ?? m.thread_authoring_leave_title())}
        </AlertDialogTitle>
        <AlertDialogDescription className="min-w-0 text-base leading-relaxed text-pretty [overflow-wrap:anywhere]">
          {claim
            ? recovery
              ? m.realm_claim_leave_pending()
              : m.realm_claim_leave_confirmation()
            : ban
              ? recovery
                ? m.realm_bans_leave_pending()
                : m.realm_bans_leave_unsaved()
              : discard
                ? recovery
                  ? (messages?.discardPending ?? m.thread_authoring_discard_pending())
                  : (messages?.discardUnsaved ?? m.thread_authoring_discard_unsaved())
                : recovery
                  ? (messages?.pending ?? m.thread_authoring_leave_pending())
                  : (messages?.unsaved ?? m.thread_authoring_leave_unsaved())}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-3 sm:grid-cols-2">
        <AlertDialogCancel
          ref={stayButton}
          className="h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-3 text-center leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          <span className="min-w-0">{m.thread_authoring_stay()}</span>
        </AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          className="h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-3 text-center leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
          onClick={navigation.leave}
        >
          <span className="min-w-0">
            {discard ? (messages?.discardAction ?? m.thread_authoring_discard()) : m.thread_authoring_leave()}
          </span>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

/** An isolated composer gets the same native guard and decision UI; route siblings share their page owner. */
export function AuthoringDepartureBoundary({
  children,
  sessionBound = true,
  navigationMessages,
  navigationContext,
}: {
  children: ReactNode;
  sessionBound?: boolean;
  navigationMessages?: NavigationMessages;
  navigationContext?: NavigationContext;
}) {
  return useContext(DepartureContext) ? (
    children
  ) : (
    <AuthoringDepartureProvider
      sessionBound={sessionBound}
      {...(navigationContext ? { navigationContext } : {})}
      {...(navigationMessages ? { navigationMessages } : {})}
    >
      {children}
    </AuthoringDepartureProvider>
  );
}

type Protection = boolean | (() => boolean);
const protectedNow = (value: Protection) => (typeof value === 'function' ? value() : value);

export function useAuthoringDeparture(
  needsDecision: Protection,
  unresolved: Protection,
  signature: string,
  onDiscard?: () => void,
  onLeave?: () => void,
  kind?: DepartureKind,
  messages?: NavigationMessages,
  navigationContext?: NavigationContext,
) {
  const navigation = useContext(DepartureContext);
  const latest = useRef({ needsDecision, unresolved, signature, onDiscard, onLeave, kind, messages, released: false });
  if (latest.current.signature !== signature) latest.current.released = false;
  latest.current.needsDecision = needsDecision;
  latest.current.unresolved = unresolved;
  latest.current.signature = signature;
  latest.current.onDiscard = onDiscard;
  latest.current.onLeave = onLeave;
  latest.current.kind = kind;
  latest.current.messages = messages;
  const context = useRef(navigationContext);
  context.current = navigationContext;
  const needsProtection = protectedNow(needsDecision);
  const pending = protectedNow(unresolved);
  const registration = useRef<{ owner: AuthoringDepartureState; id: number; remove: () => void } | null>(null);

  useLayoutEffect(() => {
    if (!navigation) return;
    const registered = navigation.register({
      needsDecision: () => !latest.current.released && protectedNow(latest.current.needsDecision),
      unresolved: () => protectedNow(latest.current.unresolved),
      discard: () => latest.current.onDiscard?.(),
      messages: () => latest.current.messages,
      kind: latest.current.kind,
      get navigationContext() {
        return context.current;
      },
      leave: () => {
        latest.current.released = true;
        latest.current.onLeave?.();
      },
    });
    registration.current = { owner: navigation, ...registered };
    return () => {
      registration.current = null;
      registered.remove();
    };
  }, [navigation]);
  useLayoutEffect(() => navigation?.refresh(), [navigation, needsProtection, pending, signature]);

  const release = useCallback(() => {
    latest.current.released = true;
    navigation?.refresh();
  }, [navigation]);
  const requestDiscard = useCallback((fallback?: () => void) => {
    const current = registration.current;
    if (!current) {
      fallback?.();
      return;
    }
    current.owner.requestDiscard(
      current.id,
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
  }, []);
  const requestNavigation = useCallback(
    (proceed: () => void) => {
      if (!navigation) return proceed();
      navigation.requestNavigation(
        proceed,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      );
    },
    [navigation],
  );
  return { release, requestDiscard, requestNavigation, hasOwner: navigation !== null };
}
