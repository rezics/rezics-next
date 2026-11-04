import { Button } from '@rezics/ui/shadcn/button';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import type { PageRead } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { sessionQuery } from '../../../session/query';
import type { SubjectPageData } from '../../../features/pages/subject';
import {
  contributionActionsInput,
  ContributionActionsReceiver,
  unavailableAuthorContributionActionsWire,
  type AuthorContributionActionsWire,
  type ContributionActionsInput,
  type ContributionActionsState,
} from './receiver';

type BrowserSession = {
  state?: string;
  subject?: string | null;
  csrfToken?: string | null;
};

type SessionAuthority = {
  status: string;
  state: string;
  subject: string | null;
  csrfToken: string | null;
};

type SessionObservation = {
  subscribe: (notify: () => void) => () => void;
  snapshot: () => number;
  read: () => SessionAuthority;
};

/** Observe only the existing one-segment session entry; a successful replacement is a new episode. */
export function observeContributionActionsSession(client: QueryClient): SessionObservation {
  let revision = 0;
  const key = sessionQuery.queryKey;
  return {
    subscribe(notify) {
      return client.getQueryCache().subscribe((event) => {
        const query = 'query' in event ? event.query : undefined;
        if (
          !query ||
          query.queryKey.length !== key.length ||
          query.queryKey.some((part: unknown, index: number) => part !== key[index])
        )
          return;
        const replaced =
          event.type === 'added' ||
          event.type === 'removed' ||
          (event.type === 'updated' &&
            (event.action.type === 'success' || event.action.type === 'setState' || event.action.type === 'error'));
        if (!replaced) return;
        revision++;
        notify();
      });
    },
    snapshot: () => revision,
    read() {
      const query = client.getQueryState(key);
      const session = client.getQueryData<BrowserSession>(key);
      return {
        status: query?.status ?? 'missing',
        state: session?.state ?? 'unknown',
        subject: typeof session?.subject === 'string' ? session.subject : null,
        csrfToken: typeof session?.csrfToken === 'string' ? session.csrfToken : null,
      };
    },
  };
}

export type ContributionActionsPageScopeValue = {
  page: SubjectPageData;
  cursor: string | null;
  view: string;
};

const ContributionActionsPageScopeContext = createContext<ContributionActionsPageScopeValue | null>(null);

export function ContributionActionsPageScope({
  page,
  cursor,
  view,
  children,
}: ContributionActionsPageScopeValue & { children: ReactNode }) {
  return (
    <ContributionActionsPageScopeContext.Provider value={{ page, cursor, view }}>
      {children}
    </ContributionActionsPageScopeContext.Provider>
  );
}

export function useContributionActionsPageScope() {
  return useContext(ContributionActionsPageScopeContext);
}

type RowObservation = readonly unknown[];

export function observeContributionActionsRows(rows: readonly Record<string, unknown>[]): RowObservation[] {
  return rows.map((row) => [
    row,
    row.id,
    row.kind,
    row.threadId,
    row.parentId,
    row.placeId,
    row.sourceRevisionId,
    row.threadRevisionId,
    row.revisionId,
    row.authorId,
    row.availability,
    row.visibility,
    row.thread,
    row.firstPost,
    row.parentContext,
    row.reviewContext,
  ]);
}

export type ContributionActionsEpisode = {
  client: QueryClient;
  accountId: string;
  view: ContributionActionsInput['view'];
  cursor: string | null;
  locale: string;
  page: object | null;
  read: object;
  source: object;
  selection: unknown;
  publication: object | null;
  postsPublished: boolean;
  reviewsPublished: boolean;
  sessionRevision: number;
  session: SessionAuthority;
  navigationRevision: number;
  wire: AuthorContributionActionsWire<unknown>;
  rows: RowObservation[];
};

/** Rows and their immediate native contexts are observed only for retirement, never input derivation. */
export function sameContributionActionsEpisode(left: ContributionActionsEpisode, right: ContributionActionsEpisode) {
  const scalarKeys = [
    'accountId',
    'view',
    'cursor',
    'locale',
    'postsPublished',
    'reviewsPublished',
    'sessionRevision',
    'navigationRevision',
  ] as const;
  if (scalarKeys.some((key) => left[key] !== right[key])) return false;
  if (
    left.client !== right.client ||
    left.page !== right.page ||
    left.read !== right.read ||
    left.source !== right.source ||
    left.selection !== right.selection ||
    left.publication !== right.publication ||
    left.wire !== right.wire ||
    left.session.status !== right.session.status ||
    left.session.state !== right.session.state ||
    left.session.subject !== right.session.subject ||
    left.session.csrfToken !== right.session.csrfToken ||
    left.rows.length !== right.rows.length
  )
    return false;
  return left.rows.every((row, index) => row.length === right.rows[index]?.length && row.every((value, i) => value === right.rows[index]?.[i]));
}

export type ContributionActionsHostValue = {
  input: ContributionActionsInput | undefined;
  state: ContributionActionsState<unknown>;
  isCurrent: () => boolean;
  retry: () => Promise<void>;
};

const ContributionActionsHostContext = createContext<ContributionActionsHostValue | null>(null);

export function useContributionActionsHost() {
  return useContext(ContributionActionsHostContext);
}

const unavailable: ContributionActionsState<unknown> = { state: 'unavailable' };
const noSubscribe = (_notify: () => void) => () => {};
const noSnapshot = () => unavailable;
const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

type Visit = {
  episode: ContributionActionsEpisode;
  receiver?: ContributionActionsReceiver<unknown>;
};

export function ContributionActionsHost({
  accountId,
  view,
  cursor,
  locale,
  page,
  read,
  source,
  selection,
  publication,
  postsPublished,
  reviewsPublished,
  rows,
  wire = unavailableAuthorContributionActionsWire,
  children,
}: {
  accountId: string;
  view: ContributionActionsInput['view'];
  cursor: string | null;
  locale: string;
  page: object | null;
  read: PageRead | object;
  source: Record<string, unknown>;
  selection: unknown;
  publication: object | null;
  postsPublished: boolean;
  reviewsPublished: boolean;
  rows: readonly Record<string, unknown>[];
  wire?: AuthorContributionActionsWire<unknown>;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const observation = useMemo(() => observeContributionActionsSession(client), [client]);
  const sessionRevision = useSyncExternalStore(observation.subscribe, observation.snapshot, () => 0);
  const session = observation.read();
  const [navigation, setNavigation] = useState({ revision: 0, active: true });
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const current = useRef<Visit | null>(null);
  const effectGeneration = useRef(0);
  const bumpNavigation = useCallback((active: boolean) => {
    const next = { revision: navigationRef.current.revision + 1, active };
    navigationRef.current = next;
    current.current?.receiver?.retire();
    setNavigation(next);
  }, []);

  useClientLayoutEffect(() => {
    const leave = router.subscribe('onBeforeNavigate', () => bumpNavigation(false));
    const load = router.subscribe('onBeforeLoad', () => bumpNavigation(false));
    const resolved = router.subscribe('onResolved', () => bumpNavigation(true));
    const hide = () => bumpNavigation(false);
    const show = () => bumpNavigation(true);
    const visibility = () => bumpNavigation(document.visibilityState !== 'hidden');
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    window.addEventListener('popstate', hide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      leave();
      load();
      resolved();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('popstate', hide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [bumpNavigation, router]);

  const input = contributionActionsInput(accountId, view, cursor, selection);
  const hasCredential =
    typeof window !== 'undefined' &&
    session.status === 'success' &&
    session.state === 'signed-in' &&
    !!session.subject &&
    !!session.csrfToken;
  const episode: ContributionActionsEpisode = {
    client,
    accountId,
    view,
    cursor,
    locale,
    page,
    read,
    source,
    selection,
    publication,
    postsPublished,
    reviewsPublished,
    sessionRevision,
    session,
    navigationRevision: navigation.revision,
    wire,
    rows: observeContributionActionsRows(rows),
  };

  let visit = current.current;
  if (!visit || !sameContributionActionsEpisode(visit.episode, episode)) {
    visit?.receiver?.retireSilently();
    const next: Visit = { episode };
    const readAdmitted = !!input && hasCredential && navigation.active;
    if (readAdmitted) {
      next.receiver = new ContributionActionsReceiver(input!, wire, () => {
        const active = navigationRef.current;
        return (
          current.current === next &&
          active.active &&
          active.revision === episode.navigationRevision &&
          observation.snapshot() === episode.sessionRevision
        );
      });
    }
    current.current = next;
    visit = next;
  }

  const receiver = visit.receiver;
  const state = useSyncExternalStore(receiver?.subscribe ?? noSubscribe, receiver?.snapshot ?? noSnapshot, noSnapshot);
  useEffect(() => {
    effectGeneration.current++;
    if (current.current === null) current.current = visit;
    if (receiver && receiver.isCurrent()) void receiver.refresh();
    return () => {
      if (current.current === visit) current.current = null;
      const retirement = ++effectGeneration.current;
      queueMicrotask(() => {
        if (effectGeneration.current === retirement && current.current !== visit) receiver?.retire();
      });
    };
  }, [receiver, visit]);

  const isCurrent = () => !!receiver && current.current === visit && receiver.isCurrent();
  const retry = () => (isCurrent() ? receiver!.refresh() : Promise.resolve());
  const hostValue: ContributionActionsHostValue = { input, state, isCurrent, retry };
  const showReadStatus = !!input && hasCredential;
  return (
    <ContributionActionsHostContext.Provider value={hostValue}>
      <div data-slot="contribution-actions-host" data-action-state={state.state} className="contents">
        {showReadStatus && state.state === 'pending' ? (
          <p role="status" className="sr-only">
            {m.public_account_preparing()}
          </p>
        ) : null}
        {showReadStatus && (state.state === 'failed' || state.state === 'unavailable') ? (
          <p role={state.state === 'failed' ? 'alert' : 'status'} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{m.public_account_unavailable()}</span>
            {state.state === 'failed' ? (
              <Button type="button" variant="outline" onClick={() => void retry()} disabled={!isCurrent()}>
                {m.public_account_retry()}
              </Button>
            ) : null}
          </p>
        ) : null}
        {children}
      </div>
    </ContributionActionsHostContext.Provider>
  );
}
