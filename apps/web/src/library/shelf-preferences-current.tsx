import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { browserObservation, type BrowserObservationSnapshot } from '../session/observation';
import { useSession } from '../session/query';
import { SessionUnavailablePrompt } from '../session/private-page';
import type { ShelfPreferenceSnapshot } from '../settings/shelf-preferences-current';
import type { ShelfPreferences } from '../settings/preferences';
import { resolveShelfPresentation, type ShelfPresentationResolution } from './shelf-preferences';
import { EntriesWindowNavigation } from './entries-window-navigation';
import { PersonalLibraryCurrent } from './personal-library-current';
import { CurrentLabelShelf } from './label-shelf-current';
import type { PersonalLibraryCurrentRead } from './personal-library-server';
import type { CurrentLabelShelfData } from './label-shelf-read';
import { ShelfAddressRecovery, ShelfStaleCursorRecovery, shelfPageResetCursor } from './shelf-address-recovery';
import { validateShelfSearch } from './shelf-params';
import type { ShelfAddressField } from './shelf-params';

type CurrentViewer = ReturnType<typeof useSession>;

type BoundSnapshot = {
  readerId: number;
  accountId: string;
  csrfToken: string;
  generation: string;
};

type GenerationRecord = { readerId: number; retired: boolean };
const snapshotGenerations = new WeakMap<QueryClient, Map<string, GenerationRecord>>();

function generationRegistry(client: QueryClient): Map<string, GenerationRecord> {
  let registry = snapshotGenerations.get(client);
  if (!registry) {
    registry = new Map();
    snapshotGenerations.set(client, registry);
  }
  return registry;
}

/** One mounted Library visit may use snapshots from its current shared reader incarnation. */
export class LibraryShelfPreferenceVisit {
  private bound: BoundSnapshot | undefined;
  private observedReaderId: number | undefined;
  private retired = false;

  constructor(private readonly generations = new Map<string, GenerationRecord>()) {}

  retire() {
    this.retired = true;
    for (const generation of this.generations.keys()) {
      const record = this.generations.get(generation);
      if (record) record.retired = true;
    }
  }

  private reject(snapshot?: ShelfPreferenceSnapshot) {
    if (snapshot && !this.generations.has(snapshot.generation))
      this.generations.set(snapshot.generation, { readerId: this.bound?.readerId ?? -1, retired: true });
    this.retire();
    return {};
  }

  resolve(
    snapshot: ShelfPreferenceSnapshot | undefined,
    viewer: CurrentViewer,
    observation: BrowserObservationSnapshot,
    unavailable = false,
  ): ShelfPreferences {
    if (unavailable) this.retire();
    if (this.retired) return {};

    if (observation.state !== 'signed-in') {
      if (this.bound || this.observedReaderId !== undefined || observation.state === 'signed-out') this.retire();
      return {};
    }

    const readerId = observation.observation.id;
    if (this.observedReaderId !== undefined && this.observedReaderId !== readerId) {
      this.retire();
      return {};
    }
    this.observedReaderId = readerId;
    const viewerMatches =
      viewer.state === 'signed-in' &&
      viewer.subject === observation.observation.subject &&
      typeof viewer.csrfToken === 'string';
    if (!viewerMatches) {
      return this.bound || snapshot ? this.reject(snapshot) : {};
    }

    const accountId = viewer.subject!;
    const csrfToken = viewer.csrfToken!;
    if (this.bound && this.bound.readerId !== readerId) {
      return this.reject(snapshot);
    }

    if (!snapshot) return {};
    if (snapshot.accountId !== accountId || snapshot.csrfToken !== csrfToken) {
      return this.reject(snapshot);
    }

    if (!this.bound) {
      const record = this.generations.get(snapshot.generation);
      if (record && (record.retired || record.readerId !== readerId)) return this.reject(snapshot);
      this.bound = { readerId, accountId, csrfToken, generation: snapshot.generation };
      this.generations.set(snapshot.generation, { readerId, retired: false });
      return snapshot.shelf ?? {};
    }

    if (this.bound.accountId !== accountId || this.bound.csrfToken !== csrfToken) {
      return this.reject(snapshot);
    }

    if (snapshot.generation !== this.bound.generation) {
      const previous = this.generations.get(this.bound.generation);
      if (previous) previous.retired = true;
      const record = this.generations.get(snapshot.generation);
      if (record && (record.retired || record.readerId !== readerId)) return this.reject(snapshot);
    }

    // A new loader read can refresh the snapshot while this visit remains on the same reader.
    this.bound = { readerId, accountId, csrfToken, generation: snapshot.generation };
    this.generations.set(snapshot.generation, { readerId, retired: false });
    return snapshot.shelf ?? {};
  }
}

/** Retiring shared observation and session hooks stay mounted through every route variant. */
export function LibraryShelfPreferenceBoundary({
  snapshot,
  unavailable = false,
  children,
}: {
  snapshot?: ShelfPreferenceSnapshot;
  unavailable?: boolean;
  children: (shelf: ShelfPreferences) => ReactNode;
}) {
  const client = useQueryClient();
  const observation = browserObservation(client);
  const reader = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getServerSnapshot);
  const viewer = useSession();
  const visit = useRef<LibraryShelfPreferenceVisit | null>(null);
  visit.current ??= new LibraryShelfPreferenceVisit(generationRegistry(client));
  useEffect(() => () => visit.current?.retire(), []);
  return children(visit.current.resolve(snapshot, viewer, reader, unavailable));
}

type LibraryPresentationData =
  | { sessionUnavailable: true }
  | { addressRecovery: ShelfAddressField[] }
  | (PersonalLibraryCurrentRead & { shelfSnapshot?: ShelfPreferenceSnapshot })
  | (CurrentLabelShelfData & { shelfSnapshot?: ShelfPreferenceSnapshot });

type LabelReader = NonNullable<ComponentProps<typeof CurrentLabelShelf>['read']>;

function isLibrarySessionUnavailable(data: LibraryPresentationData): data is { sessionUnavailable: true } {
  return 'sessionUnavailable' in data && data.sessionUnavailable === true;
}

/** The route's shared admission, saved-view resolution and current/recovery child boundary. */
export function LibraryPresentationBoundary({
  data,
  rawSearch,
  locale,
  readLabel,
  renderCurrent,
}: {
  data: LibraryPresentationData;
  rawSearch: Record<string, unknown>;
  locale: string;
  readLabel: LabelReader;
  renderCurrent?: (model: { shelf: ShelfPreferences; presentation: ShelfPresentationResolution }) => ReactNode;
}) {
  const windows = useRef(new EntriesWindowNavigation()).current;
  useEffect(() => () => windows.leave(), [windows]);
  const unavailable = isLibrarySessionUnavailable(data);
  if (unavailable || 'addressRecovery' in data || !('page' in data)) windows.leave();
  const snapshot = 'shelfSnapshot' in data ? data.shelfSnapshot : undefined;
  return (
    <LibraryShelfPreferenceBoundary {...(snapshot ? { snapshot } : {})} unavailable={unavailable}>
      {(shelf) => {
        if (isLibrarySessionUnavailable(data)) return <SessionUnavailablePrompt />;
        if ('addressRecovery' in data)
          return <ShelfAddressRecovery locale={locale} search={rawSearch} issues={data.addressRecovery} />;

        const search = validateShelfSearch(rawSearch);
        const presentation: ShelfPresentationResolution = resolveShelfPresentation(search, shelf);
        if (!('page' in data))
          return (
            <>
              {search.cursor && shelfPageResetCursor(data) ? (
                <ShelfStaleCursorRecovery locale={locale} search={rawSearch} />
              ) : null}
              <CurrentLabelShelf
                initial={data}
                locale={locale}
                display={presentation.display}
                presentation={presentation}
                read={readLabel}
              />
            </>
          );
        const current = renderCurrent ? (
          renderCurrent({ shelf, presentation })
        ) : (
          <PersonalLibraryCurrent
            windows={windows}
            initial={data}
            search={presentation.search}
            locale={locale}
            display={presentation.display}
            presentation={presentation}
          />
        );
        return (
          <>
            {presentation.cursorInvalidated || (search.cursor && shelfPageResetCursor(data)) ? (
              <ShelfStaleCursorRecovery locale={locale} search={rawSearch} />
            ) : null}
            {current}
          </>
        );
      }}
    </LibraryShelfPreferenceBoundary>
  );
}
