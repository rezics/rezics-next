import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { LibraryBigIcon } from 'lucide-react';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import {
  homeWorkLibraryRow,
  isValidProjection,
  sameHomeWorkLibraryScope,
  type HomeWorkLibraryProjection,
  type HomeWorkLibraryScope,
} from './contract';

type HomeWorkLibraryContextValue = { projection?: HomeWorkLibraryProjection; signedIn: boolean; enabled: boolean };
const HomeWorkLibraryContext = createContext<HomeWorkLibraryContextValue>({ signedIn: false, enabled: false });
const subscribeNothing = () => () => {};
const snapshotNothing = () => 0;

export function HomeWorkLibraryProvider({
  expectedScope,
  projection,
  signedIn,
  enabled,
  children,
}: {
  expectedScope: HomeWorkLibraryScope;
  projection?: HomeWorkLibraryProjection;
  signedIn: boolean;
  enabled: boolean;
  children: ReactNode;
}) {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const lease = projection?.lease;
  const subscribe = useMemo(
    () => (lease ? (listener: () => void) => lease.subscribe(listener) : subscribeNothing),
    [lease],
  );
  const snapshot = useMemo(() => (lease ? () => lease.snapshot() : snapshotNothing), [lease]);
  const revision = useSyncExternalStore(
    subscribe,
    snapshot,
    snapshotNothing,
  );
  const current =
    hydrated &&
    projection &&
    revision >= 0 &&
    projection.lease.isCurrent() &&
    sameHomeWorkLibraryScope(expectedScope, projection.scope) &&
    isValidProjection(projection)
      ? projection
      : undefined;
  return (
    <HomeWorkLibraryContext.Provider value={{ ...(current ? { projection: current } : {}), signedIn, enabled }}>
      {children}
    </HomeWorkLibraryContext.Provider>
  );
}

/** One existing Library destination plus only controls backed by a current, admitted work row. */
export function HomeWorkLibraryAction({
  subjectId,
  href,
  locale,
  signedIn: signedInProp,
}: {
  subjectId: string;
  href: string;
  locale: string;
  signedIn?: boolean;
}) {
  const context = useContext(HomeWorkLibraryContext);
  const projection = context.projection;
  const signedIn = signedInProp ?? context.signedIn;
  const row = homeWorkLibraryRow(projection, subjectId);
  const options = { locale: locale as Locale };
  const signIn = `/${encodeURIComponent(locale)}/auth/sign-in?return_to=${encodeURIComponent(href)}`;
  const entry = row?.entry.state !== 'unavailable' && row?.entryControl ? row.entryControl(row.entry) : null;
  const score = row?.score.state !== 'unavailable' && row?.scoreControl ? row.scoreControl(row.score) : null;
  const entryUnavailable = signedIn && entry === null;
  const scoreUnavailable = signedIn && score === null;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" data-slot="home-work-library-action">
      {signedIn && entry !== null ? entry : null}
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
      {signedIn && score !== null ? score : null}
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
