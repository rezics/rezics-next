import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useRef, useState, type MouseEvent } from 'react';
import { PAGE_GLOBAL_CONTEXT, isView } from '@rezics/composition';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectViewHref } from '../../subject/subject-href';
import { CoverList } from './cover-list';
import { holderItems, statementItems, type Item, type OverviewValue, type Section } from './overview';
import { loadRelationGroup, relationGroupKey, type RelationGroupRequest } from './relation-stream-query';
import { subjectRequestReader } from './subject-queries';

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
}) {
  const { value, node, view } = props;
  return (
    <StreamState
      key={`${value.subject}/${value.realm ?? ''}/${value.cacheReader ?? ''}/${value.context?.id ?? 'global'}/${node}/${view}`}
      {...props}
    />
  );
}

function StreamState({
  value,
  section,
  node,
  view,
  title,
}: {
  value: OverviewValue;
  section: Section;
  node: string;
  view: string;
  title: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter({ warn: false });
  type State = {
    section: Section;
    pages: Section[];
    pending: boolean;
    error?: { status?: number | undefined } | undefined;
  };
  const initial = (): State => ({ section, pages: [section], pending: false });
  const [state, setState] = useState<State>(initial);
  // A refreshed native aggregate retires accumulated rows before they can render under its new reading.
  const current = state.section === section ? state : initial();
  if (current !== state) setState(current);
  const { pages, pending, error } = current;
  const active = useRef<Section | null>(null);
  const latest = pages[pages.length - 1];
  const cursor = latest?.ok && typeof latest.body.next === 'string' ? latest.body.next : undefined;
  const items = pages.flatMap((page) => relationStreamItems(page, value)?.items ?? []);
  const unique = new Map<string, Item>();
  for (const item of items) unique.set(item.statement ?? item.id, item);
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
    event.preventDefault();
    if (active.current === section) return;
    active.current = section;
    setState((previous) => ({ ...previous, pending: true, error: undefined }));
    try {
      const reader = await subjectRequestReader({ data: { realm } });
      if (reader !== (value.cacheReader ?? null)) throw new Error('Reading account changed');
      const request: RelationGroupRequest = {
        subject: value.subject,
        locale: value.locale,
        view: currentView,
        node,
        cursor,
        realm,
        reader,
        context: value.context?.id ?? PAGE_GLOBAL_CONTEXT,
        population: value.context?.population.kind ?? 'global',
      };
      const next = await queryClient.fetchQuery({
        queryKey: relationGroupKey(request),
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: () => loadRelationGroup({ data: request }),
      });
      setState((previous) =>
        previous.section !== section
          ? previous
          : {
              ...previous,
              pages: next.ok ? [...previous.pages, next] : [],
              error: next.ok ? undefined : { status: next.status },
            },
      );
      if (!next.ok) void router?.invalidate();
    } catch {
      setState((previous) => (previous.section !== section ? previous : { ...previous, pages: [], error: {} }));
      void router?.invalidate();
    } finally {
      if (active.current === section) active.current = null;
      setState((previous) => (previous.section !== section ? previous : { ...previous, pending: false }));
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
      <h2 id={`${node}-title`} className="text-2xl font-semibold tracking-tight">
        {title}
      </h2>
      {unique.size ? (
        <CoverList items={[...unique.values()]} value={value} label={title} />
      ) : !error ? (
        <p role="status">
          {section.ok ? m.subject_relation_empty_page({}, options) : failure(section.status, value.locale)}
        </p>
      ) : null}
      {pending && <p role="status">{m.subject_relation_loading({}, options)}</p>}
      {error && <p role="alert">{failure(error.status, value.locale)}</p>}
      {href && cursor && (
        <a
          data-slot="continue-group"
          href={href}
          onClick={more}
          aria-disabled={pending}
          className={buttonVariants({ variant: 'outline' })}
        >
          {error ? m.subject_section_retry({}, options) : m.subject_section_more({ label: title }, options)}
        </a>
      )}
      {(error || !section.ok) && base && (
        <a
          href={`${base}?${new URLSearchParams({ node, ...(realm ? { realm } : {}) })}`}
          className="text-primary underline underline-offset-4"
        >
          {m.subject_relation_restart({}, options)}
        </a>
      )}
    </section>
  );
}
