import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { LibraryBigIcon } from 'lucide-react';
import { QueryClientContext } from '@tanstack/react-query';
import { browserObservation } from '../../../session/observation';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { createHomeWorkLibraryAdmission } from './admission';
import {
  homeWorkLibraryRow,
  isValidProjection,
  sameHomeWorkLibraryScope,
  homeWorkLibraryFeedProjection,
  type HomeNativePersonalPage,
  type HomeWorkLibraryLease,
  type HomeWorkLibraryProjection,
  type HomeWorkLibraryScope,
} from './contract';

type HomeWorkLibraryContextValue = { projection?: HomeWorkLibraryProjection; signedIn: boolean; enabled: boolean };
const HomeWorkLibraryContext = createContext<HomeWorkLibraryContextValue>({ signedIn: false, enabled: false });
const subscribeNothing = () => () => {};
const snapshotNothing = () => 0;
const readerNothing = () => undefined;

export function HomeWorkLibraryProvider({
  expectedScope,
  projection: explicitProjection,
  personal,
  feedLease,
  signedIn,
  enabled,
  children,
}: {
  expectedScope: HomeWorkLibraryScope;
  projection?: HomeWorkLibraryProjection;
  /** The installed feed page's personal facts, admitted only under this window's lease. */
  personal?: HomeNativePersonalPage;
  feedLease?: HomeWorkLibraryLease;
  signedIn: boolean;
  enabled: boolean;
  children: ReactNode;
}) {
  const derivedProjection = useMemo(
    () =>
      personal && feedLease && expectedScope.reader
        ? homeWorkLibraryFeedProjection({ native: personal, scope: expectedScope, lease: feedLease })
        : undefined,
    [personal, feedLease, expectedScope],
  );
  const projection = explicitProjection ?? derivedProjection;
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const lease = projection?.lease;
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => (client ? browserObservation(client) : undefined), [client]);
  const reading = useSyncExternalStore(
    observation?.subscribe ?? subscribeNothing,
    observation?.getSnapshot ?? readerNothing,
    observation?.getServerSnapshot ?? readerNothing,
  );
  const sourceKey = projection
    ? JSON.stringify([
        projection.scope.reader,
        projection.scope.credentialEpoch,
        projection.scope.source,
        projection.scope.observation,
        projection.scope.locale,
        projection.scope.route,
      ])
    : undefined;
  const admissions = useMemo(
    () => new WeakMap<NonNullable<typeof lease>, Map<string, ReturnType<typeof createHomeWorkLibraryAdmission>>>(),
    [observation],
  );
  const admission = useMemo(() => {
    if (!projection || sourceKey === undefined) return;
    let scopes = admissions.get(projection.lease);
    if (!scopes) {
      scopes = new Map();
      admissions.set(projection.lease, scopes);
    }
    let retained = scopes.get(sourceKey);
    if (!retained) {
      retained = createHomeWorkLibraryAdmission(projection, observation);
      scopes.set(sourceKey, retained);
    }
    return retained;
  }, [admissions, lease, sourceKey]);
  const previousAdmission = useRef(admission);
  if (previousAdmission.current !== admission) previousAdmission.current?.retire();
  previousAdmission.current = admission;
  if (
    hydrated &&
    projection &&
    (!enabled ||
      !signedIn ||
      !sameHomeWorkLibraryScope(expectedScope, projection.scope) ||
      !projection.lease.isCurrent())
  )
    admission?.retire();
  const subscribe = useMemo(
    () => (admission ? (listener: () => void) => admission.lease.subscribe(listener) : subscribeNothing),
    [admission],
  );
  const snapshot = useMemo(() => (lease ? () => lease.snapshot() : snapshotNothing), [lease]);
  const revision = useSyncExternalStore(subscribe, snapshot, snapshotNothing);
  const current =
    hydrated &&
    enabled &&
    signedIn &&
    projection &&
    admission?.lease.isCurrent() &&
    (!client || reading?.state === 'signed-in') &&
    revision >= 0 &&
    projection.lease.isCurrent() &&
    sameHomeWorkLibraryScope(expectedScope, projection.scope) &&
    isValidProjection(projection)
      ? { ...projection, lease: admission.lease }
      : undefined;
  return (
    <HomeWorkLibraryContext.Provider value={{ ...(current ? { projection: current } : {}), signedIn, enabled }}>
      {children}
    </HomeWorkLibraryContext.Provider>
  );
}

/** One existing Library destination plus only controls backed by a current, admitted work row. */
export function HomeWorkLibraryAction({
  rowKey,
  subjectId,
  href,
  locale,
  signedIn: signedInProp,
}: {
  /** Omitted for catalogue navigation: a Subject ID never substitutes for a native occurrence. */
  rowKey?: string;
  subjectId: string;
  href: string;
  locale: string;
  signedIn?: boolean;
}) {
  const context = useContext(HomeWorkLibraryContext);
  const projection = context.projection;
  const signedIn = signedInProp ?? context.signedIn;
  const row = signedIn ? homeWorkLibraryRow(projection, rowKey, subjectId) : undefined;
  const options = { locale: locale as Locale };
  const signIn = `/${encodeURIComponent(locale)}/auth/sign-in?return_to=${encodeURIComponent(href)}`;
  const entry =
    row?.entry.state === 'present'
      ? `${m.library_subject_entry({}, options)}: ${m.library_other({}, options)}`
      : row?.entry.state === 'absent'
        ? m.library_empty_title({}, options)
        : null;
  const score =
    row?.score.state === 'present' && row.score.value.kind === 'ready'
      ? row.score.value.units === null
        ? m.subject_rating_control_unrated({}, options)
        : `${new Intl.NumberFormat(locale).format(row.score.value.units / 2)} / 10`
      : row?.score.state === 'absent'
        ? m.subject_rating_control_unrated({}, options)
        : null;
  const entryUnavailable = signedIn && entry === null;
  const scoreUnavailable = signedIn && score === null;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" data-slot="home-work-library-action">
      {entry !== null ? (
        <span className="text-xs" data-slot="home-work-library-entry">
          {entry}
        </span>
      ) : null}
      {entryUnavailable ? (
        <span
          className="text-xs text-muted-foreground"
          role="status"
          aria-label={m.library_rich_entry_unavailable({}, options)}
          data-slot="home-work-library-entry-unavailable"
        >
          {m.library_subject_unavailable({}, options)}
        </span>
      ) : null}
      {score !== null ? (
        <span
          className="text-xs"
          aria-label={m.subject_rating_control_label({}, options)}
          data-slot="home-work-library-score"
        >
          {score}
        </span>
      ) : null}
      {scoreUnavailable ? (
        <span
          className="text-xs text-muted-foreground"
          role="status"
          aria-label={m.library_my_ratings_unavailable({}, options)}
          data-slot="home-work-library-score-unavailable"
        >
          {m.library_subject_unavailable({}, options)}
        </span>
      ) : null}
      {signedIn && row?.actions.state === 'unavailable' ? (
        <span role="status" className="text-xs text-muted-foreground" data-slot="home-work-library-actions-unavailable">
          {m.feed_action_unavailable({}, options)}
        </span>
      ) : null}
      <a
        href={signedIn ? href : signIn}
        className="inline-flex min-h-11 min-w-11 max-w-full items-center gap-1 rounded-sm px-2 py-2 text-sm font-medium whitespace-normal text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        data-slot="feed-library-action"
      >
        <LibraryBigIcon aria-hidden />
        {m.feed_action_library({}, options)}
      </a>
    </div>
  );
}

export function useHomeWorkLibraryEnabled() {
  return useContext(HomeWorkLibraryContext).enabled;
}
