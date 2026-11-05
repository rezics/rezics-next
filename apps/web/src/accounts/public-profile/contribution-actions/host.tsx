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
import { browserObservation } from '../../../session/observation';
import { normalizeSessionObservation, sessionQueryKey } from '../../../session/browser-state';
import { ContributionActionsAddress } from './current';
import type { BrowserObservationSnapshot } from '../../../session/observation';
import type { OperationLease } from '../../../reader/lease';
import type { ContributionOperation } from './current';
import type { SubjectPageData } from '../../../features/pages/subject';
import { isRecord } from '../../../features/pages/shared';
import {
  contributionActionsInput,
  ContributionActionsReceiver,
  unavailableAuthorContributionActionsWire,
  type AuthorContributionActionsWire,
  type ContributionActionsInput,
  type ContributionActionsState,
} from './receiver';

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

export function contributionPublicationSource(page: SubjectPageData, accountId: string): object | null {
  for (const result of Object.values(page.reads)) {
    if (result.status !== 200 || !isRecord(result.body)) continue;
    const accounts = result.body.accounts;
    if (!Array.isArray(accounts)) continue;
    const source = accounts.find((account) => isRecord(account) && account.id === accountId);
    if (source) return source;
  }
  return null;
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
  reader: BrowserObservationSnapshot;
  credential: string | null;
  navigation: object;
  mount: object | null;
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
    'reader',
    'credential',
    'navigation',
    'mount',
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
    left.rows.length !== right.rows.length
  )
    return false;
  return left.rows.every(
    (row, index) =>
      row.length === right.rows[index]?.length && row.every((value, i) => value === right.rows[index]?.[i]),
  );
}

export type ContributionActionsHostValue = {
  input: ContributionActionsInput | undefined;
  state: ContributionActionsState<unknown>;
  isCurrent: () => boolean;
  retry: () => Promise<void>;
  operation: (operation: ContributionOperation) => OperationLease<ContributionOperation> | undefined;
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
  episode: ContributionActionsEpisode | undefined;
  receiver?: ContributionActionsReceiver<unknown>;
  address?: ContributionActionsAddress;
  operations?: Partial<Record<ContributionOperation, OperationLease<ContributionOperation>>>;
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
  const observation = useMemo(() => browserObservation(client), [client]);
  const reader = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getServerSnapshot);
  const session = normalizeSessionObservation(client.getQueryData(sessionQueryKey));
  const [navigation, setNavigation] = useState({ active: true });
  const [mount, setMount] = useState<object | null>(null);
  const mounted = useRef<object | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const current = useRef<Visit | null>(null);
  const latest = useRef<ContributionActionsEpisode | null>(null);
  const bumpNavigation = useCallback((active: boolean) => {
    const next = { active };
    navigationRef.current = next;
    current.current?.address?.retire();
    current.current?.receiver?.retire();
    setNavigation(next);
  }, []);

  useClientLayoutEffect(() => {
    const token = {};
    mounted.current = token;
    setMount(token);
    return () => {
      mounted.current = null;
      current.current?.address?.retire();
      current.current?.receiver?.retire();
    };
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
  const signedIn = reader.state === 'signed-in';
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
    reader,
    credential: session.csrfToken,
    navigation,
    mount,
    wire,
    rows: observeContributionActionsRows(rows),
  };

  latest.current = episode;
  let visit = current.current;
  if (!visit?.episode || !sameContributionActionsEpisode(visit.episode, episode)) {
    visit?.address?.retireSilently();
    visit?.receiver?.retireSilently();
    if (visit) visit.episode = undefined;
    const next: Visit = { episode };
    const published = view === 'reviews' ? reviewsPublished : postsPublished;
    const readAdmitted = !!input && published && rows.length <= 20 && signedIn && navigation.active && mount !== null;
    if (readAdmitted) {
      const address = new ContributionActionsAddress(
        client,
        reader,
        () =>
          current.current === next &&
          mounted.current === episode.mount &&
          navigationRef.current === episode.navigation &&
          navigationRef.current.active &&
          !!latest.current &&
          sameContributionActionsEpisode(episode, latest.current) &&
          sameContributionActionsEpisode(episode, { ...episode, rows: observeContributionActionsRows(rows) }),
        () => {
          next.episode = undefined;
          next.receiver?.retire();
        },
      );
      next.address = address;
      next.receiver = new ContributionActionsReceiver(input!, wire, address.isCurrent);
    }
    current.current = next;
    visit = next;
  }

  const receiver = visit.receiver;
  const state = useSyncExternalStore(receiver?.subscribe ?? noSubscribe, receiver?.snapshot ?? noSnapshot, noSnapshot);
  useEffect(() => setHydrated(true), []);
  useClientLayoutEffect(() => visit.address?.attach(), [visit]);
  useEffect(() => {
    if (receiver?.isCurrent()) void receiver.refresh();
  }, [receiver]);

  const isCurrent = () => !!receiver && current.current === visit && receiver.isCurrent();
  const retry = () => (isCurrent() ? receiver!.refresh() : Promise.resolve());
  const operation = (name: ContributionOperation) => {
    if (!isCurrent()) return undefined;
    const currentLease = visit.operations?.[name];
    if (currentLease?.current()) return currentLease;
    const nextLease = visit.address?.operation(name);
    if (nextLease) (visit.operations ??= {})[name] = nextLease;
    return nextLease;
  };
  const hostValue: ContributionActionsHostValue = { input, state, isCurrent, retry, operation };
  const showReadStatus = hydrated && signedIn;
  const signInHref =
    hydrated && reader.state === 'signed-out'
      ? `/${encodeURIComponent(locale)}/auth/sign-in?return_to=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`
      : undefined;
  return (
    <ContributionActionsHostContext.Provider value={hostValue}>
      <div data-slot="contribution-actions-host" data-action-state={state.state} className="contents">
        {signInHref ? (
          <p className="text-sm">
            <a
              href={signInHref}
              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
            >
              {m.profile_contribution_actions_sign_in()}
            </a>
          </p>
        ) : null}
        {hydrated && (reader.state === 'unknown' || (showReadStatus && state.state === 'pending')) ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.profile_contribution_actions_preparing()}
          </p>
        ) : null}
        {showReadStatus && (state.state === 'failed' || state.state === 'unavailable') ? (
          <p role={state.state === 'failed' ? 'alert' : 'status'} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{m.profile_contribution_actions_unavailable()}</span>
            {state.state === 'failed' ? (
              <Button type="button" variant="outline" onClick={() => void retry()} disabled={!isCurrent()}>
                {m.public_account_retry()}
              </Button>
            ) : null}
          </p>
        ) : null}
        {showReadStatus && state.state === 'retired' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.profile_contribution_actions_retired()}
          </p>
        ) : null}
        {children}
      </div>
    </ContributionActionsHostContext.Provider>
  );
}
