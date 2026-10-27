import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { m } from '../../paraglide/messages.js';
import { RELATION_GROUPS, type RelationDefinition } from '../../subject/relations';
import { countText, dateText, GROUP_TITLES, holderItems, Items, type Item, type RowValue } from './overview';
import { linkClass, linkColor } from './shared';

/** One page of the subject's relations: one property when `property` is given, otherwise every property. */
export type RelationsViewData = {
  /** The page's body from the kernel's inverse read: holders, count and the continuation. */
  body: Record<string, unknown>;
  property: string | null;
};

const PAGE_LIMIT = 100;

function viewHref(locale: string, subject: string, property: string | null, cursor?: string): string {
  const params = new URLSearchParams();
  if (property) params.set('property', property);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject)}/relations${query ? `?${query}` : ''}`;
}

/**
 * The full Relations view. It pages with the kernel's continuation, never a fixed slice, and groups what a page holds
 * by relation group; a property view is one list under that property's reader-side label.
 */
export function RelationsView({
  locale,
  subject,
  title,
  data,
  relations,
  value,
}: {
  locale: string;
  subject: string;
  title: string;
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
  const Link = value.link;
  const items: Item[] = (listed?.items ?? []).map((item) => {
    const entry = definition(item.property);
    const date = dateText(item.date, locale);
    return { ...item, notes: [entry?.label ?? '', date ?? ''].filter(Boolean) };
  });
  const groups = RELATION_GROUPS.flatMap((group) => {
    const members = items.filter((item) => (definition(item.property)?.group ?? 'other') === group);
    return members.length ? [{ group, members }] : [];
  });
  return (
    <section data-slot="relations-view" className="mx-auto w-full max-w-5xl min-w-0 space-y-6">
      <header className="space-y-2">
        <p className="text-sm">
          <span className={`${linkClass} ${linkColor} font-medium`}>
            <Link href={`/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject)}`}>{title}</Link>
          </span>
        </p>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-4xl font-semibold tracking-tight text-balance">{heading}</h1>
          {listed && (
            <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
              {countText(listed.count, locale)}
            </span>
          )}
        </div>
      </header>
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
            <Items items={members} value={value} ordered={group === 'order'} />
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
