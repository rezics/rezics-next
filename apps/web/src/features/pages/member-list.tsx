import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
import { useContext, useRef, useState } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
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
  const needsViewer =
    isRecord(props.source) && !initial.ok && initial.status === 404 && viewer.state === 'signed-in';
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
      key={JSON.stringify([target, props, section, viewer.subject])}
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
  const active = useRef(false);
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
  async function more() {
    if (!target || active.current) return;
    active.current = true;
    setPending(true);
    setError(undefined);
    const request: MemberListRequest = { target, locale: value.locale, node, ...(cursor ? { cursor } : {}) };
    try {
      const next = await queryClient.fetchQuery({
        queryKey: ['composed-members', request],
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: () => loadMemberList({ data: request }),
      });
      if (!next.ok) {
        setError(next);
        if ([401, 403, 404, 409].includes(next.status ?? 0)) setPages([next]);
      } else if (cursor) setPages((previous) => [...previous, next]);
      else setPages([next]);
    } catch {
      setError({ ok: false });
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  if (failed?.status === 404) return null;
  return (
    <section
      data-slot="member-list"
      data-node={node}
      aria-labelledby={`${node}-title`}
      aria-busy={pending}
      className="min-w-0 space-y-4"
    >
      <h2 id={`${node}-title`} className="text-2xl font-semibold tracking-tight">
        {title}
      </h2>
      {unique.size > 0 && (
        <CoverList items={[...unique.values()]} value={value} label={title} memberFacts={memberFacts} />
      )}
      {failed ? (
        <p role={failed.status === 202 ? 'status' : 'alert'}>
          {failed.status === 202
            ? m.collection_filter_preparing({}, options)
            : failed.status === 409
              ? m.subject_relation_changed({}, options)
              : failed.status === 400 || failed.status === 422
                ? m.subject_relation_invalid({}, options)
                : m.subject_section_failed({}, options)}
        </p>
      ) : (
        unique.size === 0 && <p role="status">{m.subject_relation_empty_page({}, options)}</p>
      )}
      {pending && <p role="status">{m.subject_relation_loading({}, options)}</p>}
      {target && (failed || (paged && cursor)) && (
        <button type="button" onClick={more} disabled={pending} className={buttonVariants({ variant: 'outline' })}>
          {failed ? m.subject_section_retry({}, options) : m.subject_relations_more({}, options)}
        </button>
      )}
    </section>
  );
}
