import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { isView } from '@rezics/composition';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';
import { subjectViewHref } from '../../subject/subject-href';
import { sessionQuery } from '../../session/query';
import { CoverList } from './cover-list';
import {
  holderItems,
  pageRepresentation,
  statementItems,
  type Item,
  type OverviewValue,
  type Section,
} from './overview';
import { loadRelationGroup, relationGroupKey, type RelationGroupRequest } from './relation-stream-query';
import {
  advanceRelationProgress,
  relationCursor,
  relationFailureStatus,
  startRelationProgress,
  type RelationProgress,
} from './relation-stream-progress';
import { StreamHeading, type StreamHeadingLevel } from './view-heading';

let nextRelationIncarnation = 0;
let nextSectionIncarnation = 0;
let nextQueryClientIncarnation = 0;
const sectionIncarnations = new WeakMap<object, number>();
const queryClientIncarnations = new WeakMap<QueryClient, number>();
// Closing blocks new owners. Existing owners keep their weakly recorded lease, including StrictMode resumption.
const privateReadingOwners = new WeakMap<object, WeakSet<object>>();
const closedPrivateReadingObjects = new WeakSet<object>();

type OwnedQuery = { client: QueryClient; key: QueryKey };
type StreamOwner = {
  queryClient: QueryClient;
  expectedReader: string | null;
  sessionQuery: object | null;
  suspendedSessionState: object | null;
  readingObjects: object[];
  generation: number;
  mounted: boolean;
  suspended: boolean;
  retired: boolean;
  queries: Map<string, OwnedQuery>;
  stopObserving: (() => void) | undefined;
  matches(generation: number): boolean;
  current(generation: number): boolean;
  retire(updateState?: boolean): void;
};

function queryClientIncarnation(client: QueryClient): number {
  let incarnation = queryClientIncarnations.get(client);
  if (incarnation === undefined) {
    incarnation = ++nextQueryClientIncarnation;
    queryClientIncarnations.set(client, incarnation);
  }
  return incarnation;
}

function sessionReading(client: QueryClient, expectedReader: string) {
  const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  const data: unknown = query?.state.data;
  const session = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
  return {
    query: query ?? null,
    state: query?.state ?? null,
    admitted: query?.state.status === 'success' && session?.state === 'signed-in' && session.subject === expectedReader,
  };
}

function sameSessionKey(key: QueryKey): boolean {
  return (
    key.length === sessionQuery.queryKey.length &&
    key.every((part: unknown, index: number) => part === sessionQuery.queryKey[index])
  );
}

function privateReadingObjects(section: Section): object[] {
  const objects: object[] = [section];
  if (!section.ok) return objects;
  objects.push(section.body);
  for (const key of ['links', 'relations']) {
    const rows = section.body[key];
    if (!Array.isArray(rows)) continue;
    objects.push(rows);
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      objects.push(row);
      for (const nested of ['statement', 'summary', 'related']) {
        const value = (row as Record<string, unknown>)[nested];
        if (typeof value === 'object' && value !== null) objects.push(value);
      }
    }
  }
  return objects;
}

function ownerHasPrivateReading(owner: object, readingObject: object): boolean {
  return privateReadingOwners.get(readingObject)?.has(owner) ?? false;
}

function canOwnPrivateReading(readingObjects: object[], owner: object): boolean {
  return readingObjects.every(
    (readingObject) => !closedPrivateReadingObjects.has(readingObject) || ownerHasPrivateReading(owner, readingObject),
  );
}

function claimPrivateReading(readingObjects: object[], owner: object): boolean {
  if (!canOwnPrivateReading(readingObjects, owner)) return false;
  for (const readingObject of readingObjects) {
    let owners = privateReadingOwners.get(readingObject);
    if (!owners) {
      owners = new WeakSet();
      privateReadingOwners.set(readingObject, owners);
    }
    owners.add(owner);
  }
  return true;
}

function closePrivateReading(readingObjects: object[]): void {
  for (const readingObject of readingObjects) closedPrivateReadingObjects.add(readingObject);
}

function clearOwnedQueries(owner: StreamOwner): void {
  const queries = [...owner.queries.values()];
  owner.queries.clear();
  for (const { client, key } of queries) {
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  }
}

function sectionIncarnation(section: Section): number {
  let incarnation = sectionIncarnations.get(section);
  if (incarnation === undefined) {
    incarnation = ++nextSectionIncarnation;
    sectionIncarnations.set(section, incarnation);
  }
  return incarnation;
}

function useRelationIncarnation(): string {
  const [incarnation] = useState(() => `relations-${++nextRelationIncarnation}`);
  return incarnation;
}

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function failure(status: number | undefined, locale: string): string {
  const options = { locale: locale as never };
  return status === 409
    ? m.subject_relation_changed({}, options)
    : status === 400 || status === 422
      ? m.subject_relation_invalid({}, options)
      : status === 401 || status === 403 || status === 404
        ? m.subject_relation_unavailable({}, options)
        : m.subject_section_failed({}, options);
}

export function relationStreamItems(section: Section, value: OverviewValue, limit = Number.POSITIVE_INFINITY) {
  if (!section.ok) return;
  return section.read.kind === 'links'
    ? holderItems(section.body, limit, value.locale, value.reader.spoilerLevel)
    : statementItems(section, section.read.kind === 'relations' ? section.read.property : undefined, limit, value);
}

function windowItems(section: Section | undefined, value: OverviewValue): Item[] {
  const unique = new Map<string, Item>();
  for (const item of section ? (relationStreamItems(section, value)?.items ?? []) : []) {
    const identity = item.statement ?? item.id;
    if (!unique.has(identity)) unique.set(identity, item);
  }
  return [...unique.values()];
}

/** Independent state per current subject, Context and node; a More click requests just that stream. */
export function RelationStream(props: {
  value: OverviewValue;
  section: Section;
  node: string;
  view: string;
  title: string;
  titleLang?: string | undefined;
  /** Direct full-page hosts may select h1; composed hosts supply the shared heading context. */
  headingLevel?: StreamHeadingLevel | undefined;
}) {
  const { value, node, view } = props;
  const queryClient = useQueryClient();
  const routeHref = useRouterState({ select: (state) => state.location.href });
  const representation = pageRepresentation(value.context);
  const identity = JSON.stringify([
    value.subject,
    value.pageTarget,
    value.account ?? null,
    value.realm,
    value.cacheReader ?? null,
    representation,
    value.locale,
    value.reader,
    node,
    view,
    sectionIncarnation(props.section),
    routeHref,
    queryClientIncarnation(queryClient),
  ]);
  const control = useRef<{ identity: string; retire?: ((updateState?: boolean) => void) | undefined } | null>(null);
  if (control.current?.identity !== identity) {
    control.current?.retire?.(false);
    control.current = { identity };
  }
  const registerOwner = useMemo(
    () => (ownerIdentity: string, retire: (updateState?: boolean) => void) => {
      const current = control.current;
      if (current?.identity === ownerIdentity) current.retire = retire;
      return () => {
        const latest = control.current;
        if (latest?.identity === ownerIdentity && latest.retire === retire) latest.retire = undefined;
      };
    },
    [],
  );
  return <StreamState key={identity} identity={identity} registerOwner={registerOwner} {...props} />;
}

function StreamState({
  value,
  section,
  node,
  view,
  title,
  titleLang,
  headingLevel,
  identity,
  registerOwner,
}: {
  value: OverviewValue;
  section: Section;
  node: string;
  view: string;
  title: string;
  titleLang?: string | undefined;
  headingLevel?: StreamHeadingLevel | undefined;
  identity: string;
  registerOwner: (identity: string, retire: (updateState?: boolean) => void) => () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter({ warn: false });
  type State = {
    page: Section | undefined;
    progress: RelationProgress;
    pending: boolean;
    error?: { status?: number | undefined } | undefined;
    completion?: { count: number; terminal: boolean; trigger: HTMLAnchorElement | null } | undefined;
  };
  const [state, setState] = useState<State>(() => ({
    page: section,
    progress: startRelationProgress(section.ok ? relationCursor(section.body) : undefined),
    pending: false,
  }));
  const [, refreshOwner] = useState(0);
  const { page, progress, pending, error, completion } = state;
  const end = useRef<HTMLParagraphElement>(null);
  const active = useRef(false);
  const incarnation = useRelationIncarnation();
  const ownerRef = useRef<StreamOwner | null>(null);
  if (ownerRef.current === null) {
    const expectedReader = value.cacheReader ?? null;
    const reading = expectedReader === null ? undefined : sessionReading(queryClient, expectedReader);
    const readingObjects = expectedReader === null ? [] : privateReadingObjects(section);
    const owner = {
      queryClient,
      expectedReader,
      sessionQuery: reading?.query ?? null,
      suspendedSessionState: null,
      readingObjects,
      generation: 0,
      mounted: false,
      suspended: false,
      retired: false,
      queries: new Map<string, OwnedQuery>(),
      stopObserving: undefined,
    } as StreamOwner;
    const unavailable =
      expectedReader !== null &&
      (!canOwnPrivateReading(readingObjects, owner) || !reading?.admitted || reading?.query == null);
    if (unavailable && expectedReader !== null) {
      owner.retired = true;
      closePrivateReading(readingObjects);
    }
    owner.matches = (generation) =>
      !owner.retired && !owner.suspended && owner.mounted && owner.generation === generation;
    owner.current = (generation) => {
      if (!owner.matches(generation)) return false;
      if (owner.expectedReader !== null) {
        const current = sessionReading(owner.queryClient, owner.expectedReader);
        if (current.query !== owner.sessionQuery || !current.admitted) {
          owner.retire();
          return false;
        }
      }
      return true;
    };
    owner.retire = (updateState = true) => {
      if (owner.retired) return;
      owner.retired = true;
      owner.generation += 1;
      active.current = false;
      if (owner.expectedReader !== null) closePrivateReading(owner.readingObjects);
      owner.stopObserving?.();
      owner.stopObserving = undefined;
      clearOwnedQueries(owner);
      if (updateState) {
        setState((previous) => ({
          ...previous,
          page: undefined,
          progress: startRelationProgress(undefined),
          pending: false,
          error: undefined,
          completion: undefined,
        }));
        refreshOwner((version) => version + 1);
      }
    };
    ownerRef.current = owner;
  }
  const owner = ownerRef.current;
  const readingGeneration = owner.generation;
  const actualReading =
    owner.expectedReader === null ? undefined : sessionReading(owner.queryClient, owner.expectedReader);
  const currentSession =
    owner.expectedReader === null ||
    (!owner.retired &&
      !owner.suspended &&
      actualReading?.query === owner.sessionQuery &&
      actualReading?.admitted === true);
  const readerUnavailable = owner.expectedReader !== null && !currentSession;
  const visiblePage = currentSession ? page : undefined;
  const stopped = currentSession ? progress.stopped : undefined;
  const visiblePending = currentSession && pending;
  const visibleError = currentSession ? error : undefined;
  const visibleCompletion = currentSession ? completion : undefined;

  useLayoutEffect(() => {
    if (owner.retired) return;
    if (owner.suspended) {
      const current =
        owner.expectedReader === null ? undefined : sessionReading(owner.queryClient, owner.expectedReader);
      if (
        owner.expectedReader !== null &&
        (current?.query !== owner.sessionQuery ||
          current?.admitted !== true ||
          current?.state !== owner.suspendedSessionState ||
          !canOwnPrivateReading(owner.readingObjects, owner))
      ) {
        owner.retire();
        return;
      }
      if (owner.expectedReader !== null && !claimPrivateReading(owner.readingObjects, owner)) {
        owner.retire();
        return;
      }
      owner.suspendedSessionState = null;
      owner.suspended = false;
      owner.generation += 1;
      refreshOwner((version) => version + 1);
    } else if (owner.expectedReader !== null && !claimPrivateReading(owner.readingObjects, owner)) {
      owner.retire();
      return;
    }
    owner.mounted = true;
    const unsubscribe =
      owner.expectedReader === null
        ? undefined
        : owner.queryClient.getQueryCache().subscribe((event) => {
            if (!sameSessionKey(event.query.queryKey)) return;
            if (event.type === 'removed' || event.type === 'added') {
              owner.retire();
              return;
            }
            if (event.type !== 'updated') return;
            const current = sessionReading(owner.queryClient, owner.expectedReader!);
            if (
              event.action.type === 'error' ||
              event.query !== owner.sessionQuery ||
              current.query !== owner.sessionQuery ||
              !current.admitted
            )
              owner.retire();
          });
    owner.stopObserving = unsubscribe;
    if (owner.expectedReader !== null && !owner.retired && !owner.current(owner.generation)) owner.retire();
    const unregister = registerOwner(identity, owner.retire);
    return () => {
      unsubscribe?.();
      if (owner.stopObserving === unsubscribe) owner.stopObserving = undefined;
      unregister();
      owner.mounted = false;
      owner.suspended = true;
      owner.generation += 1;
      active.current = false;
      clearOwnedQueries(owner);
      if (owner.expectedReader !== null) {
        owner.suspendedSessionState = sessionReading(owner.queryClient, owner.expectedReader).state;
        closePrivateReading(owner.readingObjects);
      }
    };
  }, [identity, owner, registerOwner, section]);

  useLayoutEffect(() => {
    const trigger = visibleCompletion?.trigger;
    // Only replace focus lost with the activated anchor. A reader may have moved to another stream.
    if (
      owner.current(readingGeneration) &&
      visibleCompletion?.terminal &&
      trigger &&
      (trigger.ownerDocument.activeElement === trigger ||
        trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
    )
      end.current?.focus({ preventScroll: true });
  }, [owner, readingGeneration, visibleCompletion]);

  const cursor = !stopped && visiblePage?.ok ? relationCursor(visiblePage.body) : undefined;
  const items = windowItems(visiblePage, value);
  const continuationEnabled = owner.expectedReader === null || (currentSession && owner.matches(readingGeneration));
  const currentView = isView(view) ? view : 'relations';
  const base = value.subject
    ? subjectViewHref({ id: value.subject, label: value.subjectLabel ?? '' }, value.locale, currentView)
    : undefined;
  const realm = value.realm ?? (value.context?.population.kind === 'realm' ? value.context.population.id : undefined);
  const query = new URLSearchParams({ node, ...(cursor ? { cursor } : {}), ...(realm ? { realm } : {}) });
  const href = base ? `${base}?${query}` : undefined;
  const options = { locale: value.locale as never };
  async function more(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !cursor ||
      !value.subject
    )
      return;
    const generation = readingGeneration;
    // Keep the native restart path available when admission has changed but React has not committed yet.
    if (!continuationEnabled || !owner.current(generation)) return;
    event.preventDefault();
    if (active.current) return;
    active.current = true;
    const trigger = event.currentTarget;
    setState((previous) =>
      owner.matches(generation) ? { ...previous, pending: true, error: undefined, completion: undefined } : previous,
    );
    let queryKey: QueryKey | undefined;
    let ownedKey: string | undefined;
    try {
      if (!owner.current(generation)) return;
      const representation = pageRepresentation(value.context);
      const request: RelationGroupRequest = {
        subject: value.subject,
        locale: value.locale,
        view: currentView,
        node,
        cursor,
        realm,
        reader: value.cacheReader ?? null,
        context: representation.context,
        population: representation.population,
        ...(representation.populationId ? { populationId: representation.populationId } : {}),
      };
      queryKey = relationGroupKey(request, incarnation);
      ownedKey = JSON.stringify(queryKey);
      owner.queries.set(ownedKey, { client: queryClient, key: queryKey });
      const next = await queryClient.fetchQuery({
        queryKey,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: async ({ signal }) => {
          if (!owner.current(generation)) throw new Error('Retired relation continuation');
          const result = await loadRelationGroup({ data: request });
          if (signal.aborted || !owner.current(generation)) throw new Error('Retired relation continuation');
          return result;
        },
      });
      if (!owner.current(generation)) return;
      if (next.ok && owner.expectedReader !== null) {
        const nextObjects = privateReadingObjects(next);
        if (!claimPrivateReading(nextObjects, owner)) {
          owner.retire();
          return;
        }
        closePrivateReading(owner.readingObjects);
        owner.readingObjects = nextObjects;
      }
      const focusTrigger = trigger.ownerDocument.activeElement === trigger ? trigger : null;
      setState((previous) => {
        if (!owner.matches(generation)) return previous;
        const nextCursor = next.ok ? relationCursor(next.body) : undefined;
        const nextProgress = next.ok ? advanceRelationProgress(previous.progress, nextCursor) : previous.progress;
        return {
          ...previous,
          page: next.ok ? next : undefined,
          progress: nextProgress,
          error: next.ok ? undefined : { status: next.status },
          completion: next.ok
            ? {
                count: windowItems(next, value).length,
                terminal: !nextCursor || !!nextProgress.stopped,
                trigger: focusTrigger,
              }
            : undefined,
        };
      });
      if (!next.ok && owner.current(generation)) void router?.invalidate();
    } catch (cause) {
      if (owner.current(generation)) {
        const status = relationFailureStatus(cause);
        setState((previous) =>
          owner.matches(generation)
            ? {
                ...previous,
                page: status === undefined ? previous.page : undefined,
                error: { status },
                completion: undefined,
              }
            : previous,
        );
        if (status !== undefined && owner.current(generation)) void router?.invalidate();
      }
    } finally {
      if (queryKey && ownedKey) {
        owner.queries.delete(ownedKey);
        queryClient.removeQueries({ queryKey, exact: true });
      }
      if (owner.current(generation)) {
        active.current = false;
        setState((previous) => (owner.matches(generation) ? { ...previous, pending: false } : previous));
      }
    }
  }

  return (
    <section
      data-slot="relation-stream"
      data-node={node}
      aria-labelledby={`${node}-title`}
      aria-busy={visiblePending}
      className="min-w-0 space-y-4"
    >
      <StreamHeading
        level={headingLevel}
        node={node}
        id={`${node}-title`}
        lang={titleLang}
        className="text-2xl font-semibold tracking-tight"
      >
        {title}
      </StreamHeading>
      {readerUnavailable ? (
        <p role="alert">{m.subject_relation_unavailable({}, options)}</p>
      ) : items.length ? (
        <CoverList items={items} value={value} label={title} />
      ) : !visibleError ? (
        <p role={!section.ok ? 'status' : undefined}>
          {section.ok ? m.subject_relation_empty_page({}, options) : failure(section.status, value.locale)}
        </p>
      ) : null}
      <p
        id={`${node}-status`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm text-muted-foreground"
      >
        {visiblePending
          ? m.subject_relation_loading({}, options)
          : visibleCompletion
            ? stopped
              ? m.relation_window_completed_stop({ label: title, count: visibleCompletion.count }, options)
              : visibleCompletion.terminal
                ? m.relation_window_completed_end({ label: title, count: visibleCompletion.count }, options)
                : m.relation_window_completed_more({ label: title, count: visibleCompletion.count }, options)
            : null}
      </p>
      {visibleCompletion?.terminal && (
        <p
          ref={end}
          tabIndex={-1}
          data-slot="relation-stream-end"
          className="rounded-sm text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {stopped === 'cycle'
            ? m.relation_window_cycle({}, options)
            : stopped === 'limit'
              ? m.relation_window_limit({}, options)
              : m.subject_relation_end({ label: title }, options)}
        </p>
      )}
      {visibleError && <p role="alert">{failure(visibleError.status, value.locale)}</p>}
      {href && cursor && (
        <a
          data-slot="continue-group"
          href={href}
          onClick={more}
          aria-disabled={visiblePending}
          aria-describedby={`${node}-status`}
          className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
        >
          {visibleError ? m.subject_section_retry({}, options) : m.subject_section_more({ label: title }, options)}
        </a>
      )}
      {(stopped || visibleError || !section.ok || readerUnavailable) && base && (
        <a
          data-slot="restart-group"
          href={`${base}?${new URLSearchParams({ node, ...(realm ? { realm } : {}) })}`}
          className={cn(buttonVariants({ variant: 'link' }), actionClass)}
        >
          {m.subject_relation_restart({}, options)}
        </a>
      )}
    </section>
  );
}
