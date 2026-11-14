import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../../kernel/query';
import { AnonymousSessionContext, useSession } from '../../session/query';
import { useContext, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';
import type { SubjectSummary } from '../../media/summary';
import type { Fact } from '../../search/results';
import { CoverList } from './cover-list';
import { OverviewContext, pageRepresentation, type Item, type OverviewValue, type Section } from './overview';
import { isRecord, pageText } from './shared';
import { loadMemberList, type MemberListRequest, type MemberPageTarget } from './member-list-query';
import { useListReaderAdmission, type ListReaderSession } from './list-reader-admission';
import { admitMemberPage, admitMemberSection } from './member-page-admission';
import { createMemberPageProgress, memberPageCursor } from './member-page-progress';
import { admitMemberRetry, memberRetryAt } from './member-retry-admission';
import { useSearchRetryWait } from '../../search/search-recovery-retry';

const emptySection: Section = { ok: false };

function sectionFingerprint(section: Section): string {
  try {
    return JSON.stringify(section);
  } catch {
    return `${section.ok}:${section.ok ? 'ready' : (section.status ?? 'unavailable')}`;
  }
}

function useReadingLifetime(onRetire?: () => void) {
  const lifetime = useRef({ generation: 0, mounted: false });
  const onRetireRef = useRef(onRetire);
  onRetireRef.current = onRetire;
  useLayoutEffect(() => {
    const generation = ++lifetime.current.generation;
    lifetime.current.mounted = true;
    return () => {
      if (lifetime.current.generation === generation) {
        lifetime.current.mounted = false;
        lifetime.current.generation += 1;
        onRetireRef.current?.();
      }
    };
  }, []);
  return useMemo(
    () => ({
      current(generation: number) {
        return lifetime.current.mounted && lifetime.current.generation === generation;
      },
      generation() {
        return lifetime.current.generation;
      },
      retire(generation: number) {
        if (!lifetime.current.mounted || lifetime.current.generation !== generation) return false;
        lifetime.current.generation += 1;
        onRetireRef.current?.();
        return true;
      },
    }),
    [],
  );
}

function boundSummary(row: Record<string, unknown>, id: string): SubjectSummary | undefined {
  const match = (value: unknown): value is Exclude<SubjectSummary, null> =>
    isRecord(value) && typeof value.id === 'string' && value.id.toLowerCase() === id.toLowerCase();
  if (match(row.subject)) return row.subject as Exclude<SubjectSummary, null>;
  if (match(row.summary)) return row.summary as Exclude<SubjectSummary, null>;
  return undefined;
}

/** Project an admitted native page without any per-row reads. */
export function memberItems(section: Section, value: OverviewValue): Item[] {
  if (!section.ok) return [];
  const body = admitMemberPage(section.read, section.body);
  if (!body) return [];
  return projectMemberItems({ ...section, body }, value);
}

function projectMemberItems(section: Extract<Section, { ok: true }>, value: OverviewValue): Item[] {
  const body = section.body;
  const rows = section.read.kind === 'search' ? body.subjects : body.members;
  return (rows as Record<string, unknown>[]).map((record) => {
    const id = String(section.read.kind === 'search' ? record.id : record.subjectId);
    const summary = boundSummary(record, id);
    const nativeLabel = summary?.label;
    const label =
      isRecord(nativeLabel) && typeof nativeLabel.value === 'string'
        ? { text: nativeLabel.value, lang: typeof nativeLabel.language === 'string' ? nativeLabel.language : undefined }
        : typeof nativeLabel === 'string'
          ? { text: nativeLabel, lang: undefined }
          : pageText(record.labels, value.locale);
    return {
      id,
      label,
      ...(typeof summary?.type === 'string'
        ? { type: summary.type }
        : typeof record.type === 'string'
          ? { type: record.type }
          : {}),
      ...(summary ? { summary } : {}),
      notes: [],
      gated: false,
    };
  });
}

type MemberReading = {
  items: Item[];
  identities: Set<string>;
  facts: Record<string, Record<string, Fact[]>>;
  cursor: string | undefined;
  failure: Extract<Section, { ok: false }> | undefined;
};

/** Retain only disclosed card data, its paired native facts and the current opaque cursor. */
function emptyMemberReading(failure?: Extract<Section, { ok: false }>): MemberReading {
  return { items: [], identities: new Set(), facts: {}, cursor: undefined, failure };
}

function appendMemberPage(
  previous: MemberReading,
  section: Extract<Section, { ok: true }>,
  value: OverviewValue,
): MemberReading {
  const items = [...previous.items];
  const identities = new Set(previous.identities);
  const facts = { ...previous.facts };
  const rows = (section.read.kind === 'search' ? section.body.subjects : section.body.members) as Record<
    string,
    unknown
  >[];
  const admittedItems = projectMemberItems(section, value);
  for (const [index, item] of admittedItems.entries()) {
    const identity = item.id.toLowerCase();
    if (identities.has(identity)) continue;
    identities.add(identity);
    items.push(item);
    // First disclosure wins as a whole: a repeated identity cannot replace its label, summary or facts.
    const supplied = rows[index]!.facts as Record<string, Fact[]> | undefined;
    if (supplied) facts[item.id] = supplied;
  }
  return { items, identities, facts, cursor: memberPageCursor(section.body), failure: undefined };
}

function initialMemberReading(section: Section, value: OverviewValue): MemberReading {
  const admitted = admitMemberSection(section);
  return admitted.ok ? appendMemberPage(emptyMemberReading(), admitted, value) : emptyMemberReading(admitted);
}

export function Members(props: Record<string, unknown>) {
  const value = useContext(OverviewContext);
  const viewer = useSession();
  const anonymous = useContext(AnonymousSessionContext);
  const queryClient = useQueryClient();
  const node = typeof props.id === 'string' ? props.id : '';
  const initial = value?.sections.get(node) ?? emptySection;
  const target = value?.pageTarget;
  const representation = pageRepresentation(value?.context);
  const viewerRecovery = isRecord(props.source) && !initial.ok && initial.status === 404;
  const privateReading = !!value && (value.cacheReader != null || viewerRecovery);
  const scope = JSON.stringify([
    target,
    value?.subject,
    value?.account ?? null,
    props,
    sectionFingerprint(initial),
    value?.locale,
    value?.cacheReader ?? null,
    representation,
    value?.reader,
  ]);
  const admission = useListReaderAdmission(queryClient, scope, {
    sourceFingerprint: sectionFingerprint(initial),
    privateReading,
    observeSession: privateReading && !anonymous,
    fallbackSession: viewer,
  });
  if (!value || !node) return null;
  const key = JSON.stringify([scope, admission.incarnation]);
  return (
    <MemberReader
      key={key}
      value={value}
      viewer={admission.session}
      admission={admission}
      props={props}
      initial={initial}
      node={node}
      target={target}
      representation={representation}
    />
  );
}

function MemberReader({
  value,
  viewer,
  admission,
  props,
  initial,
  node,
  target,
  representation,
}: {
  value: OverviewValue;
  viewer: ListReaderSession;
  admission: ReturnType<typeof useListReaderAdmission>;
  props: Record<string, unknown>;
  initial: Section;
  node: string;
  target?: MemberPageTarget | undefined;
  representation: ReturnType<typeof pageRepresentation>;
}) {
  const incarnation = admission.incarnation;
  const viewerRecovery = isRecord(props.source) && !initial.ok && initial.status === 404;
  // The public shell can conceal self sources or a private curated source. Recheck only for an observed viewer.
  const needsViewer =
    isRecord(props.source) &&
    !initial.ok &&
    initial.status === 404 &&
    viewer.state === 'signed-in' &&
    typeof viewer.subject === 'string' &&
    viewer.subject.length > 0;
  const initialAllowed = admission.initialAllowed(value.cacheReader);
  const needsFreshPrivate =
    value.cacheReader != null &&
    !initialAllowed &&
    admission.canRead &&
    viewer.state === 'signed-in' &&
    viewer.subject === value.cacheReader;
  const recoveryReader = needsViewer ? viewer.subject! : (value.cacheReader ?? null);
  const queryKey = [
    'composed-members-viewer',
    {
      target,
      locale: value.locale,
      node,
      expectedReader: recoveryReader,
      representation,
    },
    incarnation,
  ] as const;
  admission.registerQuery('member-recovery', queryKey);
  const request: MemberListRequest = {
    target: target!,
    locale: value.locale,
    node,
    expectedReader: recoveryReader,
    representation,
  };
  const current = useQuery({
    ...personalRead,
    queryKey,
    enabled: personalRead.enabled && admission.canRead && (needsViewer || needsFreshPrivate) && !!target && !!node,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      // QueryObserver subscribes during commit. Let layout setup and StrictMode effect replay finish before
      // admitting transport, then bind this request to the generation that actually started it.
      const requestIncarnation = incarnation;
      if (signal.aborted || !admission.current(requestIncarnation)) throw new Error('Retired member reading');
      await Promise.resolve();
      if (signal.aborted || !admission.current(requestIncarnation)) throw new Error('Retired member reading');
      let result: Section;
      try {
        result = await loadMemberList({ data: request, signal });
      } catch (error) {
        if (signal.aborted || !admission.current(requestIncarnation)) throw new Error('Retired member reading');
        throw error;
      }
      if (signal.aborted || !admission.current(requestIncarnation)) throw new Error('Retired member reading');
      return result;
    },
  });
  if ((needsViewer || needsFreshPrivate) && target && current.isPending)
    return <p role="status">{m.subject_relation_loading({}, { locale: value.locale as never })}</p>;
  const section: Section =
    needsViewer || needsFreshPrivate
      ? current.isError
        ? { ok: false }
        : (current.data ?? { ok: false })
      : initialAllowed
        ? initial
        : { ok: false };
  const continuationEnabled =
    value.cacheReader == null ||
    ((needsFreshPrivate || initialAllowed) &&
      admission.canRead &&
      viewer.state === 'signed-in' &&
      viewer.subject === value.cacheReader);
  if (viewerRecovery && !needsViewer && !initialAllowed) return null;
  // An anonymous public page has no viewer provenance by design. A known private page cannot outlive its reader.
  if (value.cacheReader && !initialAllowed && !needsFreshPrivate)
    return <p role="alert">{m.subject_relation_unavailable({}, { locale: value.locale as never })}</p>;
  return (
    <MemberList
      value={value}
      section={section}
      node={node}
      title={pageText(props.title, value.locale).text}
      target={target}
      expectedReader={recoveryReader}
      admission={admission}
      continuationEnabled={continuationEnabled}
      paged={props.paged === true}
    />
  );
}

/** Each mounted node owns its explicitly revealed rows; every request still reads one bounded native page. */
export function MemberList({
  value,
  section,
  node,
  title,
  target,
  expectedReader,
  admission,
  continuationEnabled = true,
  paged = true,
}: {
  value: OverviewValue;
  section: Section;
  node: string;
  title: string;
  target?: MemberPageTarget | undefined;
  expectedReader?: string | null | undefined;
  admission: ReturnType<typeof useListReaderAdmission>;
  continuationEnabled?: boolean;
  paged?: boolean;
}) {
  const queryClient = useQueryClient();
  const [reading, setReading] = useState(() => initialMemberReading(section, value));
  const [restart, setRestart] = useState(false);
  const progress = useRef(createMemberPageProgress(reading.cursor));
  const [error, setError] = useState<Section>();
  const [retryAt, setRetryAt] = useState(() => (section.ok ? undefined : memberRetryAt(section.retryAfter)));
  const waiting = useSearchRetryWait(retryAt);
  const [pending, setPending] = useState(false);
  const [completion, setCompletion] = useState<{
    generation: number;
    added: number;
    exhausted: boolean;
    trigger: HTMLButtonElement | null;
  }>();
  const active = useRef(false);
  const instance = useId();
  const incarnation = admission.incarnation;
  const activeQueryKey = useRef<readonly unknown[] | undefined>(undefined);
  const lifetime = useReadingLifetime(() => {
    const key = activeQueryKey.current;
    activeQueryKey.current = undefined;
    if (key && !queryClient.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount())
      void queryClient.cancelQueries({ queryKey: key, exact: true });
  });
  useLayoutEffect(() => {
    const generation = lifetime.generation();
    if (active.current) {
      active.current = false;
      setPending(false);
    }
    return () => {
      lifetime.retire(generation);
    };
  }, [lifetime]);
  const end = useRef<HTMLParagraphElement>(null);
  const handledCompletion = useRef<typeof completion>(undefined);
  useLayoutEffect(() => {
    if (!completion || handledCompletion.current === completion) return;
    handledCompletion.current = completion;
    const trigger = completion.trigger;
    // Replace only the requesting reader's removed trigger, after the exhausted page has rendered.
    if (
      lifetime.current(completion.generation) &&
      admission.current(incarnation) &&
      completion.exhausted &&
      trigger &&
      (trigger.ownerDocument.activeElement === trigger ||
        trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
    )
      end.current?.focus({ preventScroll: true });
  }, [completion, lifetime, admission, incarnation]);
  const cursor = !restart ? reading.cursor : undefined;
  const failed = error && !error.ok ? error : reading.failure;
  const options = { locale: value.locale as never };
  async function more(event: MouseEvent<HTMLButtonElement>) {
    if (
      !continuationEnabled ||
      !target ||
      active.current ||
      !admission.current(incarnation) ||
      waiting ||
      !admitMemberRetry(retryAt)
    )
      return;
    const generation = lifetime.generation();
    const isCurrent = () => lifetime.current(generation) && admission.current(incarnation);
    if (!isCurrent()) return;
    const trigger = event.currentTarget;
    let ownsFocus = trigger.ownerDocument.activeElement === trigger;
    const releaseFocus = () => {
      ownsFocus = false;
    };
    // Once the reader moves away, returning focus while this request is pending does not reclaim it.
    trigger.addEventListener('blur', releaseFocus);
    active.current = true;
    setPending(true);
    setError(undefined);
    setRetryAt(undefined);
    setCompletion(undefined);
    const request: MemberListRequest = {
      target,
      locale: value.locale,
      node,
      ...(cursor ? { cursor } : {}),
      expectedReader: expectedReader ?? value.cacheReader ?? null,
      representation: pageRepresentation(value.context),
    };
    const queryKey = ['composed-members', request, incarnation, instance, generation] as const;
    admission.registerQuery('member-continuation', queryKey);
    activeQueryKey.current = queryKey;
    try {
      const next = await queryClient.fetchQuery({
        // A retired node/viewer reading must not share an in-flight response with its replacement.
        queryKey,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: async ({ signal }) => {
          if (signal.aborted || !isCurrent()) throw new Error('Retired member continuation');
          await Promise.resolve();
          if (signal.aborted || !isCurrent()) throw new Error('Retired member continuation');
          const result = await loadMemberList({ data: request, signal });
          if (signal.aborted || !isCurrent()) throw new Error('Retired member continuation');
          return result;
        },
      });
      if (!isCurrent()) return;
      const admitted = admitMemberSection(next);
      if (!admitted.ok) {
        setError((previous) => (isCurrent() ? admitted : previous));
        setRetryAt((previous) => (isCurrent() ? memberRetryAt(admitted.retryAfter) : previous));
        if ([401, 403, 404, 409].includes(admitted.status ?? 0)) {
          setReading((previous) => (isCurrent() ? emptyMemberReading(admitted) : previous));
          progress.current = createMemberPageProgress();
          setRestart((previous) => (isCurrent() ? false : previous));
        }
      } else {
        // A fresh restart gets fresh progress only after native admission succeeds. A transport failure keeps
        // the retained reading and repeats this exact request, including an absent cursor for a fresh restart.
        const nextProgress = cursor ? progress.current : createMemberPageProgress();
        if (!nextProgress.accept(memberPageCursor(admitted.body))) {
          setRestart((previous) => (isCurrent() ? true : previous));
          return;
        }
        progress.current = nextProgress;
        const retained = cursor ? reading : emptyMemberReading();
        const nextReading = appendMemberPage(retained, admitted, value);
        setReading((previous) => (isCurrent() ? nextReading : previous));
        setRestart((previous) => (isCurrent() ? false : previous));
        setCompletion((previous) =>
          isCurrent()
            ? {
                generation,
                added: nextReading.items.length - retained.items.length,
                exhausted: !paged || !nextReading.cursor,
                trigger: ownsFocus && trigger.ownerDocument.activeElement === trigger ? trigger : null,
              }
            : previous,
        );
      }
    } catch {
      setError((previous) => (isCurrent() ? { ok: false as const } : previous));
      setRetryAt((previous) => (isCurrent() ? undefined : previous));
    } finally {
      trigger.removeEventListener('blur', releaseFocus);
      if (isCurrent()) {
        if (activeQueryKey.current === queryKey) activeQueryKey.current = undefined;
        admission.releaseQuery('member-continuation', queryKey);
        active.current = false;
        setPending((previous) => (isCurrent() ? false : previous));
      }
    }
  }
  if (failed?.status === 404) return null;
  return (
    <section
      data-slot="member-list"
      data-node={node}
      data-retry-after={!failed?.ok ? failed?.retryAfter : undefined}
      aria-labelledby={`${instance}-title`}
      aria-busy={pending}
      className="min-w-0 space-y-4"
    >
      <h2 id={`${instance}-title`} className="text-2xl font-semibold tracking-tight">
        {title}
      </h2>
      {reading.items.length > 0 && (
        <CoverList
          items={reading.items}
          value={value}
          label={title}
          memberFacts={reading.facts}
          {...(value.memberHref
            ? { itemVisit: (item: Item) => ({ href: value.memberHref!({ id: item.id, label: item.label.text }) }) }
            : {})}
        />
      )}
      {failed && failed.status !== 202 ? (
        <p role="alert">
          {failed.status === 409
            ? m.subject_relation_changed({}, options)
            : failed.status === 400 || failed.status === 422
              ? m.subject_relation_invalid({}, options)
              : m.subject_section_failed({}, options)}
        </p>
      ) : (
        !failed &&
        !restart &&
        reading.items.length === 0 && (
          <p role="status">{cursor ? m.public_read_sparse({}, options) : m.public_read_empty({}, options)}</p>
        )
      )}
      {restart && <p role="alert">{m.member_window_cycle({}, options)}</p>}
      <p
        id={`${instance}-status`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm text-muted-foreground"
      >
        {pending
          ? m.subject_relation_loading({}, options)
          : waiting
            ? m.search_recovery_wait({}, options)
            : failed?.status === 202
              ? m.public_read_preparing({}, options)
              : completion
                ? completion.exhausted
                  ? m.subject_relation_completed_end({ label: title, count: completion.added }, options)
                  : m.subject_relation_completed_more({ label: title, count: completion.added }, options)
                : null}
      </p>
      {completion?.exhausted && (
        <p
          ref={end}
          tabIndex={-1}
          data-slot="member-list-end"
          className="rounded-sm text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {m.subject_relation_end({ label: title }, options)}
        </p>
      )}
      {value.listHref && paged && cursor && !failed && !restart ? (
        <a
          href={value.listHref(node, cursor)}
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          {m.subject_section_more({ label: title }, options)}
        </a>
      ) : (
        target &&
        continuationEnabled &&
        (restart || failed || (paged && cursor)) && (
          <button
            type="button"
            onClick={more}
            aria-disabled={pending || waiting}
            aria-describedby={`${instance}-status`}
            className={cn(
              buttonVariants({ variant: 'outline' }),
              'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            {restart
              ? m.member_window_restart({}, options)
              : failed
                ? m.subject_section_retry({}, options)
                : m.subject_section_more({ label: title }, options)}
          </button>
        )
      )}
    </section>
  );
}
