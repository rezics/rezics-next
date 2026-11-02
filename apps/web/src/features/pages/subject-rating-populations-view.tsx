import { useQuery, useQueryClient, type QueryClient, type QueryCacheNotifyEvent } from '@tanstack/react-query';
import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { useSession } from '../../session/query';
import { readSubjectRatingPopulations } from './subject-rating-populations-actions';
import {
  POPULATION_LIMIT,
  type PopulationEnvelope,
  type PopulationInput,
  type PopulationItem,
} from './subject-rating-populations';
import { displayRating, PUBLIC_RATING_SCALE, type RatingQuestion } from './subject-ratings';
import { RatingSourceStatus } from './subject-ratings-view';
import {
  acceptPopulationPage,
  nextPopulationPage,
  populationRequestKey,
  restartPopulationProgress,
  startPopulationProgress,
} from './rating-population-progress';

type Session = ReturnType<typeof useSession>;
export type PopulationTransport = (input: PopulationInput) => Promise<PopulationEnvelope>;
const transport: PopulationTransport = (data) => readSubjectRatingPopulations({ data });
const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';
let serial = 0;

/** Subscribes before a mounted owner starts work. Cache observations retire monotonically before React commits. */
class PopulationRegistry {
  readonly id = ++serial;
  epoch = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private leases = new Map<string, PopulationLease>();
  private versions = new Map<string, number>();
  private sourceData = new WeakMap<QueryCacheNotifyEvent['query'], unknown>();
  private sessionQuery: QueryCacheNotifyEvent['query'] | undefined;
  private sessionData: unknown;
  constructor(readonly client: QueryClient) {
    this.sessionQuery = client.getQueryCache().find({ queryKey: ['session'], exact: true });
    this.sessionData = this.sessionQuery?.state.data;
    client.getQueryCache().subscribe((event) => this.observe(event));
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  serverSnapshot = () => 0;
  private notify() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  rememberQuestion(subject: string, locale: string) {
    const query = this.client
      .getQueryCache()
      .find({ queryKey: ['subject-rating', subject, locale, 'question'], exact: true });
    if (query && !this.sourceData.has(query)) this.sourceData.set(query, query.state.data);
  }
  private dataReplaced(query: QueryCacheNotifyEvent['query']) {
    const replaced = this.sourceData.has(query) && this.sourceData.get(query) !== query.state.data;
    this.sourceData.set(query, query.state.data);
    return replaced;
  }
  private observe(event: QueryCacheNotifyEvent) {
    const { query } = event;
    if (query.queryKey.length === 1 && query.queryKey[0] === 'session') {
      const currentQuery = this.client.getQueryCache().find({ queryKey: ['session'], exact: true });
      const changed = currentQuery !== this.sessionQuery || currentQuery?.state.data !== this.sessionData;
      this.sessionQuery = currentQuery;
      this.sessionData = currentQuery?.state.data;
      if (
        changed ||
        event.type === 'added' ||
        event.type === 'removed' ||
        (event.type === 'updated' && event.action.type === 'success')
      ) {
        // Equal success, Query replacement and A→B→A each advance; fetch/error/observer notifications do not.
        this.epoch++;
        this.notify();
      }
      return;
    }
    if (query.queryKey[0] === 'subject-rating' && query.queryKey[3] === 'question') {
      const replaced = this.dataReplaced(query);
      if (
        replaced ||
        event.type === 'added' ||
        event.type === 'removed' ||
        (event.type === 'updated' && event.action.type === 'success')
      ) {
        this.epoch++;
        this.notify();
      }
      return;
    }
    if (event.type === 'removed') this.versions.delete(query.queryHash);
    const key = query.meta?.ratingPopulationLease;
    if (typeof key !== 'string') return;
    const replaced = this.dataReplaced(query);
    const lease = this.leases.get(key);
    if (!lease?.isCurrent() || !lease.ownsQuery?.(query.queryHash)) return;
    if (
      event.type === 'removed' ||
      (replaced && !(event.type === 'updated' && event.action.type === 'success')) ||
      (event.type === 'updated' && event.action.type === 'success' && event.action.manual)
    ) {
      lease.retire();
      this.epoch++;
      this.notify();
    } else if (event.type === 'updated' && event.action.type === 'success') {
      this.versions.set(query.queryHash, this.version(query.queryHash) + 1);
      this.notify();
    }
  }
  version(hash: string) {
    return this.versions.get(hash) ?? 0;
  }
  register(lease: PopulationLease) {
    this.leases.set(lease.key, lease);
  }
  remove(lease: PopulationLease) {
    this.leases.delete(lease.key);
  }
}
const registries = new WeakMap<QueryClient, PopulationRegistry>();
function registryFor(client: QueryClient) {
  let registry = registries.get(client);
  if (!registry) {
    registry = new PopulationRegistry(client);
    registries.set(client, registry);
  }
  return registry;
}
type PopulationLease = { key: string; isCurrent(): boolean; retire(): void; ownsQuery?: (hash: string) => boolean };

export function useRatingPopulations(
  input: {
    subjectId: string;
    question: string;
    questionIdentity?: string;
    locale: string;
    session: Session;
    enabled?: boolean;
  },
  read: PopulationTransport = transport,
) {
  const client = useQueryClient();
  const registry = useMemo(() => registryFor(client), [client]);
  registry.rememberQuestion(input.subjectId, input.locale);
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.serverSnapshot);
  const cached = client.getQueryData<Session>(['session']);
  const reader =
    input.session.state === 'signed-in' &&
    cached?.state === 'signed-in' &&
    cached.subject === input.session.subject &&
    cached.csrfToken === input.session.csrfToken
      ? (cached.subject ?? null)
      : null;
  const anonymous = input.session.state === 'signed-out' && cached?.state === 'signed-out';
  const enabled = input.enabled !== false && (anonymous || reader !== null);
  const signature = JSON.stringify([
    registry.id,
    registry.epoch,
    input.subjectId,
    input.question,
    input.questionIdentity,
    input.locale,
    reader,
    anonymous,
    enabled,
  ]);
  const desired = useRef({ signature, read });
  desired.current = { signature, read };
  const [owner, setOwner] = useState<{ signature: string; lease: PopulationLease } | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      setOwner(null);
      return;
    }
    let live = true;
    const epoch = registry.epoch;
    const lease: PopulationLease = {
      key: JSON.stringify([registry.id, ++serial, input.subjectId, input.question, reader]),
      isCurrent: () =>
        live &&
        registry.epoch === epoch &&
        desired.current.signature === signature &&
        desired.current.read === read &&
        (anonymous
          ? client.getQueryData<Session>(['session'])?.state === 'signed-out'
          : client.getQueryData<Session>(['session'])?.state === 'signed-in' &&
            client.getQueryData<Session>(['session'])?.subject === reader),
      retire: () => {
        live = false;
      },
    };
    registry.register(lease);
    setOwner({ signature, lease });
    return () => {
      lease.retire();
      registry.remove(lease);
    };
  }, [registry, signature, enabled, reader, anonymous, read, client, input.subjectId, input.question]);
  const lease = owner?.signature === signature ? owner.lease : undefined;
  return { lease, reader, registry, client };
}

/** Real directory and exact selected comparisons, isolated from every public cache and head operand. */
export function SubjectRatingPopulations({
  subjectId,
  question,
  locale,
  session,
  enabled = true,
  read = transport,
}: {
  subjectId: string;
  question: RatingQuestion;
  locale: string;
  session: Session;
  enabled?: boolean;
  read?: PopulationTransport;
}) {
  const admission = useRatingPopulations(
    {
      subjectId,
      question: question.id,
      questionIdentity: JSON.stringify([
        question.revision,
        question.grain,
        question.scale.min,
        question.scale.max,
        question.scale.displayStep,
      ]),
      locale,
      session,
      enabled,
    },
    read,
  );
  const key = admission.lease?.key ?? 'inactive';
  // A new reader/visit gets a fresh component and fresh selection, including after ABA restoration.
  return <PopulationVisit key={key} {...{ subjectId, question, locale, read, admission }} />;
}

type Admission = ReturnType<typeof useRatingPopulations>;
function PopulationVisit({
  subjectId,
  question,
  locale,
  read,
  admission,
}: {
  subjectId: string;
  question: RatingQuestion;
  locale: string;
  read: PopulationTransport;
  admission: Admission;
}) {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  const { lease, reader, registry } = admission;
  const [pageState, setPageState] = useState(startPopulationProgress);
  const [selection, setSelection] = useState<{ ids: string[]; revision: number }>({ ids: [], revision: 0 });
  const { request } = pageState;
  const acceptedRequest = pageState.accepted ?? request;
  const selected = selection.ids;
  const cursorKey = populationRequestKey(request);
  const acceptedKey = populationRequestKey(acceptedRequest);
  const selectedKey = JSON.stringify([selection.revision, selected]);
  const wanted = useRef({ cursorKey, acceptedKey, selectedKey });
  wanted.current = { cursorKey, acceptedKey, selectedKey };
  const progress = useRef(pageState);
  progress.current = pageState;
  const helpId = useId();
  const region = useRef<HTMLDivElement>(null);
  const [focusPage, setFocusPage] = useState(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && lease?.isCurrent() === true;

  function query(kind: 'directory' | 'selected', pageRequest = request) {
    const pageKey = populationRequestKey(pageRequest);
    const operand = kind === 'directory' ? pageKey : selectedKey;
    const queryKey = ['subject-rating-populations', subjectId, question.id, locale, reader, lease?.key, kind, operand];
    const hash = JSON.stringify(queryKey);
    const matches = () =>
      current() &&
      (kind === 'directory'
        ? wanted.current.cursorKey === pageKey || wanted.current.acceptedKey === pageKey
        : wanted.current.selectedKey === selectedKey);
    return {
      queryKey,
      queryHash: hash,
      meta: { ratingPopulationLease: lease?.key },
      staleTime: Infinity,
      gcTime: 0,
      structuralSharing: false,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      enabled: current() && (kind === 'directory' || selected.length > 0),
      queryFn: async () => {
        const version = registry.version(hash);
        if (!matches()) throw new Error('Rating population visit retired');
        if (kind === 'directory' && progress.current.stopped) throw new Error('Rating population traversal stopped');
        const value = await read({
          id: subjectId,
          question: question.id,
          locale,
          expectedReader: reader,
          ...(kind === 'directory'
            ? pageRequest.cursor !== undefined
              ? { cursor: pageRequest.cursor }
              : {}
            : { selected }),
        });
        if (
          !matches() ||
          registry.version(hash) !== version ||
          value.reader !== reader ||
          value.subject !== subjectId ||
          value.question !== question.id
        )
          throw new Error('Rating population response retired');
        return value;
      },
    };
  }
  const directoryOptions = query('directory');
  const acceptedOptions = query('directory', acceptedRequest);
  const selectedOptions = query('selected');
  if (lease)
    lease.ownsQuery = (hash) =>
      current() && [directoryOptions.queryHash, acceptedOptions.queryHash, selectedOptions.queryHash].includes(hash);
  const directory = useQuery(directoryOptions);
  // Keep the accepted page observed while a different request is pending. Its disclosure context
  // remains live, and gcTime: 0 removes superseded queries as soon as both observers move on.
  const acceptedDirectory = useQuery({ ...acceptedOptions, enabled: false });
  const comparison = useQuery(selectedOptions);
  const pageVersion = registry.version(directoryOptions.queryHash);
  const acceptedVersion = registry.version(acceptedOptions.queryHash);
  const selectionVersion = registry.version(selectedOptions.queryHash);
  const directoryGuard = () =>
    current() &&
    wanted.current.cursorKey === cursorKey &&
    wanted.current.acceptedKey === acceptedKey &&
    registry.version(directoryOptions.queryHash) === pageVersion &&
    registry.version(acceptedOptions.queryHash) === acceptedVersion;
  const selectionGuard = () =>
    current() &&
    wanted.current.selectedKey === selectedKey &&
    registry.version(selectedOptions.queryHash) === selectionVersion;
  const guard = () => directoryGuard() && selectionGuard();
  const pending = pageState.accepted?.revision !== request.revision;
  const busy = directory.isFetching || acceptedDirectory.isFetching;
  const directoryKind = directory.data?.result.kind;
  // Transport failures preserve the accepted page; current refusal/withdrawal does not.
  const disclosed = !directoryKind || directoryKind === 'ready' || directoryKind === 'failed';
  const page =
    current() && disclosed && acceptedDirectory.data?.result.kind === 'ready'
      ? acceptedDirectory.data.result.value
      : undefined;
  const observed = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (!current()) return;
    const sources = new Map([
      [acceptedOptions.queryHash, { request: acceptedRequest, version: acceptedVersion, data: acceptedDirectory.data }],
      [directoryOptions.queryHash, { request, version: pageVersion, data: directory.data }],
    ]);
    let next = pageState;
    for (const [hash, source] of sources) {
      if (source.version === observed.current.get(hash)) continue;
      const result = source.data?.result;
      if (result?.kind === 'ready') next = acceptPopulationPage(next, source.request, result.value.next);
      else if (result && result.kind !== 'failed' && result.kind !== 'idle') next = { ...next, accepted: undefined };
    }
    observed.current = new Map([...sources].map(([hash, source]) => [hash, source.version]));
    if (next !== pageState) setPageState(next);
  }, [directory.data, acceptedDirectory.data, pageVersion, acceptedVersion, cursorKey, acceptedKey]);
  const comparisons = current() && comparison.data?.result.kind === 'ready' ? comparison.data.result.value : undefined;
  const directoryOutcome = directory.isFetching
    ? { kind: 'idle' as const }
    : (directory.data?.result ?? {
        kind: directory.isError ? ('failed' as const) : ('idle' as const),
      });
  const selectedOutcome = comparison.data?.result ?? {
    kind: comparison.isError ? ('failed' as const) : ('idle' as const),
  };
  const visibility = useRef<{ hidden: Set<string>; directory?: PopulationEnvelope; selected?: PopulationEnvelope }>({
    hidden: new Set(),
  });
  if (acceptedDirectory.data && visibility.current.directory !== acceptedDirectory.data) {
    visibility.current.directory = acceptedDirectory.data;
    const retained = new Set([...selected, ...(page?.items.map((item) => item.id) ?? [])]);
    for (const id of visibility.current.hidden) if (!retained.has(id)) visibility.current.hidden.delete(id);
    for (const item of page?.items ?? []) visibility.current.hidden.delete(item.id);
  }
  if (comparison.data && visibility.current.selected !== comparison.data) {
    visibility.current.selected = comparison.data;
    const readable = new Set(comparisons?.items.map((item) => item.id));
    for (const id of selected) {
      if (readable.has(id)) visibility.current.hidden.delete(id);
      else visibility.current.hidden.add(id);
    }
  }
  const choices = page?.items.filter((item) => !visibility.current.hidden.has(item.id)) ?? [];
  const canRetrySelection =
    selected.length > 0 &&
    (selectedOutcome.kind !== 'ready' ||
      comparisons?.incomplete ||
      comparisons?.items.some((item) => item.figure.kind !== 'ready'));

  useLayoutEffect(() => {
    if (!focusPage || !page || pending || busy || !guard()) return;
    region.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus();
    setFocusPage(false);
  }, [
    cursorKey,
    acceptedKey,
    acceptedDirectory.data,
    focusPage,
    pending,
    busy,
    pageVersion,
    acceptedVersion,
    selectionVersion,
  ]);

  const changeSelection = (next: string[]) => {
    if (!selectionGuard() || next.length > POPULATION_LIMIT) return;
    const revision = selection.revision + 1;
    wanted.current = { ...wanted.current, selectedKey: JSON.stringify([revision, next]) };
    setSelection({ ids: next, revision });
  };
  const move = (restart = false) => {
    if (!directoryGuard() || (!restart && (busy || pending))) return;
    const next = restart ? restartPopulationProgress(pageState) : nextPopulationPage(pageState, page?.next ?? null);
    if (next === pageState) return;
    wanted.current = { ...wanted.current, cursorKey: populationRequestKey(next.request) };
    setPageState(next);
    setFocusPage(true);
  };
  const retry = (kind: 'directory' | 'selected') => {
    if (kind === 'directory' ? !directoryGuard() || busy || !!pageState.stopped : !selectionGuard()) return;
    // No mutation/invalidation of siblings, own votes, or drafts. Query finally is owned by TanStack.
    if (kind === 'directory') setFocusPage(true);
    void (kind === 'directory' ? directory.refetch() : comparison.refetch()).catch(() => {});
  };
  const clear = () => {
    if (!selectionGuard()) return;
    region.current?.querySelector<HTMLElement>('legend')?.focus();
    changeSelection([]);
  };

  if (!lease || !current()) return null;
  return (
    <div ref={region} data-slot="rating-populations" className="space-y-4 text-sm">
      <FieldSet aria-describedby={helpId} aria-busy={directory.isFetching}>
        <FieldLegend
          tabIndex={-1}
          className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.rating_population_choose({}, options)}
        </FieldLegend>
        <FieldDescription id={helpId}>
          {m.rating_population_help({ limit: String(POPULATION_LIMIT) }, options)}
        </FieldDescription>
        <RatingSourceStatus
          outcome={directoryOutcome}
          source="directory"
          locale={locale}
          retry={pageState.stopped ? undefined : () => retry('directory')}
        />
        {pageState.stopped && (
          <p role="status">
            {pageState.stopped === 'cycle'
              ? m.relation_window_cycle({}, options)
              : m.relation_window_limit({}, options)}
          </p>
        )}
        {page && (
          <>
            {choices.length === 0 && <p role="status">{m.rating_population_empty_page({}, options)}</p>}
            {page.incomplete && <p role="status">{m.rating_population_concealed({}, options)}</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              {choices.map((item) => (
                <Field key={item.id} orientation="horizontal" className="min-w-0">
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 break-words">
                    <input
                      type="checkbox"
                      aria-describedby={helpId}
                      className="size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      checked={selected.includes(item.id)}
                      disabled={!selected.includes(item.id) && selected.length >= POPULATION_LIMIT}
                      onChange={() => {
                        if (guard())
                          changeSelection(
                            selected.includes(item.id)
                              ? selected.filter((id) => id !== item.id)
                              : [...selected, item.id],
                          );
                      }}
                    />
                    <span className="min-w-0 break-words">{item.name}</span>
                  </label>
                </Field>
              ))}
            </div>
            {selected.length === POPULATION_LIMIT && (
              <p role="status">{m.rating_population_limit({ limit: String(POPULATION_LIMIT) }, options)}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                className={actionClass}
                type="button"
                variant="outline"
                disabled={!pageState.stopped && request.cursor === undefined && !pending}
                onClick={() => move(true)}
              >
                {m.rating_population_restart({}, options)}
              </Button>
              <Button
                className={actionClass}
                type="button"
                variant="outline"
                disabled={busy || pending || !!pageState.stopped || page.next === null}
                onClick={() => move()}
              >
                {m.rating_population_next({}, options)}
              </Button>
            </div>
          </>
        )}
        {!page && (request.cursor !== undefined || pageState.accepted || pageState.stopped) && (
          <Button className={actionClass} type="button" variant="outline" onClick={() => move(true)}>
            {m.rating_population_restart({}, options)}
          </Button>
        )}
      </FieldSet>
      {selected.length > 0 && (
        <div data-slot="rating-selected" className="space-y-3" aria-busy={comparison.isFetching}>
          <h3 className="font-medium">{m.subject_ratings_comparisons({}, options)}</h3>
          <RatingSourceStatus
            outcome={selectedOutcome}
            source="selected"
            locale={locale}
            retry={() => retry('selected')}
          />
          {comparisons?.incomplete && <p role="status">{m.rating_population_concealed({}, options)}</p>}
          <ul className="grid gap-4 sm:grid-cols-2">
            {comparisons?.items.map((item) => (
              <li key={item.id} data-slot="rating-comparison" className="min-w-0">
                <ContentItemFrame
                  as="div"
                  data-slot="content-item-frame"
                  className="min-w-0 space-y-2 wrap-anywhere py-3 sm:py-4"
                >
                  <ContentItemHeading
                    level={4}
                    className="text-[17px] leading-snug font-semibold sm:text-lg md:text-xl"
                  >
                    {item.name}
                  </ContentItemHeading>
                  <div data-content-item-slot="preview">
                    <PopulationFigure {...{ item, question, locale }} />
                  </div>
                  <ListRowControl data-content-item-slot="actions" className="flex flex-wrap gap-2">
                    <Button
                      className={actionClass}
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (!guard()) return;
                        region.current?.querySelector<HTMLElement>('legend')?.focus();
                        changeSelection(selected.filter((id) => id !== item.id));
                      }}
                    >
                      {m.rating_population_remove({ name: item.name }, options)}
                    </Button>
                  </ListRowControl>
                </ContentItemFrame>
              </li>
            ))}
          </ul>
          {canRetrySelection && selectedOutcome.kind === 'ready' && (
            <Button className={actionClass} type="button" variant="outline" onClick={() => retry('selected')}>
              {m.subject_section_retry({}, options)}
            </Button>
          )}
          <Button className={actionClass} type="button" variant="outline" onClick={clear}>
            {m.rating_population_clear({}, options)}
          </Button>
        </div>
      )}
    </div>
  );
}

function PopulationFigure({
  item,
  question,
  locale,
}: {
  item: PopulationItem;
  question: RatingQuestion;
  locale: string;
}) {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  if (item.figure.kind !== 'ready')
    return <RatingSourceStatus outcome={item.figure} source="comparison" locale={locale} />;
  const figure = item.figure.value;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const threshold = ['episode', 'character'].includes(question.grain) ? 10 : 5;
  const mean = figure.mean;
  return (
    <div className="space-y-1">
      {figure.freshness?.updating ? (
        <>
          <p>{m.subject_ratings_realm_count({ count: number(figure.count), population: item.name }, options)}</p>
          <p role="status">{m.rating_public_updating({}, options)}</p>
        </>
      ) : figure.count === 0 ? (
        <p>{m.subject_ratings_empty({}, options)}</p>
      ) : (
        <>
          <p>{m.subject_ratings_realm_count({ count: number(figure.count), population: item.name }, options)}</p>
          {figure.remaining !== undefined || figure.count < threshold ? (
            <p>
              {m.subject_ratings_remaining({ count: number(figure.remaining ?? threshold - figure.count) }, options)}
            </p>
          ) : mean !== undefined &&
            Number.isFinite(mean) &&
            mean >= question.scale.min &&
            mean <= question.scale.max ? (
            <p className="font-medium tabular-nums">
              {m.rating_public_mean(
                { mean: number(displayRating(mean, question.scale)), maximum: number(PUBLIC_RATING_SCALE.max) },
                options,
              )}
            </p>
          ) : (
            <p>{m.subject_ratings_figure_unavailable({}, options)}</p>
          )}
        </>
      )}
      {figure.freshness?.asOf && (
        <p className="text-muted-foreground">
          {m.rating_population_as_of(
            {
              date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(figure.freshness.asOf),
              ),
            },
            options,
          )}
        </p>
      )}
    </div>
  );
}
