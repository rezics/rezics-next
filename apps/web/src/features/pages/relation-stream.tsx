import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { isView } from '@rezics/composition';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';
import { subjectViewHref } from '../../subject/subject-href';
import { useSession } from '../../session/query';
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

let nextRelationIncarnation = 0;
let nextSectionIncarnation = 0;
const sectionIncarnations = new WeakMap<object, number>();

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

function useReadingLifetime(onRetire: () => void) {
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
        onRetireRef.current();
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
    }),
    [],
  );
}

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

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

/** Independent state per current subject, Context and node; a More click requests just that stream. */
export function RelationStream(props: {
  value: OverviewValue;
  section: Section;
  node: string;
  view: string;
  title: string;
  titleLang?: string | undefined;
}) {
  const { value, node, view } = props;
  const viewer = useSession();
  const hasReader = value.cacheReader != null;
  const representation = pageRepresentation(value.context);
  const identity = JSON.stringify([
    value.subject,
    value.pageTarget,
    value.account ?? null,
    value.realm,
    value.cacheReader ?? null,
    hasReader ? [viewer.state, viewer.subject ?? null] : null,
    representation,
    value.locale,
    value.reader,
    node,
    view,
    sectionIncarnation(props.section),
  ]);
  return <StreamState key={identity} viewer={viewer} {...props} />;
}

function StreamState({
  value,
  viewer,
  section,
  node,
  view,
  title,
  titleLang,
}: {
  value: OverviewValue;
  viewer: ReturnType<typeof useSession>;
  section: Section;
  node: string;
  view: string;
  title: string;
  titleLang?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const router = useRouter({ warn: false });
  type State = {
    pages: Section[];
    pending: boolean;
    error?: { status?: number | undefined } | undefined;
    completion?: { added: number; exhausted: boolean; trigger: HTMLAnchorElement | null } | undefined;
  };
  const [state, setState] = useState<State>(() => ({ pages: [section], pending: false }));
  const { pages, pending, error, completion } = state;
  const end = useRef<HTMLParagraphElement>(null);
  const incarnation = useRelationIncarnation();
  const activeQueryKey = useRef<readonly unknown[] | undefined>(undefined);
  const lifetime = useReadingLifetime(() => {
    const key = activeQueryKey.current;
    activeQueryKey.current = undefined;
    if (key) void queryClient.cancelQueries({ queryKey: key, exact: true });
  });
  const readingGeneration = lifetime.generation();
  useLayoutEffect(() => {
    const trigger = completion?.trigger;
    // Only replace focus lost with the activated anchor. A reader may have moved to another stream.
    if (
      lifetime.current(readingGeneration) &&
      completion?.exhausted &&
      trigger &&
      (trigger.ownerDocument.activeElement === trigger ||
        trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
    )
      end.current?.focus({ preventScroll: true });
  }, [completion, lifetime, readingGeneration]);
  const active = useRef(false);
  const latest = pages[pages.length - 1];
  const cursor = latest?.ok && typeof latest.body.next === 'string' ? latest.body.next : undefined;
  const items = pages.flatMap((page) => relationStreamItems(page, value)?.items ?? []);
  const unique = new Map<string, Item>();
  for (const item of items) unique.set(item.statement ?? item.id, item);
  const readerUnavailable =
    value.cacheReader != null &&
    viewer.state !== 'unknown' &&
    !(viewer.state === 'signed-in' && viewer.subject === value.cacheReader);
  const continuationEnabled =
    value.cacheReader == null || (viewer.state === 'signed-in' && viewer.subject === value.cacheReader);
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
    // Keep native navigation available until this page has observed its authenticated reader.
    if (!continuationEnabled) return;
    event.preventDefault();
    if (active.current) return;
    const generation = lifetime.generation();
    if (!lifetime.current(generation)) return;
    active.current = true;
    const trigger = event.currentTarget;
    setState((previous) => ({ ...previous, pending: true, error: undefined, completion: undefined }));
    try {
      if (!lifetime.current(generation)) return;
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
      const queryKey = relationGroupKey(request, incarnation);
      activeQueryKey.current = queryKey;
      const next = await queryClient.fetchQuery({
        queryKey,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: async ({ signal }) => {
          const result = await loadRelationGroup({ data: request });
          if (signal.aborted || !lifetime.current(generation)) throw new Error('Retired relation continuation');
          return result;
        },
      });
      if (!lifetime.current(generation)) return;
      const focusTrigger = trigger.ownerDocument.activeElement === trigger ? trigger : null;
      setState((previous) => {
        if (!lifetime.current(generation)) return previous;
        const visible = new Set(
          previous.pages.flatMap((page) =>
            (relationStreamItems(page, value)?.items ?? []).map((item) => item.statement ?? item.id),
          ),
        );
        const before = visible.size;
        if (next.ok)
          for (const item of relationStreamItems(next, value)?.items ?? []) visible.add(item.statement ?? item.id);
        return {
          ...previous,
          pages: next.ok ? [...previous.pages, next] : [],
          error: next.ok ? undefined : { status: next.status },
          completion: next.ok
            ? {
                added: visible.size - before,
                exhausted: typeof next.body.next !== 'string' || !next.body.next,
                trigger: focusTrigger,
              }
            : undefined,
        };
      });
      if (!next.ok && lifetime.current(generation)) void router?.invalidate();
    } catch {
      if (lifetime.current(generation)) {
        setState((previous) =>
          lifetime.current(generation) ? { ...previous, pages: [], error: {}, completion: undefined } : previous,
        );
        if (lifetime.current(generation)) void router?.invalidate();
      }
    } finally {
      if (lifetime.current(generation)) {
        if (activeQueryKey.current?.at(-1) === incarnation) activeQueryKey.current = undefined;
        active.current = false;
        setState((previous) => (lifetime.current(generation) ? { ...previous, pending: false } : previous));
      }
    }
  }
  return (
    <section
      data-slot="relation-stream"
      data-node={node}
      aria-labelledby={`${node}-title`}
      aria-busy={pending}
      className="min-w-0 space-y-4"
    >
      <h2 id={`${node}-title`} lang={titleLang} className="text-2xl font-semibold tracking-tight">
        {title}
      </h2>
      {readerUnavailable ? (
        <p role="alert">{m.subject_relation_unavailable({}, options)}</p>
      ) : unique.size ? (
        <CoverList items={[...unique.values()]} value={value} label={title} />
      ) : !readerUnavailable && !error ? (
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
        {pending
          ? m.subject_relation_loading({}, options)
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
          data-slot="relation-stream-end"
          className="rounded-sm text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {m.subject_relation_end({ label: title }, options)}
        </p>
      )}
      {error && <p role="alert">{failure(error.status, value.locale)}</p>}
      {href && cursor && (
        <a
          data-slot="continue-group"
          href={href}
          onClick={more}
          aria-disabled={pending}
          aria-describedby={`${node}-status`}
          className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
        >
          {error ? m.subject_section_retry({}, options) : m.subject_section_more({ label: title }, options)}
        </a>
      )}
      {(error || !section.ok) && base && (
        <a
          href={`${base}?${new URLSearchParams({ node, ...(realm ? { realm } : {}) })}`}
          className={cn(buttonVariants({ variant: 'link' }), actionClass)}
        >
          {m.subject_relation_restart({}, options)}
        </a>
      )}
    </section>
  );
}
