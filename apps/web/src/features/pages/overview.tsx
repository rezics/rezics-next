import { useOperation } from '../../kernel/exposure';
import { pickLanguage, type PageRead } from '@rezics/composition';
import { Cover as CoverFrame, type CoverRatio } from '@rezics/ui/cover';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { createContext, useContext, type ReactNode } from 'react';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../../media/summary';
import { m } from '../../paraglide/messages.js';
import { originalLanguage } from '../../subject/language';
import { RELATION_GROUPS, type RelationDefinition, type RelationGroup } from '../../subject/relations';
import type { Reader } from '../../subject/reader';
import type { Related, Subject, Summary as SubjectCover } from '../../subject/types';
import { subjectViewHref } from '../../subject/subject-href';
import type { AccountProfile } from './account-read';
import { CoverList } from './cover-list';
import { listView } from './views';
import {
  bestRank,
  ExternalValue,
  isRecord,
  linkClass,
  linkColor,
  pageText,
  spoilerLevel,
  webUrl,
  type PageLink,
  type Sources,
  type Stmt,
} from './shared';
import { DocumentValue, LanguageTag, readableDocument, SpoilerGate, type ValueLabels } from './values';

/** What one node's read returned: its planned descriptor and body, or the fact that it did not succeed. */
export type Section = { ok: false } | { ok: true; read: PageRead; body: Record<string, unknown>; sources?: Sources };

export type OverviewValue = {
  locale: string;
  subject: string | null;
  subjectLabel?: string;
  /** The account an agent page is for, and the address of its overview. */
  account?: { id: string; handle: string };
  agentBase?: string;
  /** The account's public profile, when the page's account read succeeded. */
  profile?: AccountProfile;
  link: PageLink;
  reader: Reader;
  labels: ValueLabels;
  /** The frame a Zone's appearance fixes for every row. */
  ratio?: CoverRatio;
  /** The frame the page subject's type declares, for its own cover. */
  frameRatio?: CoverRatio;
  unlabelled: string;
  spoilerShow: string;
  details: string;
  cover: string;
  coverVia: string;
  source: string;
  sources: string;
  sections: Map<string, Section>;
  /**
   * What About holds after the summary, when the page places a `Summary`: the key facts of its first `Statements`
   * node, which then renders nothing itself, and the subject's tags.
   */
  about?: { statements: string; facts: ReactNode; tags: ReactNode };
  /** How each relation property reads on this page, from the definition release; absent properties have no label. */
  relations: Record<string, RelationDefinition>;
  /** Every `RelationGroups` node of the page in document order; the first one renders all of them by group. */
  relationNodes: { id: string; props: Record<string, unknown> }[];
};

export const OverviewContext = createContext<OverviewValue | null>(null);

const SUMMARY_PROPERTY = 'schema:abstract';
export const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
export const sectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';

/** What a row of related subjects needs from its page; the full relations view supplies the same fields. */
export type RowValue = Pick<
  OverviewValue,
  'locale' | 'link' | 'reader' | 'labels' | 'unlabelled' | 'spoilerShow' | 'ratio'
>;

type SubjectRead = { subject: Subject; related: Related; summary?: SubjectCover | null };
export type Item = {
  id: string;
  label: ReturnType<typeof pageText>;
  summary?: SubjectSummary;
  type?: string;
  /** Qualifier text such as a role or the credited name. */
  notes: string[];
  gated: boolean;
  /** The property a relation read found the item by, and the holder's date when the read carries one. */
  property?: string;
  date?: string;
};
export type Count = { value: number; exact: boolean };

function hasMore(count: Count, returned: number): boolean {
  return !count.exact || count.value > returned;
}

export function useOverview(id: unknown): { value: OverviewValue; section: Section | undefined } | null {
  const value = useContext(OverviewContext);
  if (!value) return null;
  return { value, section: value.sections.get(typeof id === 'string' ? id : '') };
}

function subjectRead(section: Section | undefined): SubjectRead | undefined {
  if (!section?.ok || section.read.kind !== 'subject') return;
  const { body } = section;
  return isRecord(body.subject) && isRecord(body.related) ? (body as unknown as SubjectRead) : undefined;
}

export function countText(count: Count, locale: string): string {
  return m.home_section_count(
    { count: `${new Intl.NumberFormat(locale).format(count.value)}${count.exact ? '' : '+'}` },
    { locale: locale as never },
  );
}

export function viewHref(value: OverviewValue, view: string, property?: string): string | null {
  if (
    value.agentBase !== undefined &&
    property === undefined &&
    (view === 'posts' || view === 'reviews' || view === 'collections')
  )
    return `${value.agentBase}/${view}`;
  return value.subject
    ? subjectViewHref(
        { id: value.subject, label: value.subjectLabel || value.unlabelled },
        value.locale,
        view,
        property === undefined ? '' : `?property=${encodeURIComponent(property)}`,
      )
    : null;
}

/** A date in the kernel's partial ISO form, shown at its own precision; any other form is left out. */
export function dateText(value: unknown, locale: string): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(-?\d{4,})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2] ?? 1) - 1, Number(match[3] ?? 1));
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    ...(match[2] ? { month: 'long' } : {}),
    ...(match[3] ? { day: 'numeric' } : {}),
  }).format(date);
}

/** The year of a date in the kernel's partial ISO form: the one secondary line a card has room for. */
export function yearText(value: unknown, locale: string): string | null {
  const year = typeof value === 'string' ? /^-?\d{4,}/.exec(value)?.[0] : undefined;
  return year === undefined ? null : dateText(year, locale);
}

/** The holders of a read with their year as the secondary line, when the read carries a date. */
function datedItems(items: Item[], locale: string): Item[] {
  return items.map((item) => {
    const year = yearText(item.date, locale);
    return year ? { ...item, notes: [year] } : item;
  });
}

/** A preview section: a heading with its count, then the body, then a link to the full view when there is more. */
export function Preview({
  slot,
  id,
  title,
  titleLang,
  count,
  more,
  href,
  locale,
  children,
}: {
  slot: string;
  id: string;
  title: string;
  titleLang?: string | undefined;
  count?: Count | undefined;
  more: boolean;
  href: string | null;
  locale: string;
  children: ReactNode;
}) {
  return (
    <section data-slot={slot} aria-labelledby={`${id}-title`} className={sectionClass}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={`${id}-title`} lang={titleLang} className={headingClass}>
            {title}
          </h2>
          {count && (
            <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
              {countText(count, locale)}
            </span>
          )}
        </div>
        {more && href && (
          <a
            data-slot="see-all"
            href={href}
            aria-describedby={`${id}-title`}
            className={`${linkClass} ${linkColor} text-sm font-medium hover:underline`}
          >
            {m.home_see_all({}, { locale: locale as never })}
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

/** A section whose read did not succeed says so with a retry; the rest of the page is unaffected. */
export function Failed({ slot, id, title, locale }: { slot: string; id: string; title: string; locale: string }) {
  const options = { locale: locale as never };
  return (
    <section data-slot={slot} data-state="failed" aria-labelledby={`${id}-title`} className={sectionClass}>
      <h2 id={`${id}-title`} className={headingClass}>
        {title}
      </h2>
      <p role="status" className="text-sm text-muted-foreground">
        {m.subject_section_failed({}, options)}
      </p>
      <a data-slot="retry" href="?" className={`${linkClass} ${linkColor} text-sm font-medium hover:underline`}>
        {m.subject_section_retry({}, options)}
      </a>
    </section>
  );
}

function limitOf(props: Record<string, unknown>): number {
  return typeof props.limit === 'number' && props.limit >= 1 ? props.limit : 12;
}

/** The holders a `links` read returned, in the kernel's order. */
function linkItems(section: Section | undefined, limit: number): { items: Item[]; count: Count } | undefined {
  if (!section?.ok || section.read.kind !== 'links') return;
  return holderItems(section.body, limit);
}

/** The holders in the body of a `links` read, with its exact or "at least" count. */
export function holderItems(body: Record<string, unknown>, limit: number): { items: Item[]; count: Count } | undefined {
  if (!Array.isArray(body.links)) return;
  const links = body.links.filter(isRecord).slice(0, limit);
  const count = isRecord(body.count) ? body.count : undefined;
  const items = links.flatMap((link): Item[] =>
    typeof link.subject === 'string'
      ? [
          {
            id: link.subject,
            label: { text: typeof link.label === 'string' ? link.label : '', lang: undefined },
            ...(isRecord(link.summary) ? { summary: link.summary as unknown as SubjectSummary } : {}),
            ...(typeof link.type === 'string' ? { type: link.type } : {}),
            ...(typeof link.property === 'string' ? { property: link.property } : {}),
            ...(typeof link.date === 'string' ? { date: link.date } : {}),
            notes: [],
            gated: false,
          },
        ]
      : [],
  );
  return {
    items,
    count: {
      value: typeof count?.value === 'number' ? Math.max(count.value, items.length) : items.length,
      exact: count ? count.exact === true : true,
    },
  };
}

/** What a qualifier shows in the reading view: an item as its label, text as itself; anything else stays out. */
function noteOf(qualifier: Stmt['qualifiers'][number], related: Related, locale: string): string | null {
  const { value, property } = qualifier;
  if (value.type !== 'value') return null;
  const content = value.content;
  if (property.data_type === 'wikibase-item' && typeof content === 'string') {
    const entry = Object.hasOwn(related, content) ? related[content] : undefined;
    return pageText(entry?.labels, locale).text || null;
  }
  if (property.data_type === 'monolingualtext' && isRecord(content) && typeof content.language === 'string')
    return pageText({ [content.language]: content.text }, locale).text || null;
  if (property.data_type === 'string' && typeof content === 'string' && content !== '') return content;
  return null;
}

/** The statements the page subject holds for one property, shown as items with their qualifiers. */
function statementItems(
  section: Section | undefined,
  property: unknown,
  limit: number,
  value: OverviewValue,
): { items: Item[]; count: Count } | undefined {
  const read = subjectRead(section);
  if (!read || typeof property !== 'string') return;
  const held = Object.hasOwn(read.subject.statements, property) ? read.subject.statements[property] : undefined;
  const statements = bestRank((held ?? []) as unknown as Stmt[]).filter(
    (statement) =>
      statement.value.type === 'value' &&
      statement.property.data_type === 'wikibase-item' &&
      typeof statement.value.content === 'string',
  );
  const items = statements.slice(0, limit).map((statement): Item => {
    const target = statement.value.content as string;
    const entry = Object.hasOwn(read.related, target) ? read.related[target] : undefined;
    return {
      id: entry?.redirect ?? target,
      label: pageText(entry?.labels, value.locale),
      notes: statement.qualifiers.flatMap((qualifier) => {
        const note = noteOf(qualifier, read.related, value.locale);
        return note === null ? [] : [note];
      }),
      gated: spoilerLevel(statement) > value.reader.spoilerLevel,
    };
  });
  return { items, count: { value: statements.length, exact: true } };
}

function LinkSection(props: Record<string, unknown>, slot: string, title: string, view: string, forward: boolean) {
  const state = useOverview(props.id);
  if (!state) return null;
  const { value, section } = state;
  const id = String(props.id);
  if (!section?.ok) return <Failed slot={slot} id={id} title={title} locale={value.locale} />;
  const limit = limitOf(props);
  const found = forward ? statementItems(section, props.property, limit, value) : linkItems(section, limit);
  if (!found) return <Failed slot={slot} id={id} title={title} locale={value.locale} />;
  if (found.items.length === 0) return null;
  const listed = forward ? found : { ...found, items: datedItems(found.items, value.locale) };
  const text = pageText(props.title, value.locale);
  return (
    <Preview
      slot={slot}
      id={id}
      title={text.text || title}
      titleLang={text.text ? text.lang : undefined}
      count={listed.count}
      more={props.paged !== true && hasMore(listed.count, listed.items.length)}
      href={viewHref(value, view)}
      locale={value.locale}
    >
      <CoverList items={listed.items} value={value} label={text.text || title} preview />
    </Preview>
  );
}

export const GROUP_TITLES: Record<RelationGroup, (options: { locale: never }) => string> = {
  order: (options) => m.subject_relation_group_order({}, options),
  derivation: (options) => m.subject_relation_group_derivation({}, options),
  world: (options) => m.subject_relation_group_world({}, options),
  membership: (options) => m.subject_relation_group_membership({}, options),
  association: (options) => m.subject_relation_group_association({}, options),
  other: (options) => m.subject_relation_group_other({}, options),
};

type RelationEntry = { property: string; label: string; group: RelationGroup; items: Item[]; count: Count };

/**
 * The relations of the page, grouped by relation group. Each `RelationGroups` node reads one property; the first
 * renders them all so a group gathers its properties wherever the template placed them. Items keep the kernel's
 * order, which follows each property's declared key.
 */
export function RelationGroups(props: Record<string, unknown>) {
  const state = useOverview(props.id);
  if (!state) return null;
  const { value } = state;
  const nodes = value.relationNodes.length ? value.relationNodes : [{ id: String(props.id), props }];
  if (nodes[0]!.id !== props.id) return null;
  const options = { locale: value.locale as never };
  const title = pageText(props.title, value.locale);
  const heading = title.text || m.subject_relations({}, options);
  const id = String(props.id);

  const entries: RelationEntry[] = [];
  let failed = 0;
  for (const node of nodes) {
    const section = value.sections.get(node.id);
    const listed = linkItems(section, limitOf(node.props));
    if (!listed) {
      failed += 1;
      continue;
    }
    const property = typeof node.props.property === 'string' ? node.props.property : '';
    const definition = Object.hasOwn(value.relations, property) ? value.relations[property] : undefined;
    if (listed.items.length > 0)
      entries.push({
        property,
        label: definition?.label ?? '',
        group: definition?.group ?? 'other',
        items: listed.items,
        count: listed.count,
      });
  }
  if (failed === nodes.length) return <Failed slot="relation-groups" id={id} title={heading} locale={value.locale} />;
  if (entries.length === 0 && failed === 0) return null;

  const groups = RELATION_GROUPS.flatMap((group) => {
    const members = entries.filter((entry) => entry.group === group);
    return members.length ? [{ group, members }] : [];
  });
  const total: Count = {
    value: entries.reduce((sum, entry) => sum + entry.count.value, 0),
    exact: entries.every((entry) => entry.count.exact),
  };
  return (
    <section data-slot="relation-groups" aria-labelledby={`${id}-title`} className={`${sectionClass} space-y-6`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-title`} lang={title.text ? title.lang : undefined} className={headingClass}>
          {heading}
        </h2>
        <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
          {countText(total, value.locale)}
        </span>
      </div>
      {groups.map(({ group, members }) => {
        const items = members.flatMap((entry) =>
          entry.items.map((item): Item => {
            const year = yearText(item.date, value.locale);
            return { ...item, notes: [entry.label, year ?? ''].filter(Boolean) };
          }),
        );
        const count: Count = {
          value: members.reduce((sum, entry) => sum + entry.count.value, 0),
          exact: members.every((entry) => entry.count.exact),
        };
        const more = members.filter((entry) => hasMore(entry.count, entry.items.length));
        return (
          <div key={group} data-slot="relation-group" data-group={group} className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                {groups.length > 1 && (
                  <h3 className="text-lg font-semibold tracking-tight">{GROUP_TITLES[group](options)}</h3>
                )}
                {groups.length > 1 && (
                  <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
                    {countText(count, value.locale)}
                  </span>
                )}
              </div>
              {more.map((entry) => {
                const href = viewHref(value, 'relations', entry.property);
                return (
                  href && (
                    <a
                      key={entry.property}
                      data-slot="see-all"
                      href={href}
                      className={`${linkClass} ${linkColor} text-sm font-medium hover:underline`}
                    >
                      {entry.label
                        ? m.subject_relation_see_all({ label: entry.label }, options)
                        : m.home_see_all({}, options)}
                    </a>
                  )
                );
              })}
            </div>
            <CoverList
              items={items}
              value={value}
              label={groups.length > 1 ? GROUP_TITLES[group](options) : heading}
              preview
            />
          </div>
        );
      })}
      {failed > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.subject_section_failed({}, options)}{' '}
          <a data-slot="retry" href="?" className={`${linkClass} ${linkColor} font-medium hover:underline`}>
            {m.subject_section_retry({}, options)}
          </a>
        </p>
      )}
    </section>
  );
}

/** A list of the subjects whose statement of one property points at the page subject, in the property's declared order. */
export function SubjectList(props: Record<string, unknown>) {
  const state = useOverview(props.id);
  if (!state) return null;
  const { value, section } = state;
  const id = String(props.id);
  const title = pageText(props.title, value.locale);
  const found = linkItems(section, limitOf(props));
  if (!found) return <Failed slot="subject-list" id={id} title={title.text} locale={value.locale} />;
  if (found.items.length === 0) return null;
  const listed = { ...found, items: datedItems(found.items, value.locale) };
  return (
    <Preview
      slot="subject-list"
      id={id}
      title={title.text}
      titleLang={title.lang}
      count={listed.count}
      more={hasMore(listed.count, listed.items.length)}
      href={viewHref(value, 'relations', typeof props.property === 'string' ? props.property : undefined)}
      locale={value.locale}
    >
      <CoverList items={listed.items} value={value} label={title.text} preview />
    </Preview>
  );
}

export function Appearances(props: Record<string, unknown>) {
  const locale = useContext(OverviewContext)?.locale ?? 'en';
  return LinkSection(
    props,
    'appearances',
    m.subject_characters({}, { locale: locale as never }),
    'characters',
    props.direction === 'forward',
  );
}

export function Credits(props: Record<string, unknown>) {
  const locale = useContext(OverviewContext)?.locale ?? 'en';
  return LinkSection(
    props,
    'credits',
    m.subject_credits({}, { locale: locale as never }),
    'credits',
    props.direction === 'forward',
  );
}

export function CollectionList(props: Record<string, unknown>) {
  const readable = useOperation('collection.get');
  const state = useOverview(props.id);
  if (!state) return null;
  const { value, section } = state;
  const id = String(props.id);
  const title = pageText(props.title, value.locale);
  if (!section?.ok || section.read.kind !== 'collections' || !Array.isArray(section.body.collections))
    return <Failed slot="collection-list" id={id} title={title.text} locale={value.locale} />;
  const collections = section.body.collections.filter(isRecord).slice(0, limitOf(props));
  if (collections.length === 0) return null;
  const counted = isRecord(section.body.count) && typeof section.body.count.value === 'number';
  const total = counted
    ? Math.max((section.body.count as { value: number }).value, collections.length)
    : collections.length;
  const Link = value.link;
  return (
    <Preview
      slot="collection-list"
      id={id}
      title={title.text}
      titleLang={title.lang}
      count={{ value: total, exact: true }}
      more={props.paged !== true && hasMore({ value: total, exact: true }, collections.length)}
      href={viewHref(value, 'lists')}
      locale={value.locale}
    >
      <ul className="space-y-2 break-words leading-7">
        {collections.map((collection, index) => {
          const curator = isRecord(collection.curator) ? collection.curator : undefined;
          const name =
            typeof curator?.displayName === 'string' && curator.displayName
              ? curator.displayName
              : typeof curator?.handle === 'string' && curator.handle
                ? `@${curator.handle}`
                : '';
          const options = { locale: value.locale as never };
          return (
            <li key={typeof collection.id === 'string' ? collection.id : index}>
              <span className={`${linkClass} ${linkColor} font-medium`}>
                {readable ? (
                  <Link
                    href={`/${encodeURIComponent(value.locale)}/collections/${encodeURIComponent(String(collection.id))}`}
                  >
                    {typeof collection.title === 'string' && collection.title ? collection.title : value.unlabelled}
                  </Link>
                ) : typeof collection.title === 'string' && collection.title ? (
                  collection.title
                ) : (
                  value.unlabelled
                )}
              </span>
              {name && (
                <span className="text-sm text-muted-foreground"> · {m.subject_collection_by({ name }, options)}</span>
              )}
              {typeof collection.multiplicity === 'number' && collection.multiplicity > 1 && (
                <span className="text-sm text-muted-foreground">
                  {' · '}
                  {m.library_subject_multiplicity({ count: collection.multiplicity }, options)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Preview>
  );
}

export function Cover(props: Record<string, unknown>) {
  const state = useOverview(props.id);
  if (!state) return null;
  const { value, section } = state;
  if (!section) return null;
  const read = subjectRead(section);
  if (!read) return <Failed slot="subject-cover" id={String(props.id)} title={value.cover} locale={value.locale} />;
  const original = originalLanguage(read.subject);
  const title = pageText(read.subject.labels, value.locale, original).text || value.unlabelled;
  return (
    <div data-slot="subject-cover" className="w-60 max-w-full">
      <CoverFrame
        subject={coverSubject(read.subject.id, title, read.summary, read.subject.type)}
        cover={coverOf(read.summary)}
        size="lg"
        src={coverSrc}
        suitability={value.reader.suitability}
        labels={value.labels.cover}
        priority
        caption
        {...((value.frameRatio ?? value.ratio) ? { ratio: (value.frameRatio ?? value.ratio)! } : {})}
      />
    </div>
  );
}

/** The summary the reader's language chain reaches first, with the statement that holds it. */
export function chosenSummary(subject: Subject, locale: string) {
  const held = Object.hasOwn(subject.statements, SUMMARY_PROPERTY) ? subject.statements[SUMMARY_PROPERTY] : undefined;
  const documents = bestRank((held ?? []) as unknown as Stmt[]).flatMap((statement) => {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    const document = isRecord(content) ? readableDocument(content.document) : undefined;
    return isRecord(content) && document && typeof content.language === 'string'
      ? [{ statement, document, language: content.language }]
      : [];
  });
  if (documents.length === 0) return undefined;
  const language = pickLanguage(
    documents.map((entry) => entry.language),
    locale,
    originalLanguage(subject),
  );
  return documents.find((entry) => entry.language === language) ?? documents[0]!;
}

/**
 * About: the summary, or the description when there is no summary, then the key facts and the tags. A summary above
 * the reader's spoiler level waits behind a reveal.
 */
export function Summary(props: Record<string, unknown>) {
  const state = useOverview(props.id);
  if (!state) return null;
  const { value, section } = state;
  if (!section) return null;
  const id = String(props.id);
  const title = m.subject_about({}, { locale: value.locale as never });
  const read = subjectRead(section);
  if (!read) return <Failed slot="subject-summary" id={id} title={title} locale={value.locale} />;
  const chosen = chosenSummary(read.subject, value.locale);
  const description = chosen
    ? undefined
    : pageText(read.subject.descriptions, value.locale, originalLanguage(read.subject));
  const { facts = null, tags = null } = value.about ?? {};
  if (!chosen && !description?.text && !facts && !tags) return null;
  const body = chosen && (
    <div className="space-y-1">
      <DocumentValue
        document={chosen.document}
        lang={chosen.language === value.locale ? undefined : chosen.language}
        labels={value.labels}
      />
      <LanguageTag lang={chosen.language} locale={value.locale} />
    </div>
  );
  return (
    <section data-slot="subject-summary" aria-labelledby={`${id}-title`} className={sectionClass}>
      <h2 id={`${id}-title`} className={headingClass}>
        {title}
      </h2>
      {chosen &&
        (spoilerLevel(chosen.statement) > value.reader.spoilerLevel ? (
          <SpoilerGate label={value.spoilerShow}>{body}</SpoilerGate>
        ) : (
          body
        ))}
      {description?.text && (
        <div className="space-y-1">
          <p lang={description.lang} className="max-w-prose text-pretty leading-7">
            {description.text}
          </p>
          <LanguageTag lang={description.lang} locale={value.locale} />
        </div>
      )}
      {facts}
      {tags}
    </section>
  );
}

function Unavailable({
  slot,
  id,
  title,
  text,
  view,
}: {
  slot: string;
  id: unknown;
  title: string;
  text: string;
  view: string;
}) {
  const value = useContext(OverviewContext);
  if (!value) return null;
  const href = viewHref(value, view);
  const key = typeof id === 'string' ? id : slot;
  return (
    <section data-slot={slot} data-state="unavailable" aria-labelledby={`${key}-title`} className={sectionClass}>
      <h2 id={`${key}-title`} className={headingClass}>
        {title}
      </h2>
      <Empty className="border p-6">
        <EmptyHeader>
          <EmptyTitle className="sr-only">{title}</EmptyTitle>
          <EmptyDescription>{text}</EmptyDescription>
        </EmptyHeader>
        {href && (
          <a href={href} className={`${linkClass} ${linkColor} text-sm font-medium hover:underline`}>
            {title}
          </a>
        )}
      </Empty>
    </section>
  );
}

export function RatingSummary(props: Record<string, unknown>) {
  const locale = (useContext(OverviewContext)?.locale ?? 'en') as never;
  return (
    <Unavailable
      slot="rating-summary"
      id={props.id}
      title={m.subject_ratings({}, { locale })}
      text={m.subject_ratings_unavailable({}, { locale })}
      view="reviews"
    />
  );
}

export function ThreadList(props: Record<string, unknown>) {
  const locale = (useContext(OverviewContext)?.locale ?? 'en') as never;
  return (
    <Unavailable
      slot="thread-list"
      id={props.id}
      title={m.subject_discussion({}, { locale })}
      text={m.subject_threads_unavailable({}, { locale })}
      view="discussion"
    />
  );
}

export function ReviewList(props: Record<string, unknown>) {
  const locale = (useContext(OverviewContext)?.locale ?? 'en') as never;
  return (
    <Unavailable
      slot="review-list"
      id={props.id}
      title={m.subject_reviews({}, { locale })}
      text={m.subject_reviews_unavailable({}, { locale })}
      view="reviews"
    />
  );
}

/** Cover credit, fact sources and external identifiers, then a link to Details. */
export function SourcesSection({
  value,
  sources,
  id = 'subject-sources',
}: {
  value: OverviewValue;
  sources: Sources;
  id?: string;
}) {
  const Link = value.link;
  const credit = sources.credit;
  const details = viewHref(value, 'details');
  return (
    <section
      data-slot="subject-sources"
      aria-labelledby={id}
      className="min-w-0 space-y-3 border-t border-border/60 pt-6"
    >
      <h2 id={id} className={headingClass}>
        {value.sources}
      </h2>
      <ul className="space-y-1 text-sm break-words">
        {credit && (
          <li>
            <span className="me-2 font-medium text-muted-foreground">{value.cover}</span>© {credit.rightsHolder}
            {credit.via && (
              <>
                {' · '}
                {value.coverVia}{' '}
                {webUrl(credit.via.url) ? (
                  <a className={`${linkClass} ${linkColor}`} href={credit.via.url}>
                    {credit.via.name}
                  </a>
                ) : (
                  credit.via.name
                )}
              </>
            )}
            {credit.license ? ` · ${credit.license}` : null}
          </li>
        )}
        {sources.urls.map((url) => (
          <li key={url}>
            <span className="me-2 font-medium text-muted-foreground">{value.source}</span>
            <ExternalValue value={url} />
          </li>
        ))}
        {sources.identifiers.map(({ label, value: identifier }, index) => (
          <li key={index}>
            <span lang={label.lang} className="me-2 font-medium text-muted-foreground">
              {label.text || value.unlabelled}
            </span>
            {identifier}
          </li>
        ))}
      </ul>
      {details && (
        <p className={`${linkClass} ${linkColor} text-sm font-medium`}>
          <Link href={details}>{value.details}</Link>
        </p>
      )}
    </section>
  );
}

export function Sources(props: Record<string, unknown>) {
  const state = useOverview(props.id);
  if (!state?.section) return null;
  const { value, section } = state;
  const id = String(props.id);
  if (!section.ok || !section.sources)
    return <Failed slot="subject-sources" id={id} title={value.sources} locale={value.locale} />;
  return <SourcesSection value={value} sources={section.sources} id={`${id}-title`} />;
}
