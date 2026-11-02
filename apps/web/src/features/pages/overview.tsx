import type { MemberPageTarget } from './member-list-query';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { createServerFn } from '@tanstack/react-start';
import { PAGE_GLOBAL_CONTEXT, type SelectedContext } from '@rezics/composition';
import { useOperation } from '../../kernel/exposure';
import { RatingsSection } from './subject-ratings-view';
import { SubjectCommunityRegion, useSubjectCommunity } from './subject-community-view';
import { composedCommunityRegion } from './subject-community';
import { pickLanguage, type PageRead } from '@rezics/composition';
import {
  Cover as CoverFrame,
  coverIncarnation,
  resolveCoverVariants,
  usableCoverVariants,
  useIncarnationState,
  type CoverRatio,
} from '@rezics/ui/cover';
import { MetaLine } from '@rezics/ui/meta-line';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { CoverViewer } from '@rezics/ui/cover-viewer';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { createContext, useContext, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
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
import { listView, readerViewLabel } from './views';
import { RelationStream } from './relation-stream';
import { qualifiedNotes, type QualifiedNote } from './qualified-relations';
import { relationPreviewCount } from './subject-relations-preview';
import { relationItemRows } from './relation-item-identity';
import { collectionListValue } from './collection-list-value';
import {
  bestRank,
  ExternalValue,
  fieldLabel,
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
import { statementDocument } from './documents';
import { readPublicSubjectDocument } from './subject-queries';
import { DocumentValue, LanguageTag, readableDocument, SpoilerGate, type ValueLabels } from './values';
import { DescriptionPassage, SubjectPassage } from './subject-passage';
import {
  createSubjectTextRetryController,
  SubjectReadingState,
  type SubjectTextRetryToken,
} from '../../subject/reading-state';
import { kernelClient } from '../../kernel/client';
import { countFromLinks, formatCount, sumCounts, type Count } from '../count';
export type { Count } from '../count';

/** What one node's read returned: its planned descriptor and body, or the fact that it did not succeed. */
export type Section =
  | { ok: false; status?: number | undefined }
  | { ok: true; read: PageRead; body: Record<string, unknown>; sources?: Sources };

/** The page representation a continuation must retain while extending one native stream. */
export type PageRepresentation = {
  context: string;
  population: 'global' | 'realm';
  populationId?: string;
};

export function pageRepresentation(context?: SelectedContext): PageRepresentation {
  if (context?.population.kind === 'realm')
    return { context: context.id, population: 'realm', populationId: context.population.id };
  return { context: context?.id ?? PAGE_GLOBAL_CONTEXT, population: 'global' };
}

export type OverviewValue = {
  locale: string;
  pageTarget?: MemberPageTarget | undefined;
  context?: SelectedContext;
  realm?: string | undefined;
  cacheReader?: string | null | undefined;
  subject: string | null;
  subjectLabel?: string;
  /** The account an agent page is for, and the address of its overview. */
  account?: { id: string; handle: string };
  agentBase?: string;
  /** The account's public profile, when the page's account read succeeded. */
  profile?: AccountProfile;
  operator?: { id: string; handle: string | null; displayName: string | null };
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
  licence: string;
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

const readPublicSummaryDocument = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (!isRecord(value) || typeof value.documentId !== 'string' || typeof value.locale !== 'string')
      throw new TypeError('Invalid public summary document request');
    return { documentId: value.documentId, locale: value.locale };
  })
  .handler(async ({ data }) => {
    try {
      const result = await kernelClient(data.locale)
        .documents({ id: data.documentId })
        .get({
          fetch: { redirect: 'manual' },
        });
      if (result.status !== 200 || !result.data) return { kind: 'failed' as const };
      const document = result.data.document;
      return {
        kind: 'read' as const,
        document: {
          id: document.id,
          subjectId: document.subjectId,
          candidateId: document.candidateId,
          digest: document.digest,
          language: document.language,
          availability: document.availability,
          body: document.body,
        },
      };
    } catch {
      return { kind: 'failed' as const };
    }
  });

export const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
export const sectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';
const anchorClass = 'scroll-mt-32';
const sectionTitleClass = `${headingClass} min-w-0 max-w-full [overflow-wrap:anywhere]`;
const sectionActionClass = `${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-sm font-medium whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

/** What a row of related subjects needs from its page; the full relations view supplies the same fields. */
export type RowValue = Pick<
  OverviewValue,
  'locale' | 'link' | 'reader' | 'labels' | 'unlabelled' | 'spoilerShow' | 'ratio' | 'context'
>;

type SubjectRead = { subject: Subject; related: Related; documents?: unknown; summary?: SubjectCover | null };
export type Item = {
  id: string;
  label: ReturnType<typeof pageText>;
  summary?: SubjectSummary;
  type?: string;
  /** Qualifier text such as a role or the credited name. */
  notes: string[];
  qualified?: QualifiedNote[];
  statement?: string | undefined;
  gated: boolean;
  /** The property a relation read found the item by, and the holder's date when the read carries one. */
  property?: string;
  date?: string;
};
function hasMore(count: Count | undefined, returned: number): boolean {
  return count !== undefined && (count.relation === 'lower_bound' || count.value > returned);
}

export function useOverview(id: unknown): { value: OverviewValue; section: Section | undefined } | null {
  const value = useContext(OverviewContext);
  if (!value) return null;
  return { value, section: value.sections.get(typeof id === 'string' ? id : '') };
}

function subjectRead(section: Section | undefined): SubjectRead | undefined {
  if (!section?.ok || section.read.kind !== 'subject') return;
  const { body } = section;
  return isRecord(body.subject) && body.subject.id === section.read.id && isRecord(body.related)
    ? (body as unknown as SubjectRead)
    : undefined;
}

export function viewHref(value: OverviewValue, view: string, property?: string): string | null {
  if (
    value.agentBase !== undefined &&
    property === undefined &&
    (view === 'posts' || view === 'reviews' || view === 'collections')
  )
    return `${value.agentBase}/${view}`;
  const href = value.subject
    ? subjectViewHref(
        { id: value.subject, label: value.subjectLabel || value.unlabelled },
        value.locale,
        view,
        property === undefined ? '' : `?property=${encodeURIComponent(property)}`,
      )
    : null;
  const realm = value.realm ?? (value.context?.population.kind === 'realm' ? value.context.population.id : undefined);
  if (!href || !realm) return href;
  return `${href}${href.includes('?') ? '&' : '?'}realm=${encodeURIComponent(realm)}`;
}

/** A native continuation belongs to exactly one configured node/property stream. */
function StreamLink({
  value,
  view,
  node,
  cursor,
  title,
}: {
  value: OverviewValue;
  view: string;
  node: string;
  cursor?: string;
  title?: string;
}) {
  const base = viewHref(value, view);
  if (!base) return null;
  const query = new URLSearchParams({ node, ...(cursor ? { cursor } : {}) });
  return (
    <a
      data-slot={cursor ? 'continue-stream' : 'restart-stream'}
      className={linkClass}
      href={`${base}${base.includes('?') ? '&' : '?'}${query}`}
    >
      {cursor
        ? m.subject_section_more(
            {
              label:
                title ||
                readerViewLabel(view, value.locale) ||
                m.subject_relations({}, { locale: value.locale as never }),
            },
            { locale: value.locale as never },
          )
        : m.subject_relation_restart({}, { locale: value.locale as never })}
    </a>
  );
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
    return year ? { ...item, notes: [...item.notes, year] } : item;
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
    <section id={id} data-slot={slot} aria-labelledby={`${id}-title`} className={`${sectionClass} ${anchorClass}`}>
      <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
        <div className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-3 gap-y-1 sm:flex-1">
          <h2 id={`${id}-title`} lang={titleLang} className={sectionTitleClass}>
            {title}
          </h2>
          {count && (
            <span
              data-slot="count"
              className="max-w-full text-sm text-muted-foreground tabular-nums [overflow-wrap:anywhere]"
            >
              {formatCount(count, locale)}
            </span>
          )}
        </div>
        {more && href && (
          <a data-slot="see-all" href={href} aria-describedby={`${id}-title`} className={sectionActionClass}>
            {m.subject_view_all({ label: title }, { locale: locale as never })}
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

/** A section whose read did not succeed says so with a retry; the rest of the page is unaffected. */
export function Failed({
  slot,
  id,
  title,
  titleLang,
  locale,
}: {
  slot: string;
  id: string;
  title: string;
  titleLang?: string | undefined;
  locale: string;
}) {
  const options = { locale: locale as never };
  return (
    <section
      id={id}
      data-slot={slot}
      data-state="failed"
      aria-labelledby={`${id}-title`}
      className={`${sectionClass} ${anchorClass}`}
    >
      <h2 id={`${id}-title`} lang={titleLang} className={sectionTitleClass}>
        {title}
      </h2>
      <p id={`${id}-status`} role="status" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {m.subject_section_failed({}, options)}
      </p>
      <a
        data-slot="retry"
        href=""
        role="link"
        aria-describedby={`${id}-title ${id}-status`}
        className={sectionActionClass}
      >
        {m.subject_section_retry({}, options)}
      </a>
    </section>
  );
}

function limitOf(props: Record<string, unknown>): number {
  return typeof props.limit === 'number' && props.limit >= 1 ? Math.min(props.limit, 12) : 12;
}

/** The holders a `links` read returned, in the kernel's order. */
function linkItems(
  section: Section | undefined,
  limit: number,
  value?: OverviewValue,
): { items: Item[]; count?: Count; more: boolean } | undefined {
  if (!section?.ok || section.read.kind !== 'links') return;
  return holderItems(section.body, limit, value?.locale, value?.reader.spoilerLevel);
}

/** The holders in the body of a `links` read, with its exact or "at least" count. */
export function holderItems(
  body: Record<string, unknown>,
  limit: number,
  locale = 'en',
  readerLevel = 0,
): { items: Item[]; count?: Count; more: boolean } | undefined {
  const rows = relationItemRows(body.links, 'links');
  if (!rows) return;
  const links = rows.slice(0, limit);
  const count = isRecord(body.count) ? body.count : undefined;
  const items = links.flatMap((link): Item[] =>
    typeof link.subject === 'string' && link.summary !== null
      ? [
          {
            id: link.subject,
            label: { text: typeof link.label === 'string' ? link.label : '', lang: undefined },
            ...(isRecord(link.summary) ? { summary: link.summary as unknown as SubjectSummary } : {}),
            ...(typeof link.type === 'string' ? { type: link.type } : {}),
            ...(typeof link.property === 'string' ? { property: link.property } : {}),
            ...(typeof link.date === 'string' ? { date: link.date } : {}),
            statement:
              typeof link.statement === 'string'
                ? link.statement
                : isRecord(link.assertion) && typeof link.assertion.id === 'string'
                  ? link.assertion.id
                  : undefined,
            notes: [],
            ...(isRecord(link.assertion) && Array.isArray(link.assertion.qualifiers)
              ? { qualified: qualifiedNotes(link.assertion as unknown as Stmt, link.related, locale) }
              : {}),
            gated:
              isRecord(link.assertion) && Array.isArray(link.assertion.qualifiers)
                ? spoilerLevel(link.assertion as unknown as Stmt) > readerLevel
                : false,
          },
        ]
      : [],
  );
  const total = countFromLinks(
    typeof count?.value === 'number' ? { value: count.value, exact: count.exact === true } : undefined,
    rows.length,
  );
  return {
    items,
    ...(total ? { count: total } : {}),
    more: hasMore(total, items.length) || body.next != null || rows.length > items.length,
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
export function statementItems(
  section: Section | undefined,
  property: unknown,
  limit: number,
  value: OverviewValue,
): { items: Item[]; count: Count | undefined; more?: boolean } | undefined {
  if (section?.ok && section.read.kind === 'relations') {
    const rows = relationItemRows(section.body.relations, 'relations');
    if (!rows) return;
    const items = rows.slice(0, limit).flatMap((row): Item[] => {
      if (typeof row.target !== 'string' || !isRecord(row.statement) || !isRecord(row.summary)) return [];
      const statement = row.statement;

      return [
        {
          id: row.target,
          label: { text: typeof row.label === 'string' ? row.label : '', lang: undefined },
          ...(typeof row.type === 'string' ? { type: row.type } : {}),
          statement: typeof statement.id === 'string' ? statement.id : undefined,
          ...(isRecord(row.summary) ? { summary: row.summary as unknown as SubjectSummary } : {}),
          notes: [],
          qualified: qualifiedNotes(statement as unknown as Stmt, row.related, value.locale),
          gated: spoilerLevel(statement as unknown as Stmt) > value.reader.spoilerLevel,
        },
      ];
    });
    const count =
      isRecord(section.body.count) && typeof section.body.count.value === 'number'
        ? countFromLinks({ value: section.body.count.value, exact: section.body.count.exact === true }, items.length)
        : undefined;
    return {
      items,
      count,
      more: hasMore(count, items.length) || typeof section.body.next === 'string' || rows.length > limit,
    };
  }
  const read = subjectRead(section);
  if (!read || typeof property !== 'string') return;
  const held = Object.hasOwn(read.subject.statements, property) ? read.subject.statements[property] : undefined;
  const candidates = (held ?? []) as unknown as Stmt[];
  const statements = (read.subject.relationCounts ? candidates : bestRank(candidates)).filter(
    (statement) =>
      statement.rank !== 'deprecated' &&
      statement.value.type === 'value' &&
      statement.property.data_type === 'wikibase-item' &&
      typeof statement.value.content === 'string',
  );
  const items = statements.slice(0, limit).flatMap((statement): Item[] => {
    const target = statement.value.content as string;
    const entry = Object.hasOwn(read.related, target) ? read.related[target] : undefined;
    if (!entry) return [];
    return [
      {
        id: entry.redirect ?? target,
        label: pageText(entry.labels, value.locale),
        statement: statement.id,
        ...(entry.type ? { type: entry.type } : {}),
        ...(entry.type
          ? {
              summary: {
                id: entry.redirect ?? target,
                type: entry.type,
                ...(entry.types ? { types: entry.types } : {}),
                label: { value: pageText(entry.labels, value.locale).text, language: value.locale },
                ...(entry.cover ? { cover: entry.cover } : {}),
              },
            }
          : {}),
        notes: [],
        qualified: qualifiedNotes(
          statement,
          Object.fromEntries(
            Object.entries(read.related).map(([id, related]) => [
              id,
              { id: related.redirect ?? id, label: { value: pageText(related.labels, value.locale).text } },
            ]),
          ),
          value.locale,
        ),
        gated: spoilerLevel(statement) > value.reader.spoilerLevel,
      },
    ];
  });
  const count = relationPreviewCount(read.subject as unknown as Record<string, unknown>, property);
  return { items, count, more: count ? hasMore(count, items.length) : statements.length > 0 };
}

function LinkSection(
  props: Record<string, unknown>,
  slot: string,
  title: string,
  view: string,
  forward: boolean,
  propertyView?: string,
) {
  const state = useOverview(props.id);
  if (!state) return null;
  const { value, section } = state;
  const id = String(props.id);
  const definition = typeof props.property === 'string' ? value.relations[props.property] : undefined;
  // A routed reader destination has a familiar name; property labels still qualify its rows.
  title =
    (forward ? definition?.forwardReaderLabel : definition?.readerLabel) ||
    title ||
    fieldLabel({ text: (forward ? definition?.forwardLabel : definition?.label) || '' }, value.locale).text ||
    readerViewLabel(view, value.locale) ||
    value.unlabelled;
  const text = pageText(props.title, value.locale);
  if (props.paged === true)
    return (
      <RelationStream
        value={value}
        section={section ?? { ok: false }}
        node={id}
        view={view}
        title={text.text || title}
        titleLang={text.lang}
      />
    );
  if (!section?.ok)
    return (
      <>
        <Failed slot={slot} id={id} title={text.text || title} titleLang={text.lang} locale={value.locale} />
        {props.paged === true && <StreamLink value={value} view={view} node={id} />}
      </>
    );
  const limit = props.paged === true ? Number.POSITIVE_INFINITY : limitOf(props);
  const found = forward ? statementItems(section, props.property, limit, value) : linkItems(section, limit, value);
  if (!found)
    return <Failed slot={slot} id={id} title={text.text || title} titleLang={text.lang} locale={value.locale} />;
  if (found.items.length === 0 && !found.more && !found.count?.value && props.paged !== true) return null;
  const listed = forward ? found : { ...found, items: datedItems(found.items, value.locale) };
  return (
    <Preview
      slot={slot}
      id={id}
      title={text.text || title}
      titleLang={text.text ? text.lang : undefined}
      count={listed.count}
      more={props.paged !== true && (listed.more ?? hasMore(listed.count, listed.items.length))}
      href={viewHref(value, view, propertyView)}
      locale={value.locale}
    >
      {listed.items.length === 0 && (
        <p role="status">{m.subject_relation_empty_page({}, { locale: value.locale as never })}</p>
      )}
      <CoverList items={listed.items} value={value} label={text.text || title} preview={props.paged !== true} />
      {props.paged === true && section.ok && typeof section.body.next === 'string' && (
        <StreamLink value={value} view={view} node={id} cursor={section.body.next} title={text.text || title} />
      )}
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

type RelationEntry = { property: string; label: string; group: RelationGroup; items: Item[]; more: boolean };

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
  const heading = nodes.length > 1 ? m.subject_relations({}, options) : title.text || m.subject_relations({}, options);
  const id = String(props.id);
  if (nodes.some((node) => node.props.paged === true))
    return (
      <div className="space-y-8">
        {nodes.map((node) => {
          const section = value.sections.get(node.id);
          const property = String(node.props.property ?? '');
          const text = pageText(node.props.title, value.locale);
          const definition = value.relations[property];
          const forward = section?.ok && section.read.kind === 'relations';
          const title =
            text.text ||
            (forward ? definition?.forwardReaderLabel : definition?.readerLabel) ||
            fieldLabel({ text: (forward ? definition?.forwardLabel : definition?.label) || '' }, value.locale).text ||
            heading;
          return (
            <RelationStream
              key={node.id}
              value={value}
              section={section ?? { ok: false }}
              node={node.id}
              view="relations"
              title={title}
              titleLang={text.lang}
            />
          );
        })}
      </div>
    );

  const entries: RelationEntry[] = [];
  const groupParts = new Map<RelationGroup, (Count | undefined)[]>();
  const totalParts: (Count | undefined)[] = [];
  let failed = 0;
  for (const node of nodes) {
    const section = value.sections.get(node.id);
    const property = typeof node.props.property === 'string' ? node.props.property : '';
    const definition = Object.hasOwn(value.relations, property) ? value.relations[property] : undefined;
    const group = definition?.group ?? 'other';
    const listed = linkItems(
      section,
      node.props.paged === true ? Number.POSITIVE_INFINITY : limitOf(node.props),
      value,
    );
    if (!listed) {
      failed += 1;
      const parts = groupParts.get(group) ?? [];
      parts.push(undefined);
      groupParts.set(group, parts);
      totalParts.push(undefined);
      continue;
    }
    const parts = groupParts.get(group) ?? [];
    parts.push(listed.count);
    groupParts.set(group, parts);
    totalParts.push(listed.count);
    if (listed.items.length > 0)
      entries.push({
        property,
        label: pageText(node.props.title, value.locale).text || definition?.readerLabel || definition?.label || '',
        group,
        items: listed.items,
        more: listed.more,
      });
  }
  if (failed === nodes.length) return <Failed slot="relation-groups" id={id} title={heading} locale={value.locale} />;
  if (entries.length === 0 && failed === 0) return null;

  const groups = RELATION_GROUPS.flatMap((group) => {
    const members = entries.filter((entry) => entry.group === group);
    return members.length ? [{ group, members }] : [];
  });
  const total = sumCounts(totalParts);
  return (
    <section
      id={id}
      data-slot="relation-groups"
      aria-labelledby={`${id}-title`}
      className={`${sectionClass} ${anchorClass}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-title`} lang={title.text ? title.lang : undefined} className={headingClass}>
          {heading}
        </h2>
        {total && (
          <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
            {formatCount(total, value.locale)}
          </span>
        )}
      </div>
      {groups.map(({ group, members }) => {
        const items = members.flatMap((entry) =>
          entry.items.map((item): Item => {
            const year = yearText(item.date, value.locale);
            return { ...item, notes: [entry.label, ...item.notes, year ?? ''].filter(Boolean) };
          }),
        );
        const count = sumCounts(groupParts.get(group) ?? []);
        const more = members.filter((entry) => entry.more);
        return (
          <div key={group} data-slot="relation-group" data-group={group} className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                {groups.length > 1 && (
                  <h3 className="text-lg font-semibold tracking-tight">{GROUP_TITLES[group](options)}</h3>
                )}
                {groups.length > 1 && count && (
                  <span data-slot="count" className="text-sm text-muted-foreground tabular-nums">
                    {formatCount(count, value.locale)}
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
          <a data-slot="retry" href="" className={`${linkClass} ${linkColor} font-medium hover:underline`}>
            {m.subject_section_retry({}, options)}
          </a>
        </p>
      )}
    </section>
  );
}

/** A list of the subjects whose statement of one property points at the page subject, in the property's declared order. */
export function SubjectList(props: Record<string, unknown>) {
  const view = listView(props.property);
  return LinkSection(
    props,
    'subject-list',
    '',
    view ?? 'relations',
    false,
    !view && typeof props.property === 'string' ? props.property : undefined,
  );
}

export function Appearances(props: Record<string, unknown>) {
  const locale = useContext(OverviewContext)?.locale ?? 'en';
  return LinkSection(
    props,
    'appearances',
    props.direction === 'forward'
      ? m.subject_characters({}, { locale: locale as never })
      : m.subject_appearances({}, { locale: locale as never }),
    props.direction === 'forward' ? 'characters' : 'appearances',
    props.direction === 'forward',
  );
}

export function Credits(props: Record<string, unknown>) {
  const locale = useContext(OverviewContext)?.locale ?? 'en';
  return LinkSection(
    props,
    'credits',
    props.direction === 'forward'
      ? m.subject_credits({}, { locale: locale as never })
      : m.subject_works({}, { locale: locale as never }),
    props.direction === 'forward' ? 'credits' : 'works',
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
  const heading = title.text || m.subject_lists({}, { locale: value.locale as never });
  const page = section?.ok && section.read.kind === 'collections' ? collectionListValue(section.body) : undefined;
  if (!page)
    return <Failed slot="collection-list" id={id} title={heading} titleLang={title.lang} locale={value.locale} />;
  const allCollections = page.collections;
  const collections = props.paged === true ? allCollections : allCollections.slice(0, limitOf(props));
  if (collections.length === 0) return null;
  const count = countFromLinks(page.count, collections.length);
  const more =
    typeof page.next === 'string' || allCollections.length > collections.length || hasMore(count, collections.length);
  const Link = value.link;
  return (
    <Preview
      slot="collection-list"
      id={id}
      title={heading}
      titleLang={title.lang}
      count={count}
      more={props.paged !== true && more}
      href={viewHref(value, 'lists')}
      locale={value.locale}
    >
      <ul className="space-y-2">
        {collections.map((collection) => {
          const curator = collection.curator;
          const name = curator?.displayName ? curator.displayName : curator?.handle ? `@${curator.handle}` : '';
          const options = { locale: value.locale as never };
          const collectionTitle = collection.title || value.unlabelled;
          const multiplicity =
            collection.multiplicity > 1
              ? m.library_subject_multiplicity({ count: collection.multiplicity }, options)
              : null;
          return (
            <li key={collection.id}>
              <ContentItemFrame as="div" className={`min-w-0 py-3 sm:py-4${readable ? '' : ' before:hidden'}`}>
                <ContentItemHeading
                  level={3}
                  className="min-w-0 text-[17px] leading-snug font-semibold [overflow-wrap:anywhere] sm:text-lg md:text-xl"
                >
                  {readable ? (
                    <ContentItemTitleLink
                      as={Link}
                      className={`block min-h-11 content-center rounded-sm ${linkClass} ${linkColor} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                      href={`/${encodeURIComponent(value.locale)}/collections/${encodeURIComponent(collection.id)}`}
                    >
                      {collectionTitle}
                    </ContentItemTitleLink>
                  ) : (
                    collectionTitle
                  )}
                </ContentItemHeading>
                {(name !== '' || multiplicity !== null) && (
                  <div
                    data-content-item-slot="metadata"
                    className="mt-2 text-[13px] leading-snug text-muted-foreground [overflow-wrap:anywhere] sm:text-sm"
                  >
                    <MetaLine items={[name ? m.subject_collection_by({ name }, options) : null, multiplicity]} />
                  </div>
                )}
              </ContentItemFrame>
            </li>
          );
        })}
      </ul>
    </Preview>
  );
}

export function Cover(props: Record<string, unknown>) {
  const state = useOverview(props.id);
  const valueForKey = state?.value;
  const section = state?.section;
  const read = subjectRead(section);
  const original = read ? originalLanguage(read.subject) : undefined;
  const title =
    read && valueForKey
      ? pageText(read.subject.labels, valueForKey.locale, original).text || valueForKey.unlabelled
      : '';
  const image = read ? coverOf(read.summary) : null;
  const subject = read
    ? coverSubject(read.subject.id, title, read.summary, read.subject.type)
    : { id: String(props.id), title: '', types: [] };
  const resolved = useMemo(() => (image ? resolveCoverVariants(image, coverSrc) : []), [image]);
  const incarnation = read
    ? coverIncarnation(subject, image, resolved)
    : JSON.stringify(['unavailable-subject', String(props.id)]);
  const viewer = useIncarnationState(`${incarnation}:${valueForKey?.reader.suitability ?? 'blur'}`, () => false);

  if (!state) return null;
  if (!section) return null;
  const value = state.value;
  if (!read) return <Failed slot="subject-cover" id={String(props.id)} title={value.cover} locale={value.locale} />;
  const openLabel = m.subject_cover_open({ title }, { locale: value.locale as never });
  const closeLabel = m.subject_cover_close({}, { locale: value.locale as never });
  const usable =
    image && usableCoverVariants(image.variants).length > 0 && resolved.some((variant) => variant.src.trim() !== '')
      ? image
      : null;
  return (
    <div data-slot="subject-cover" className="w-60 max-w-full">
      <CoverFrame
        subject={subject}
        cover={image}
        size="lg"
        src={coverSrc}
        suitability={value.reader.suitability}
        labels={value.labels.cover}
        action={{ label: openLabel, onActivate: () => viewer.setValue(true) }}
        {...((value.frameRatio ?? value.ratio) ? { ratio: (value.frameRatio ?? value.ratio)! } : {})}
      />
      {usable ? (
        <CoverViewer
          subject={subject}
          cover={usable}
          src={coverSrc}
          labels={{ title, via: value.coverVia, close: closeLabel }}
          open={viewer.value}
          onOpenChange={viewer.setValue}
        />
      ) : null}
    </div>
  );
}

type SummaryCandidate = { statement: Stmt; document: DocumentSnapshot | undefined; language: string };

/** The selected summary statement, whether its separately disclosed text was filled or not. */
function selectedSummary(subject: Subject, locale: string, filled?: unknown): SummaryCandidate | undefined {
  const held = Object.hasOwn(subject.statements, SUMMARY_PROPERTY) ? subject.statements[SUMMARY_PROPERTY] : undefined;
  const documents = bestRank((held ?? []) as unknown as Stmt[]).flatMap((statement) => {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    const document = statementDocument(subject.id, statement, filled);
    return isRecord(content) && typeof content.language === 'string'
      ? [{ statement, document, language: content.language }]
      : [];
  });
  if (documents.length === 0) return undefined;
  const language = pickLanguage(
    documents.map((entry) => entry.language),
    locale,
    originalLanguage(subject),
  );
  const selected = documents.find((entry) => entry.language === language) ?? documents[0]!;
  return selected;
}

/** The summary the reader's language chain reaches first, with its disclosed document. */
export function chosenSummary(subject: Subject, locale: string, filled?: unknown) {
  const selected = selectedSummary(subject, locale, filled);
  return selected?.document ? { ...selected, document: selected.document } : undefined;
}

/** A bounded plain excerpt has no clipped links or spoiler text. The complete rich document stays intact. */
function summaryExcerpt(document: DocumentSnapshot): { text: string; complete: boolean } {
  const limit = 420;
  // One complete code point past the limit lets segmentation see a joining mark, even across text nodes.
  const probeLimit = limit + 2;
  let text = '';
  let complete = true;
  let paragraphs = 0;
  function visit(node: DocumentNode): void {
    if (text.length >= probeLimit || paragraphs > 2) {
      complete = false;
      return;
    }
    if (node.marks?.some((mark) => mark.type === 'spoiler')) {
      complete = false;
      return;
    }
    if (node.type === 'text') {
      const content = node.text ?? '';
      const remaining = probeLimit - text.length;
      text += content.slice(0, remaining);
      if (content.length > remaining) complete = false;
      return;
    }
    if (node.type === 'paragraph') {
      paragraphs += 1;
      if (paragraphs > 2) {
        complete = false;
        return;
      }
      if (text) text += ' ';
    } else if (node.type === 'hardBreak') text += ' ';
    else if (node.type !== 'doc') {
      complete = false;
      return;
    }
    const children = node.content ?? [];
    for (const [index, child] of children.entries()) {
      visit(child);
      if (text.length >= probeLimit || paragraphs > 2) {
        if (index < children.length - 1) complete = false;
        break;
      }
    }
  }
  visit(document.doc);
  // A sliced supplementary mark must not look like a separate, unpaired surrogate to the segmenter.
  text = text.replace(/[\uD800-\uDBFF]$/, '');
  let end = 0;
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  return { text: text.slice(0, end).trim(), complete: complete && end === text.length };
}

/** Native disclosure keeps the complete document readable without JavaScript. */
function SummaryPassage({
  document,
  language,
  value,
}: {
  document: DocumentSnapshot;
  language: string;
  value: OverviewValue;
}) {
  const excerpt = summaryExcerpt(document);
  const body = (
    <DocumentValue
      document={document}
      lang={language === value.locale ? undefined : language}
      locale={value.locale}
      labels={value.labels}
    />
  );
  return (
    <SubjectPassage excerpt={excerpt} language={language} locale={value.locale}>
      {body}
    </SubjectPassage>
  );
}

type SummaryRetryTarget = {
  subjectId: string;
  statementId: string;
  documentId: string;
  digest: string;
  language: string;
  locale: string;
};
type SummaryRetryController = {
  select(target: SummaryRetryTarget | null): void;
  begin(target: SummaryRetryTarget): SubjectTextRetryToken<SummaryRetryTarget> | null;
  isCurrent(token: SubjectTextRetryToken<SummaryRetryTarget>): boolean;
  finish(token: SubjectTextRetryToken<SummaryRetryTarget>): void;
};
type SummaryRetryState =
  | { target: SummaryRetryTarget; status: 'pending' | 'failed' }
  | { target: SummaryRetryTarget; status: 'read'; document: unknown };

function summaryRetryReference(
  candidate: SummaryCandidate | undefined,
): Omit<SummaryRetryTarget, 'subjectId' | 'locale'> | undefined {
  const statement = candidate?.statement;
  const content = statement?.value.type === 'value' ? statement.value.content : undefined;
  if (
    !statement ||
    typeof statement.id !== 'string' ||
    !isRecord(content) ||
    typeof content.document !== 'string' ||
    typeof content.digest !== 'string' ||
    typeof content.language !== 'string'
  )
    return;
  return {
    statementId: statement.id,
    documentId: content.document,
    digest: content.digest,
    language: content.language,
  };
}

function summaryDocumentMatches(document: unknown, target: SummaryRetryTarget): boolean {
  return (
    isRecord(document) &&
    document.id === target.documentId &&
    document.subjectId === target.subjectId &&
    document.candidateId === target.statementId &&
    document.digest === target.digest &&
    document.language === target.language &&
    document.availability === 'available'
  );
}

function SummaryContent({
  id,
  value,
  section,
  read,
}: {
  id: string;
  value: OverviewValue;
  section: Section;
  read: SubjectRead;
}) {
  const title = m.subject_about({}, { locale: value.locale as never });
  const baseCandidate = selectedSummary(read.subject, value.locale, read.documents);
  const reference = summaryRetryReference(baseCandidate);
  const target = useMemo<SummaryRetryTarget | null>(
    () => (reference ? { ...reference, subjectId: read.subject.id, locale: value.locale } : null),
    [
      section,
      value.sections,
      value.cacheReader,
      value.context,
      value.realm,
      value.locale,
      value.subject,
      read.subject.id,
      read.subject.context,
      reference?.statementId,
      reference?.documentId,
      reference?.digest,
      reference?.language,
    ],
  );
  const controller = useRef<SummaryRetryController | null>(null);
  if (!controller.current) controller.current = createSubjectTextRetryController<SummaryRetryTarget>();
  controller.current.select(target);
  const [retryState, setRetryState] = useState<SummaryRetryState | null>(null);
  const activeRetry = retryState?.target === target ? retryState : null;
  const documents =
    activeRetry?.status === 'read' && baseCandidate?.statement.id
      ? {
          ...(isRecord(read.documents) ? read.documents : {}),
          [baseCandidate.statement.id]: activeRetry.document,
        }
      : read.documents;
  const selected =
    activeRetry?.status === 'read' ? selectedSummary(read.subject, value.locale, documents) : baseCandidate;
  const chosen = selected?.document ? { ...selected, document: selected.document } : undefined;
  const onRetry = target
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        const attempt = controller.current?.begin(target);
        if (!attempt) return;
        setRetryState({ target, status: 'pending' });
        void readPublicSubjectDocument({
          data: {
            documentId: target.documentId,
            locale: target.locale,
            realm: value.realm,
            reader: value.cacheReader ?? null,
          },
        })
          .then((result) => {
            if (!controller.current?.isCurrent(attempt)) return;
            setRetryState(
              result.ok && summaryDocumentMatches(result.document, target)
                ? { target, status: 'read', document: result.document }
                : { target, status: 'failed' },
            );
          })
          .catch(() => {
            if (controller.current?.isCurrent(attempt)) setRetryState({ target, status: 'failed' });
          })
          .finally(() => {
            controller.current?.finish(attempt);
            setRetryState((current) =>
              current?.target === target && current.status === 'pending' ? { target, status: 'failed' } : current,
            );
          });
      }
    : undefined;
  const unavailable =
    !chosen &&
    (read.subject.statements[SUMMARY_PROPERTY] ?? []).some(
      (statement) => statement.rank !== 'deprecated' && statement.value.type === 'value',
    );
  const description = chosen
    ? undefined
    : pageText(read.subject.descriptions, value.locale, originalLanguage(read.subject));
  const { facts = null, tags = null } = value.about ?? {};
  if (!chosen && !unavailable && !description?.text && !facts && !tags) return null;
  const body = chosen && (
    <div className="space-y-1">
      <SummaryPassage
        key={`${read.subject.id}/${value.locale}/${read.subject.context}/${chosen.statement.id}`}
        document={chosen.document}
        language={chosen.language}
        value={value}
      />
      <LanguageTag lang={chosen.language} locale={value.locale} />
    </div>
  );
  return (
    <section
      id={id}
      data-slot="subject-summary"
      aria-labelledby={`${id}-title`}
      className={`${sectionClass} ${anchorClass}`}
    >
      <h2 id={`${id}-title`} className={headingClass}>
        {title}
      </h2>
      {unavailable && (
        <SubjectReadingState
          locale={value.locale}
          href={
            target
              ? `/v1/documents/${encodeURIComponent(target.documentId)}`
              : (viewHref(value, 'details') ??
                subjectViewHref(
                  { id: read.subject.id, label: value.subjectLabel || value.unlabelled },
                  value.locale,
                  'details',
                ))
          }
          onRetry={onRetry}
          busy={retryState?.status === 'pending'}
        />
      )}
      {chosen &&
        (spoilerLevel(chosen.statement) > value.reader.spoilerLevel ? (
          <SpoilerGate
            key={`${read.subject.id}/${value.locale}/${read.subject.context}/${chosen.statement.id}/${value.reader.spoilerLevel}`}
            label={value.spoilerShow}
            hideLabel={value.labels.spoilerHide}
          >
            {body}
          </SpoilerGate>
        ) : (
          body
        ))}
      {description?.text && (
        <div className="space-y-1">
          <DescriptionPassage
            key={`${read.subject.id}/${value.locale}/${read.subject.context}/${description.lang}`}
            text={description.text}
            language={description.lang}
            locale={value.locale}
          />
          <LanguageTag lang={description.lang} locale={value.locale} />
        </div>
      )}
      {facts}
      {tags}
      {viewHref(value, 'details') && (
        <p className="text-sm">
          <a className={`${linkClass} ${linkColor}`} href={viewHref(value, 'details')!}>
            {value.details}
          </a>
        </p>
      )}
    </section>
  );
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
  const read = subjectRead(section);
  if (!read)
    return (
      <Failed
        slot="subject-summary"
        id={id}
        title={m.subject_about({}, { locale: value.locale as never })}
        locale={value.locale}
      />
    );
  return <SummaryContent id={id} value={value} section={section} read={read} />;
}

export function RatingSummary(props: Record<string, unknown>) {
  const value = useContext(OverviewContext);
  if (!value?.subject) return null;
  if (value.context?.population.kind === 'realm')
    return (
      <Failed
        slot="rating-summary"
        id={String(props.id)}
        title={m.subject_ratings({}, { locale: value.locale as never })}
        locale={value.locale}
      />
    );
  return (
    <div id={String(props.id)} className={anchorClass}>
      <RatingsSection
        id={typeof props.id === 'string' ? props.id : 'ratings'}
        subject={value.subject}
        locale={value.locale}
      />
    </div>
  );
}

function CommunityList({ kind, ...props }: Record<string, unknown> & { kind: 'review' | 'discussion' }) {
  const state = useOverview(props.id);
  const node = String(props.id);
  const data = useSubjectCommunity(kind, node);
  const subject = state?.value.subject;
  if (!state || !subject) return null;
  const { value, section } = state;
  const view = kind === 'review' ? 'reviews' : 'discussion';
  const href = viewHref(value, view);
  if (!href) return null;
  // A continued document deliberately leaves unrelated groups unrequested.
  if (section && !section.ok && section.status === 204) return <StreamLink value={value} view={view} node={node} />;
  return (
    <div id={node} className={anchorClass}>
      <SubjectCommunityRegion
        id={node}
        node={node}
        kind={kind}
        region={data?.region ?? composedCommunityRegion(section?.ok ? { status: 200, body: section.body } : undefined)}
        authors={data?.authors ?? {}}
        now={data?.now ?? new Date().toISOString()}
        subject={{ id: subject, label: value.subjectLabel ?? value.unlabelled }}
        locale={value.locale}
        href={href}
        paged={props.paged === true}
      />
    </div>
  );
}

export function ThreadList(props: Record<string, unknown>) {
  return <CommunityList {...props} kind="discussion" />;
}

export function ReviewList(props: Record<string, unknown>) {
  return <CommunityList {...props} kind="review" />;
}

/** Cover credit, fact sources and external identifiers, then a link to Details. */
function sourceRecordRow(value: unknown): {
  name: string;
  url: string;
  licence?: { id: string; url?: string };
  attribution?: string;
} | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.url !== 'string') return null;
  const licence =
    isRecord(value.licence) && typeof value.licence.id === 'string'
      ? {
          id: value.licence.id,
          ...(typeof value.licence.url === 'string' ? { url: value.licence.url } : {}),
        }
      : undefined;
  return {
    name: value.name,
    url: value.url,
    ...(licence ? { licence } : {}),
    ...(typeof value.attribution === 'string' && value.attribution ? { attribution: value.attribution } : {}),
  };
}

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
  const records = sources.records.map(sourceRecordRow).filter((record) => record !== null);
  if (!credit && records.length === 0 && sources.urls.length === 0 && sources.identifiers.length === 0) return null;
  const details = viewHref(value, 'details');
  return (
    <section
      id={id}
      data-slot="subject-sources"
      aria-labelledby={`${id}-title`}
      className={`${sectionClass} border-t border-border/60 pt-6 ${anchorClass}`}
    >
      <h2 id={`${id}-title`} className={headingClass}>
        {value.sources}
      </h2>
      <ul className="space-y-1 text-sm break-words">
        {credit && (
          <li>
            <MetaLine
              items={[
                <>
                  <span className="me-2 font-medium text-muted-foreground">{value.cover}</span>© {credit.rightsHolder}
                </>,
                credit.via ? (
                  <>
                    {value.coverVia}{' '}
                    {webUrl(credit.via.url) ? (
                      <a className={`${linkClass} ${linkColor}`} href={credit.via.url}>
                        {credit.via.name}
                      </a>
                    ) : (
                      credit.via.name
                    )}
                  </>
                ) : null,
                credit.license,
              ]}
            />
          </li>
        )}
        {records.map((record, index) => (
          <li key={index} className="min-w-0 [overflow-wrap:anywhere]">
            <ContentItemFrame as="div" className="min-w-0 py-3 sm:py-4">
              <div data-content-item-slot="context" className="mb-2 font-medium text-muted-foreground">
                {value.source}
              </div>
              <ContentItemHeading
                level={3}
                className="min-w-0 text-[17px] leading-snug font-semibold [overflow-wrap:anywhere] sm:text-lg md:text-xl"
              >
                {webUrl(record.url) ? (
                  <ContentItemTitleLink
                    stretch={false}
                    className={`block min-h-11 content-center rounded-sm ${linkClass} ${linkColor} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                    href={record.url}
                  >
                    {record.name}
                  </ContentItemTitleLink>
                ) : (
                  record.name
                )}
              </ContentItemHeading>
              {(record.licence || record.attribution) && (
                <ListRowControl
                  data-content-item-slot="metadata"
                  className="mt-2 min-w-0 space-y-1 text-sm text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {record.licence && (
                    <p>
                      {value.licence}:{' '}
                      {record.licence.url && webUrl(record.licence.url) ? (
                        <a
                          className={`inline-block min-h-11 min-w-11 max-w-full content-center rounded-sm align-middle ${linkClass} ${linkColor} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                          href={record.licence.url}
                        >
                          {record.licence.id}
                        </a>
                      ) : (
                        record.licence.id
                      )}
                    </p>
                  )}
                  {record.attribution && <p>{record.attribution}</p>}
                </ListRowControl>
              )}
            </ContentItemFrame>
          </li>
        ))}
        {sources.urls.map((url) => (
          <li key={url}>
            <span className="me-2 font-medium text-muted-foreground">{value.source}</span>
            <ExternalValue value={url} />
          </li>
        ))}
        {sources.identifiers.map(({ label, value: identifier }, index) => (
          <li key={index}>
            <span lang={label.lang} className="me-2 font-medium text-muted-foreground">
              {fieldLabel(label, value.locale).text || value.unlabelled}
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
  return <SourcesSection value={value} sources={section.sources} id={id} />;
}

export function OutgoingRelations(props: Record<string, unknown>) {
  const value = useContext(OverviewContext);
  const options = { locale: (value?.locale ?? 'en') as never };
  return LinkSection(
    props,
    'outgoing-relations',
    props.property === 'schema:exampleOfWork' ? m.subject_work({}, options) : m.subject_relations({}, options),
    'relations',
    true,
  );
}
