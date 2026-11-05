import type { KernelClient } from '@rezics/client';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { RELATION_GROUPS, type RelationDefinition } from '../../subject/relations';
import { CoverList } from './cover-list';
import { GROUP_TITLES, holderItems, yearText, type Item, type RowValue } from './overview';
import { formatCount } from '../count';
import { ViewHeading } from './subject-frame';
import { loadSubjectPage } from './subject';
import { subjectViewHref, type SubjectHrefInput } from '../../subject/subject-href';
import { fieldLabel } from './shared';

/** One page of the subject's relations: one property when `property` is given, otherwise every property. */
export type RelationsViewData = {
  /** The page's body from the kernel's inverse read: holders, count and the continuation. */
  body: Record<string, unknown>;
  property: string | null;
};

const PAGE_LIMIT = 100;
const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] px-4 py-3 text-center focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * The reads of the Relations view: the subject's overview page, which carries the subject for the frame and the
 * previews that count the tabs, and one page of the inverse read.
 */
export async function readRelationsPage(
  client: KernelClient,
  input: { id: string; locale?: string | undefined; property?: string | undefined; cursor?: string | undefined },
) {
  const overview = await loadSubjectPage(client, input.id, undefined, input.locale ?? 'en');
  if (overview.kind !== 'page') return { overview, links: null };
  const links = await client.subjects({ id: input.id }).links.get({
    query: {
      limit: PAGE_LIMIT,
      ...(input.property ? { property: input.property } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  });
  return { overview, links };
}

function viewHref(locale: string, subject: SubjectHrefInput, property: string | null, cursor?: string): string {
  const params = new URLSearchParams();
  if (property) params.set('property', property);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return subjectViewHref(subject, locale, 'relations', query ? `?${query}` : '');
}

/**
 * The full Relations view. It pages with the kernel's continuation, never a fixed slice, and groups what a page holds
 * by relation group; a property view is one list under that property's reader-side label.
 */
export function RelationsView({
  locale,
  subject,
  frame,
  data,
  relations,
  value,
}: {
  locale: string;
  subject: SubjectHrefInput;
  /** The subject's compact header and the view tabs. */
  frame: ReactNode;
  data: RelationsViewData;
  relations: Record<string, RelationDefinition>;
  value: RowValue;
}) {
  const options = { locale: locale as never };
  const listed = holderItems(data.body, PAGE_LIMIT);
  const next = typeof data.body.next === 'string' && data.body.next ? data.body.next : null;
  const definition = (property: string | undefined) =>
    property !== undefined && Object.hasOwn(relations, property) ? relations[property] : undefined;
  const heading = data.property
    ? (definition(data.property)?.label ?? m.subject_relations({}, options))
    : m.subject_relations({}, options);
  const fieldHeading = data.property ? fieldLabel({ text: heading }, locale).text : heading;
  const items: Item[] = (listed?.items ?? []).map((item) => {
    const entry = definition(item.property);
    const year = yearText(item.date, locale);
    return { ...item, notes: [entry?.label ?? '', year ?? ''].filter(Boolean) };
  });
  const groups = RELATION_GROUPS.flatMap((group) => {
    const members = items.filter((item) => (definition(item.property)?.group ?? 'other') === group);
    return members.length ? [{ group, members }] : [];
  });
  return (
    <section data-slot="relations-view" className="mx-auto w-full max-w-5xl min-w-0 space-y-6">
      {frame}
      <ViewHeading
        label={fieldHeading}
        count={
          listed?.count && (
            <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
              {formatCount(listed.count, locale)}
            </span>
          )
        }
      />
      {!listed ? (
        <>
          <Empty className="border" role="alert" data-state="failed">
            <EmptyHeader>
              <EmptyTitle className="text-base font-normal">{m.subject_section_failed({}, options)}</EmptyTitle>
            </EmptyHeader>
          </Empty>
          <a
            data-slot="restart-page"
            href={viewHref(locale, subject, data.property)}
            className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
          >
            {m.subject_relation_restart({}, options)}
          </a>
        </>
      ) : items.length === 0 ? (
        <Empty className="border" role="status" data-state="empty">
          <EmptyHeader>
            <EmptyTitle className="text-base font-normal">{m.subject_relation_empty_page({}, options)}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        groups.map(({ group, members }) => (
          <div key={group} data-slot="relation-group" data-group={group} className="min-w-0 space-y-3">
            {groups.length > 1 && (
              <h2 className="text-lg font-semibold tracking-tight">{GROUP_TITLES[group](options)}</h2>
            )}
            <CoverList items={members} value={{ ...value, subject: subject.id }} label={heading} />
          </div>
        ))
      )}
      {next && (
        <a
          data-slot="next-page"
          href={viewHref(locale, subject, data.property, next)}
          className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
        >
          {m.subject_relations_more({}, options)}
        </a>
      )}
    </section>
  );
}

export { PAGE_LIMIT as RELATIONS_PAGE_LIMIT };
