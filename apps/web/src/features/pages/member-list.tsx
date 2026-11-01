import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
import { useContext, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';
import type { SubjectSummary } from '../../media/summary';
import type { Fact } from '../../search/results';
import { CoverList } from './cover-list';
import { OverviewContext, type Item, type OverviewValue, type Section } from './overview';
import { isRecord, pageText } from './shared';
import { loadMemberList, type MemberListRequest, type MemberPageTarget } from './member-list-query';

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
  const initial = value?.sections.get(node) ?? { ok: false as const };
  const target = value?.pageTarget;
  // The public shell can conceal self sources or a private curated source. Recheck with the current session BFF.
  const needsViewer = isRecord(props.source) && !initial.ok && initial.status === 404 && viewer.state === 'signed-in';
  const request = { target: target!, locale: value?.locale ?? 'en', node };
  const current = useQuery({
    ...personalRead,
    queryKey: ['composed-members-viewer', viewer.subject, request],
    enabled: personalRead.enabled && needsViewer && !!target && !!node,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => loadMemberList({ data: request }),
  });
  if (!value || !node) return null;
  if (needsViewer && target && current.isPending)
    return <p role="status">{m.subject_relation_loading({}, { locale: value.locale as never })}</p>;
  const section = needsViewer ? (current.isError ? { ok: false as const } : (current.data ?? initial)) : initial;
  return (
    <MemberList
      key={JSON.stringify([target, props, section, viewer.state, viewer.subject, value.locale])}
      value={value}
      section={section}
      node={node}
      title={pageText(props.title, value.locale).text}
      target={target}
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
  paged = true,
}: {
  value: OverviewValue;
  section: Section;
  node: string;
  title: string;
  target?: MemberPageTarget | undefined;
  paged?: boolean;
}) {
  const queryClient = useQueryClient();
  const [pages, setPages] = useState<Section[]>([section]);
  const [error, setError] = useState<Section>();
  const [pending, setPending] = useState(false);
  const [completion, setCompletion] = useState<{
    added: number;
    exhausted: boolean;
    trigger: HTMLButtonElement | null;
  }>();
  const active = useRef(false);
  const alive = useRef(true);
  const instance = useId();
  const end = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const trigger = completion?.trigger;
    // Replace only the requesting reader's removed trigger, after the exhausted page has rendered.
    if (
      completion?.exhausted &&
      trigger &&
      (trigger.ownerDocument.activeElement === trigger ||
        trigger.ownerDocument.activeElement === trigger.ownerDocument.body)
    )
      end.current?.focus({ preventScroll: true });
  }, [completion]);
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
    if (!target || active.current) return;
    const trigger = event.currentTarget;
    active.current = true;
    setPending(true);
    setError(undefined);
    setCompletion(undefined);
    const request: MemberListRequest = { target, locale: value.locale, node, ...(cursor ? { cursor } : {}) };
    try {
      const next = await queryClient.fetchQuery({
        // A retired node/viewer reading must not share an in-flight response with its replacement.
        queryKey: ['composed-members', request, instance],
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: () => loadMemberList({ data: request }),
      });
      if (!alive.current) return;
      if (!next.ok) {
        setError(next);
        if ([401, 403, 404, 409].includes(next.status ?? 0)) setPages([next]);
      } else {
        const visible = new Set(unique.keys());
        for (const item of memberItems(next, value)) visible.add(item.id);
        setPages((previous) => (cursor ? [...previous, next] : [next]));
        setCompletion({
          added: visible.size - unique.size,
          exhausted: !paged || typeof next.body.next !== 'string' || !next.body.next,
          trigger: trigger.ownerDocument.activeElement === trigger ? trigger : null,
        });
      }
    } catch {
      if (alive.current) setError({ ok: false });
    } finally {
      active.current = false;
      if (alive.current) setPending(false);
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
      {target && (failed || (paged && cursor)) && (
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
