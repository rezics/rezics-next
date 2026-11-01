import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
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

let nextMemberIncarnation = 0;
let nextSectionIncarnation = 0;
const sectionIncarnations = new WeakMap<object, number>();
const emptySection: Section = { ok: false };

function sectionIncarnation(section: Section): number {
  let incarnation = sectionIncarnations.get(section);
  if (incarnation === undefined) {
    incarnation = ++nextSectionIncarnation;
    sectionIncarnations.set(section, incarnation);
  }
  return incarnation;
}

function useMemberIncarnation(): string {
  const [incarnation] = useState(() => `members-${++nextMemberIncarnation}`);
  return incarnation;
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
  const node = typeof props.id === 'string' ? props.id : '';
  const initial = value?.sections.get(node) ?? emptySection;
  if (!value || !node) return null;
  const target = value?.pageTarget;
  const representation = pageRepresentation(value.context);
  const viewerRecovery = isRecord(props.source) && !initial.ok && initial.status === 404;
  const key = JSON.stringify([
    target,
    value.subject,
    value.account ?? null,
    props,
    sectionIncarnation(initial),
    value.cacheReader == null && !viewerRecovery ? null : [viewer.state, viewer.subject ?? null],
    value.locale,
    value.cacheReader ?? null,
    representation,
    value.reader,
  ]);
  return (
    <MemberReader
      key={key}
      value={value}
      viewer={viewer}
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
  props,
  initial,
  node,
  target,
  representation,
}: {
  value: OverviewValue;
  viewer: ReturnType<typeof useSession>;
  props: Record<string, unknown>;
  initial: Section;
  node: string;
  target?: MemberPageTarget | undefined;
  representation: ReturnType<typeof pageRepresentation>;
}) {
  const queryClient = useQueryClient();
  const incarnation = useMemberIncarnation();
  // The public shell can conceal self sources or a private curated source. Recheck only for an observed viewer.
  const needsViewer =
    isRecord(props.source) &&
    !initial.ok &&
    initial.status === 404 &&
    viewer.state === 'signed-in' &&
    typeof viewer.subject === 'string' &&
    viewer.subject.length > 0;
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
  const lifetime = useReadingLifetime(() => {
    void queryClient.cancelQueries({ queryKey, exact: true });
  });
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
    enabled: personalRead.enabled && needsViewer && !!target && !!node,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      // QueryObserver subscribes during commit. Let layout setup and StrictMode effect replay finish before
      // admitting transport, then bind this request to the generation that actually started it.
      const generation = lifetime.generation();
      await Promise.resolve();
      if (signal.aborted || !lifetime.current(generation)) throw new Error('Retired member recovery');
      const result = await loadMemberList({ data: request });
      if (signal.aborted || !lifetime.current(generation)) throw new Error('Retired member recovery');
      return result;
    },
  });
  if (needsViewer && target && current.isPending)
    return <p role="status">{m.subject_relation_loading({}, { locale: value.locale as never })}</p>;
  const section: Section = needsViewer ? (current.isError ? { ok: false } : (current.data ?? initial)) : initial;
  const continuationEnabled =
    value.cacheReader == null || (viewer.state === 'signed-in' && viewer.subject === value.cacheReader);
  // An anonymous public page has no viewer provenance by design. A known private page cannot outlive its reader.
  if (
    value.cacheReader &&
    viewer.state !== 'unknown' &&
    !(viewer.state === 'signed-in' && viewer.subject === value.cacheReader)
  )
    return <p role="alert">{m.subject_relation_unavailable({}, { locale: value.locale as never })}</p>;
  return (
    <MemberList
      value={value}
      section={section}
      node={node}
      title={pageText(props.title, value.locale).text}
      target={target}
      expectedReader={recoveryReader}
      continuationEnabled={continuationEnabled}
      viewerIdentity={JSON.stringify([viewer.state, viewer.subject ?? null])}
      paged={props.paged === true}
    />
  );
}

/** Each node owns its cursor, pending request and retained pages. Errors never turn into an empty success. */
export function MemberList({
  value,
  section,
  node,
  title,
  target,
  expectedReader,
  continuationEnabled = true,
  viewerIdentity = '',
  paged = true,
}: {
  value: OverviewValue;
  section: Section;
  node: string;
  title: string;
  target?: MemberPageTarget | undefined;
  expectedReader?: string | null | undefined;
  continuationEnabled?: boolean;
  viewerIdentity?: string;
  paged?: boolean;
}) {
  const queryClient = useQueryClient();
  const [pages, setPages] = useState<Section[]>([section]);
  const [error, setError] = useState<Section>();
  const [pending, setPending] = useState(false);
  const [completion, setCompletion] = useState<{
    generation: number;
    added: number;
    exhausted: boolean;
    trigger: HTMLButtonElement | null;
  }>();
  const active = useRef(false);
  const instance = useId();
  const incarnation = useMemberIncarnation();
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
  }, [lifetime, viewerIdentity]);
  const end = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const trigger = completion?.trigger;
    // Replace only the requesting reader's removed trigger, after the exhausted page has rendered.
    if (
      completion &&
      lifetime.current(completion.generation) &&
      completion?.exhausted &&
      trigger &&
      (trigger.ownerDocument.activeElement === trigger ||
        trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
    )
      end.current?.focus({ preventScroll: true });
  }, [completion, lifetime]);
  const latest = pages.at(-1)!;
  const cursor = latest.ok && typeof latest.body.next === 'string' ? latest.body.next : undefined;
  const failed = error && !error.ok ? error : !latest.ok ? latest : undefined;
  const options = { locale: value.locale as never };
  const items = pages.flatMap((page) => memberItems(page, value));
  // The native cursor is opaque; a repeated canonical row is shown once without changing the remaining order.
  const memberFacts: Record<string, Record<string, Fact[]>> = {};
  for (const page of pages) {
    if (!page.ok) continue;
    const rows = page.read.kind === 'search' ? page.body.subjects : page.body.members;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.facts)) continue;
      const id = page.read.kind === 'search' ? row.id : row.subjectId;
      if (typeof id === 'string' && !Object.hasOwn(memberFacts, id))
        memberFacts[id] = row.facts as Record<string, Fact[]>;
    }
  }
  const unique = new Map<string, Item>();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
  async function more(event: MouseEvent<HTMLButtonElement>) {
    if (!continuationEnabled || !target || active.current) return;
    const generation = lifetime.generation();
    if (!lifetime.current(generation)) return;
    const trigger = event.currentTarget;
    active.current = true;
    setPending(true);
    setError(undefined);
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
    activeQueryKey.current = queryKey;
    try {
      const next = await queryClient.fetchQuery({
        // A retired node/viewer reading must not share an in-flight response with its replacement.
        queryKey,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: async ({ signal }) => {
          const result = await loadMemberList({ data: request });
          if (signal.aborted || !lifetime.current(generation)) throw new Error('Retired member continuation');
          return result;
        },
      });
      if (!lifetime.current(generation)) return;
      if (!next.ok) {
        setError((previous) => (lifetime.current(generation) ? next : previous));
        if ([401, 403, 404, 409].includes(next.status ?? 0))
          setPages((previous) => (lifetime.current(generation) ? [next] : previous));
      } else {
        const visible = new Set(unique.keys());
        for (const item of memberItems(next, value)) visible.add(item.id);
        setPages((previous) => (lifetime.current(generation) ? (cursor ? [...previous, next] : [next]) : previous));
        setCompletion((previous) =>
          lifetime.current(generation)
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
      setError((previous) => (lifetime.current(generation) ? { ok: false as const } : previous));
    } finally {
      if (lifetime.current(generation)) {
        if (activeQueryKey.current === queryKey) activeQueryKey.current = undefined;
        active.current = false;
        setPending((previous) => (lifetime.current(generation) ? false : previous));
      }
    }
  }
  if (failed?.status === 404) return null;
  return (
    <section
      data-slot="member-list"
      data-node={node}
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
        !failed && unique.size === 0 && <p>{m.subject_relation_empty_page({}, options)}</p>
      )}
      <p
        id={`${instance}-status`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm text-muted-foreground"
      >
        {pending
          ? m.subject_relation_loading({}, options)
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
      {target && continuationEnabled && (failed || (paged && cursor)) && (
        <button
          type="button"
          onClick={more}
          aria-disabled={pending}
          aria-describedby={`${instance}-status`}
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          {failed ? m.subject_section_retry({}, options) : m.subject_section_more({ label: title }, options)}
        </button>
      )}
    </section>
  );
}
