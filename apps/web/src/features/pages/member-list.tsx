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

/** Preserve native member order and fields. Common-members already canonicalizes; no per-row reads. */
export function memberItems(section: Section, value: OverviewValue): Item[] {
  if (!section.ok) return [];
  const rows = section.read.kind === 'search' ? section.body.subjects : section.body.members;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const id = section.read.kind === 'search' ? row.id : row.subjectId;
    if (typeof id !== 'string') return [];
    const summary =
      isRecord(row.subject) && row.subject.id === id ? row.subject : isRecord(row.summary) ? row.summary : undefined;
    const nativeLabel = summary?.label;
    const label =
      isRecord(nativeLabel) && typeof nativeLabel.value === 'string'
        ? { text: nativeLabel.value, lang: typeof nativeLabel.language === 'string' ? nativeLabel.language : undefined }
        : typeof nativeLabel === 'string'
          ? { text: nativeLabel, lang: undefined }
          : pageText(row.labels, value.locale);
    return [
      {
        id,
        label,
        ...(typeof summary?.type === 'string'
          ? { type: summary.type }
          : typeof row.type === 'string'
            ? { type: row.type }
            : {}),
        ...(summary ? { summary: summary as SubjectSummary } : {}),
        notes: [],
        gated: false,
      },
    ];
  });
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
        result = await loadMemberList({ data: request });
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

/** Each node retains one native page (at most its planned limit), including its native facts. */
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
  const [page, setPage] = useState(section);
  const [restart, setRestart] = useState(false);
  const progress = useRef(createMemberPageProgress(section.ok ? memberPageCursor(section.body) : undefined));
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
    if (key) void queryClient.cancelQueries({ queryKey: key, exact: true });
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
  useLayoutEffect(() => {
    const trigger = completion?.trigger;
    // Replace only the requesting reader's removed trigger, after the exhausted page has rendered.
    if (
      completion &&
      lifetime.current(completion.generation) &&
      admission.current(incarnation) &&
      completion?.exhausted &&
      trigger &&
      (trigger.ownerDocument.activeElement === trigger ||
        trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
    )
      end.current?.focus({ preventScroll: true });
  }, [completion, lifetime, admission, incarnation]);
  const cursor = !restart && page.ok ? memberPageCursor(page.body) : undefined;
  const failed = error && !error.ok ? error : !page.ok ? page : undefined;
  const options = { locale: value.locale as never };
  const items = memberItems(page, value);
  // The native cursor is opaque; a repeated canonical row is shown once without changing the remaining order.
  const memberFacts: Record<string, Record<string, Fact[]>> = {};
  if (page.ok) {
    const rows = page.read.kind === 'search' ? page.body.subjects : page.body.members;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isRecord(row) || !isRecord(row.facts)) continue;
      const id = page.read.kind === 'search' ? row.id : row.subjectId;
      if (typeof id === 'string' && !Object.hasOwn(memberFacts, id))
        memberFacts[id] = row.facts as Record<string, Fact[]>;
    }
  }
  const unique = new Map<string, Item>();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
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
    const queryKey = ['composed-members', request, incarnation, generation] as const;
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
          const result = await loadMemberList({ data: request });
          if (signal.aborted || !isCurrent()) throw new Error('Retired member continuation');
          return result;
        },
      });
      if (!isCurrent()) return;
      if (!next.ok) {
        setError((previous) => (isCurrent() ? next : previous));
        setRetryAt((previous) => (isCurrent() ? memberRetryAt(next.retryAfter) : previous));
        if ([401, 403, 404, 409].includes(next.status ?? 0)) {
          setPage((previous) => (isCurrent() ? next : previous));
          progress.current = createMemberPageProgress();
          setRestart((previous) => (isCurrent() ? false : previous));
        }
      } else {
        // A fresh restart gets fresh progress only after native admission succeeds. A transport failure keeps
        // the accepted window and repeats this exact request, including an absent cursor for a fresh restart.
        const nextProgress = cursor ? progress.current : createMemberPageProgress();
        if (!nextProgress.accept(memberPageCursor(next.body))) {
          setRestart((previous) => (isCurrent() ? true : previous));
          return;
        }
        progress.current = nextProgress;
        const visible = new Set(unique.keys());
        for (const item of memberItems(next, value)) visible.add(item.id);
        setPage((previous) => (isCurrent() ? next : previous));
        setRestart((previous) => (isCurrent() ? false : previous));
        setCompletion((previous) =>
          isCurrent()
            ? {
                generation,
                added: visible.size - unique.size,
                exhausted: !paged || typeof next.body.next !== 'string' || !next.body.next,
                trigger: trigger.ownerDocument.activeElement === trigger ? trigger : null,
              }
            : previous,
        );
      }
    } catch {
      setError((previous) => (isCurrent() ? { ok: false as const } : previous));
      setRetryAt((previous) => (isCurrent() ? undefined : previous));
    } finally {
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
      {unique.size > 0 && (
        <CoverList items={[...unique.values()]} value={value} label={title} memberFacts={memberFacts} />
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
        !failed && !restart && unique.size === 0 && <p>{m.subject_relation_empty_page({}, options)}</p>
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
              ? m.collection_filter_preparing({}, options)
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
      {target && continuationEnabled && (restart || failed || (paged && cursor)) && (
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
      )}
    </section>
  );
}
