import type { KernelClient } from '@rezics/client';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { RELATION_GROUPS, type RelationDefinition } from '../../subject/relations';
import { CoverList } from './cover-list';
import { countText, GROUP_TITLES, holderItems, yearText, type Item, type RowValue } from './overview';
import { ViewHeading } from './subject-frame';
import { loadSubjectPage } from './subject';
import { subjectViewHref, type SubjectHrefInput } from '../../subject/subject-href';

/** One page of the subject's relations: one property when `property` is given, otherwise every property. */
export type RelationsViewData = {
  /** The page's body from the kernel's inverse read: holders, count and the continuation. */
  body: Record<string, unknown>;
  property: string | null;
};

const PAGE_LIMIT = 100;

/**
 * The reads of the Relations view: the subject's overview page, which carries the subject for the frame and the
 * previews that count the tabs, and one page of the inverse read.
 */
export async function readRelationsPage(
  client: KernelClient,
  input: { id: string; locale?: string | undefined; property?: string | undefined; cursor?: string | undefined },
) {
  const [overview, links] = await Promise.all([
    loadSubjectPage(client, input.id, undefined, input.locale ?? 'en'),
    client.subjects({ id: input.id }).links.get({
      query: {
        limit: PAGE_LIMIT,
        ...(input.property ? { property: input.property } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
    }),
  ]);
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
        label={heading}
        count={
          listed && (
            <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
              {countText(listed.count, locale)}
            </span>
          )
        }
      />
      {!listed ? (
        <Empty className="border" role="alert" data-state="failed">
          <EmptyHeader>
            <EmptyTitle className="text-base font-normal">{m.subject_section_failed({}, options)}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : items.length === 0 ? null : (
        groups.map(({ group, members }) => (
          <div key={group} data-slot="relation-group" data-group={group} className="min-w-0 space-y-3">
            {groups.length > 1 && (
              <h2 className="text-lg font-semibold tracking-tight">{GROUP_TITLES[group](options)}</h2>
            )}
            <CoverList items={members} value={value} label={heading} />
          </div>
        ))
      )}
      {next && (
        <a
          data-slot="next-page"
          href={viewHref(locale, subject, data.property, next)}
          className={buttonVariants({ variant: 'outline' })}
        >
          {m.subject_relations_more({}, options)}
        </a>
      )}
    </section>
  );
}

export { PAGE_LIMIT as RELATIONS_PAGE_LIMIT };
