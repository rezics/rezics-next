export type ConfiguredListRetryOwner = {
  routeKey: string;
  sessionKey: string | null;
  queryKey: string;
  isCurrent(): boolean;
  read(): Promise<unknown>;
};

export type ConfiguredListRetryIntent = { token: symbol; routeKey: string; sessionKey: string };

type Waiter = {
  intent: ConfiguredListRetryIntent;
  resolve: (owner: ConfiguredListRetryOwner | null) => void;
};

/** Keeps a deliberate retry attached to the selected list while session refresh replaces its incarnation. */
export function createConfiguredListRetryController() {
  let attached = false;
  let owner: ConfiguredListRetryOwner | null = null;
  let intent: ConfiguredListRetryIntent | null = null;
  let suppressedQueryKey: string | null = null;
  const waiters = new Set<Waiter>();

  function eligible(candidate: ConfiguredListRetryOwner, attempt: ConfiguredListRetryIntent) {
    return (
      attached &&
      intent === attempt &&
      candidate.routeKey === attempt.routeKey &&
      candidate.sessionKey === attempt.sessionKey &&
      candidate.isCurrent()
    );
  }

  function resolveWaiters() {
    for (const waiter of waiters) {
      if (!attached || intent !== waiter.intent) {
        waiters.delete(waiter);
        waiter.resolve(null);
      } else if (owner && eligible(owner, waiter.intent)) {
        waiters.delete(waiter);
        waiter.resolve(owner);
      }
    }
  }

  function retireIntent() {
    intent = null;
    resolveWaiters();
  }

  return {
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
      owner = null;
      suppressedQueryKey = null;
      retireIntent();
    },
    select(next: ConfiguredListRetryOwner | null) {
      owner = next;
      if (
        intent &&
        (!next || next.routeKey !== intent.routeKey || (next.sessionKey && next.sessionKey !== intent.sessionKey))
      )
        retireIntent();
      resolveWaiters();
    },
    begin() {
      if (!attached || intent || !owner || !owner.sessionKey || !owner.isCurrent()) return null;
      intent = {
        token: Symbol('configured-list-retry'),
        routeKey: owner.routeKey,
        sessionKey: owner.sessionKey,
      };
      suppressedQueryKey = owner.queryKey;
      return intent;
    },
    isCurrent(attempt: ConfiguredListRetryIntent) {
      return attached && intent === attempt;
    },
    waitForCurrentOwner(attempt: ConfiguredListRetryIntent) {
      if (!attached || intent !== attempt) return Promise.resolve(null);
      if (owner && eligible(owner, attempt)) return Promise.resolve(owner);
      return new Promise<ConfiguredListRetryOwner | null>((resolve) => waiters.add({ intent: attempt, resolve }));
    },
    markRead(attempt: ConfiguredListRetryIntent, selected: ConfiguredListRetryOwner) {
      if (!eligible(selected, attempt) || owner !== selected) return false;
      suppressedQueryKey = selected.queryKey;
      return true;
    },
    shouldSuppressAutomaticRead(queryKey: string) {
      return intent !== null || suppressedQueryKey === queryKey;
    },
    finish(attempt: ConfiguredListRetryIntent) {
      if (intent === attempt) retireIntent();
    },
  };
}
