import {
  pickLanguage,
  pickText,
  planReads,
  platformRegistry,
  shownProperties,
  type CompositionDocument,
} from '@rezics/composition';
import { Cover, sharedRatio, type CoverRatio } from '@rezics/ui/cover';
import { CoverCard, CoverRow } from '@rezics/ui/cover-card';
import { createContext, useContext, type ReactNode } from 'react';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../../media/summary';
import { m } from '../../paraglide/messages.js';
import { languageName, LANGUAGE_PROPERTY, originalLanguage, originalTitle } from '../../subject/language';
import { defaultReader, type Reader } from '../../subject/reader';
import type { RelationDefinition } from '../../subject/relations';
import type { Related, Subject, Summary } from '../../subject/types';
import { subjectHref } from '../../subject/subject-href';
import type { PageDocument } from './render';
import * as accounts from './account';
import { accountOf } from './account-read';
import * as overview from './overview';
import {
  bestRank,
  ExternalValue,
  isRecord,
  linkClass,
  linkColor,
  pageText,
  PlainLink,
  spoilerLevel,
  webUrl,
  type PageLink,
  type Snak,
  type Sources,
  type Stmt,
} from './shared';
import {
  DocumentValue,
  LanguageTag,
  MediaValue,
  readableDocument,
  SPOILER_PROPERTY,
  SpoilerGate,
  type ValueLabels,
} from './values';

type CoreMessages = {
  unknown: string;
  none: string;
  unlabelled: string;
  sources: string;
  aliases: string;
  search: string;
};
type SubjectMessages = {
  cover: string;
  coverCredit: string;
  coverReveal: string;
  coverWithheld: string;
  coverVia: string;
  details: string;
  documentSpoiler: string;
  source: string;
  spoilerShow: string;
};
/** The subject page's own strings are optional so that a host that has none yet still renders the page. */
export type PageMessages = CoreMessages & Partial<SubjectMessages>;
const subjectMessages: SubjectMessages = {
  cover: 'Cover',
  coverCredit: 'Cover credit',
  coverReveal: 'Show cover',
  coverWithheld: 'Sensitive cover',
  coverVia: 'via',
  details: 'Details',
  documentSpoiler: 'Reveal spoiler',
  source: 'Source',
  spoilerShow: 'Show or hide spoilers',
};

export { pageText };
type Frame = { typeLabel?: string; ratio?: CoverRatio };
type Options = {
  locale: string;
  messages: CoreMessages & SubjectMessages;
  link: PageLink;
  reader: Reader;
  frame: Frame;
  labels: ValueLabels;
  headerActions?: ReactNode;
};
type SubjectRead = {
  subject: Subject;
  related: Related;
  summary?: Summary | null;
};
type SearchHit = Pick<Subject, 'id' | 'labels'> & {
  type?: string;
  summary?: SubjectSummary;
};
type SearchRead = {
  subjects: SearchHit[];
  total?: { value: number; relation: 'exact' | 'lower_bound' };
};
type PreparedRead = {
  header?: ReactNode;
  groups?: Map<string, ReactNode>;
  more?: ReactNode[];
  /** The subject's tags, as chips; a tag above the reader's spoiler level waits behind a reveal. */
  tags?: ReactNode;
  /** The hits of a search read with their cover summaries, and the read's total count. */
  hits?: SearchHit[];
  total?: SearchRead['total'];
  sources?: Sources;
};

/** A Zone's `cover` appearance token chooses the frame shared by its rows. */
const tokenRatios: Record<string, CoverRatio> = {
  portrait: '5:7',
  square: '1:1',
  landscape: '4:3',
};

const PageContext = createContext<{
  locale: string;
  messages: PageMessages;
  nodes: Map<string, PreparedRead>;
  ratio?: CoverRatio;
  subject: string | null;
  /** Whether the page shows the account's own presentation as its header. */
  agentHeader: boolean;
  sources: Sources | null;
  link: PageLink;
}>({
  locale: 'en',
  messages: {
    unknown: '',
    none: '',
    unlabelled: '',
    sources: '',
    aliases: '',
    search: '',
    ...subjectMessages,
  },
  nodes: new Map(),
  subject: null,
  agentHeader: false,
  sources: null,
  link: PlainLink,
});
const listClass = 'space-y-5 in-data-[density=compact]:space-y-3';

export function usePageLocale(): string {
  return useContext(PageContext).locale;
}

export function usePageMessages(): PageMessages {
  return useContext(PageContext).messages;
}

function itemLink(id: string, labels: unknown, options: Options) {
  const label = pageText(labels, options.locale);
  const Link = options.link;
  return (
    <span className={`${linkClass} ${label.text ? linkColor : 'text-muted-foreground'}`}>
      <Link
        href={subjectHref({ id, label: label.text || options.messages.unlabelled }, options.locale).href}
        {...(label.lang ? { lang: label.lang } : {})}
      >
        {label.text || options.messages.unlabelled}
      </Link>
    </span>
  );
}

function timeText(value: Record<string, unknown>, locale: string): string | null {
  if (typeof value.time !== 'string') return null;
  const match = /^([+-]?\d{4,})-(\d{2})-(\d{2})T/.exec(value.time);
  if (!match || ![9, 10, 11].includes(value.precision as number)) return value.time;
  const date = new Date(0);
  // Kernel dates use 00 for the month/day omitted at year/month precision.
  // setUTCFullYear also preserves years 0–99 instead of adding 1900.
  date.setUTCFullYear(Number(match[1]), Math.max(1, Number(match[2])) - 1, Math.max(1, Number(match[3])));
  if (!Number.isFinite(date.getTime())) return value.time;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    ...(value.precision === 10 || value.precision === 11 ? { month: 'long' } : {}),
    ...(value.precision === 11 ? { day: 'numeric' } : {}),
  }).format(date);
}

function inlineValue(snak: Snak, related: Related, options: Options): ReactNode {
  const { value, property } = snak;
  if (value.type === 'somevalue' || value.type === 'novalue') {
    return (
      <span className="text-muted-foreground">
        {value.type === 'somevalue' ? options.messages.unknown : options.messages.none}
      </span>
    );
  }
  if (value.type !== 'value') return null;
  const content = value.content;
  if (property.data_type === 'wikibase-item' && typeof content === 'string') {
    const entry = Object.hasOwn(related, content) ? related[content] : undefined;
    return itemLink(entry?.redirect ?? content, entry?.labels, options);
  }
  if (property.data_type === 'quantity' && isRecord(content) && typeof content.amount === 'string') {
    const amount = Number(content.amount);
    const formatted = Number.isFinite(amount) ? new Intl.NumberFormat(options.locale).format(amount) : content.amount;
    return (
      <span>
        {formatted}
        {typeof content.unit === 'string' && content.unit !== '1' ? ` ${content.unit}` : ''}
      </span>
    );
  }
  if (property.data_type === 'time' && isRecord(content)) return <span>{timeText(content, options.locale)}</span>;
  if (property.data_type === 'monolingualtext' && isRecord(content) && typeof content.language === 'string') {
    const text = pageText({ [content.language]: content.text }, options.locale);
    return <span lang={text.lang}>{text.text}</span>;
  }
  if (typeof content !== 'string' || content === '') return null;
  // A media id or a document is shown by the statement's own view; as a qualifier it has no reading form.
  if (property.data_type === 'media') return null;
  if (property.id === LANGUAGE_PROPERTY) {
    const name = languageName(content, options.locale);
    return name === undefined ? null : <span>{name}</span>;
  }
  return property.data_type === 'url' ? <ExternalValue value={content} /> : <span>{content}</span>;
}

type Creator = { id: string; name: string; node: ReactNode };

/** The properties that name a subject's principal creators, in the order the first one present is used. */
const CREATOR_PROPERTIES = ['schema:author', 'schema:creator', 'schema:director', 'schema:musicBy'];
const DATE_PROPERTIES = ['schema:datePublished', 'schema:startDate', 'schema:dateCreated'];
const MAX_CREATORS = 4;
const TAG_PROPERTY = 'schema:keywords';

/** A name compared as written: no case, one space for any run of whitespace. */
function foldName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function subjectHeader(read: SubjectRead, creators: Creator[], date: string | null, options: Options) {
  const { subject, summary } = read;
  const original = originalLanguage(subject);
  const label = pageText(subject.labels, options.locale, original);
  const title = label.text || options.messages.unlabelled;
  const first = originalTitle(subject);
  const quiet = first && label.text && first.text !== label.text ? first : undefined;
  // The title and the original title are shown already, so an alternate name equal to either is left out.
  const known = new Set([label.text, first?.text].filter((name): name is string => !!name).map(foldName));
  const alternates = Object.fromEntries(
    Object.entries(subject.aliases).map(([lang, names]) => [lang, names.filter((name) => !known.has(foldName(name)))]),
  );
  // Select a language for the alias list with the same policy as scalar text.
  const aliasLanguage = pickLanguage(
    Object.keys(alternates).filter((lang) => alternates[lang]?.length),
    options.locale,
    original,
  );
  const aliases = aliasLanguage ? (alternates[aliasLanguage] ?? []) : [];
  const coverFor = {
    ...coverSubject(subject.id, title, summary, subject.type),
    ...(creators[0] ? { byline: creators[0].name } : {}),
  };
  const cover = (size: 'sm' | 'lg') => (
    <Cover
      subject={coverFor}
      cover={coverOf(summary)}
      size={size}
      src={coverSrc}
      suitability={options.reader.suitability}
      labels={options.labels.cover}
      {...(options.frame.ratio ? { ratio: options.frame.ratio } : {})}
      {...(size === 'lg' ? { priority: true, caption: true } : { decorative: true })}
    />
  );
  const facts = [options.frame.typeLabel, date].filter((fact): fact is string => !!fact);
  return (
    <div data-slot="subject-header" className="min-w-0 space-y-4 in-data-[density=compact]:space-y-3">
      <div className="flex min-w-0 gap-4 sm:gap-6">
        <div className="shrink-0">
          <div className="sm:hidden">{cover('sm')}</div>
          <div className="hidden w-60 sm:block">{cover('lg')}</div>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:grid-rows-[min-content_auto]">
          <div className="min-w-0 space-y-2 in-data-[density=compact]:space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1
                lang={label.lang}
                className={`min-w-0 font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl in-data-[heading-scale=lg]:sm:text-5xl${label.text ? '' : ' text-muted-foreground'}`}
              >
                {title}
              </h1>
              {label.text && <LanguageTag lang={label.lang} locale={options.locale} />}
            </div>
            {quiet && (
              <p lang={quiet.lang} className="font-serif text-lg text-muted-foreground">
                {quiet.text}
              </p>
            )}
            {facts.length > 0 && <p className="text-sm text-muted-foreground">{facts.join(' · ')}</p>}
            {creators.length > 0 && (
              <p data-slot="subject-creators" className="text-sm font-medium">
                {creators.map((creator, index) => (
                  <span key={creator.id}>
                    {index > 0 && ', '}
                    {creator.node}
                  </span>
                ))}
              </p>
            )}
            {aliases.length > 0 && (
              <dl
                data-slot="subject-aliases"
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-x-4 gap-y-1 text-sm"
              >
                <dt className="font-semibold text-muted-foreground">{options.messages.aliases}</dt>
                <dd className="min-w-0 break-words">
                  {aliases.map((alias, index) => {
                    const text = pageText({ [aliasLanguage!]: alias }, options.locale);
                    return (
                      <span key={index} lang={text.lang}>
                        {index > 0 ? ' · ' : ''}
                        {text.text}
                      </span>
                    );
                  })}
                </dd>
              </dl>
            )}
          </div>
          {options.headerActions}
        </div>
      </div>
    </div>
  );
}

/** Prepare every property once; multiple nodes can share the same subject read. */
function prepareSubject(read: SubjectRead, options: Options, shown: Set<string>): PreparedRead {
  const groups = new Map<string, ReactNode>();
  const relatedLabel = (id: string) =>
    pageText(Object.hasOwn(read.related, id) ? read.related[id]?.labels : {}, options.locale);
  const { reader } = options;
  const original = originalLanguage(read.subject);
  const headerMedia = read.summary?.cover?.media;
  const coverFor = coverSubject(
    read.subject.id,
    pageText(read.subject.labels, options.locale, original).text || options.messages.unlabelled,
    read.summary,
    read.subject.type,
  );
  const urls = new Set<string>();
  const identifiers: Sources['identifiers'] = [];
  const named: Record<string, Creator[]> = {};
  const dates: Record<string, string> = {};

  const presentable = (statement: Stmt): ReactNode => {
    const { value, property } = statement;
    if (value.type === 'value' && property.data_type === 'media') {
      // The cover the header draws is not repeated; any other image is a frame of its own.
      if (typeof value.content !== 'string' || value.content === headerMedia) return null;
      return (
        <MediaValue
          subject={coverFor}
          cover={null}
          suitability={reader.suitability}
          labels={options.labels.cover}
          {...(options.frame.ratio ? { ratio: options.frame.ratio } : {})}
        />
      );
    }
    if (value.type === 'value' && property.data_type === 'document') {
      const content = value.content;
      const document = isRecord(content) ? readableDocument(content.document) : undefined;
      if (!isRecord(content) || document === undefined || typeof content.language !== 'string') return null;
      const lang = content.language === options.locale ? undefined : content.language;
      return (
        <div className="space-y-1">
          <DocumentValue document={document} lang={lang} labels={options.labels} />
          <LanguageTag lang={content.language} locale={options.locale} />
        </div>
      );
    }
    return inlineValue(statement, read.related, options);
  };

  for (const [property, all] of Object.entries(read.subject.statements)) {
    let chosen = bestRank(all as unknown as Stmt[]);
    if (!chosen.length) continue;
    // A summary is one document per language; the page shows the one the reader's chain reaches first.
    const documents = chosen.flatMap((statement) =>
      statement.value.type === 'value' &&
      statement.property.data_type === 'document' &&
      isRecord(statement.value.content) &&
      typeof statement.value.content.language === 'string'
        ? [statement.value.content.language]
        : [],
    );
    if (documents.length > 1) {
      const language = pickLanguage(documents, options.locale, original);
      chosen = chosen.filter((statement) => {
        const content = statement.value.content;
        return !isRecord(content) || content.language === language;
      });
    }
    const label = relatedLabel(property);
    const values = chosen.flatMap((statement) => {
      // A value the page cannot present, such as a language with no name, stays out of the reading view.
      const value = presentable(statement);
      if (value === null) return [];
      const gated = spoilerLevel(statement) > reader.spoilerLevel;
      const content = statement.value.type === 'value' ? statement.value.content : undefined;
      if (!gated) {
        for (const reference of statement.references) {
          for (const part of reference.parts) {
            if (
              part.property.data_type === 'url' &&
              part.value.type === 'value' &&
              typeof part.value.content === 'string'
            )
              urls.add(part.value.content);
          }
        }
        if (statement.property.data_type === 'external-id' && typeof content === 'string')
          identifiers.push({ label, value: content });
        if (CREATOR_PROPERTIES.includes(property) && statement.property.data_type === 'wikibase-item') {
          if (typeof content === 'string') {
            const entry = Object.hasOwn(read.related, content) ? read.related[content] : undefined;
            const id = entry?.redirect ?? content;
            const name = pageText(entry?.labels, options.locale).text;
            (named[property] ??= []).push({
              id,
              name,
              node: itemLink(id, entry?.labels, options),
            });
          }
        }
        if (DATE_PROPERTIES.includes(property) && isRecord(content) && !(property in dates)) {
          const date = timeText(content, options.locale);
          if (date) dates[property] = date;
        }
      }
      const qualifiers = statement.qualifiers.flatMap((qualifier) => {
        if (qualifier.property.id === SPOILER_PROPERTY) return [];
        const shownValue = inlineValue(qualifier, read.related, options);
        return shownValue === null ? [] : [{ qualifier, shownValue }];
      });
      const body = (
        <>
          {value}
          {qualifiers.length > 0 && (
            <dl className="ms-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {qualifiers.map(({ qualifier, shownValue }, index) => {
                const name = relatedLabel(qualifier.property.id);
                return (
                  <div className="contents" key={index}>
                    <dt lang={name.lang}>{name.text || options.messages.unlabelled}</dt>
                    <dd>{shownValue}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </>
      );
      return [
        <dd key={statement.id} className="min-w-0 space-y-2 break-words sm:col-start-2">
          {gated ? <SpoilerGate label={options.messages.spoilerShow}>{body}</SpoilerGate> : body}
        </dd>,
      ];
    });
    if (!values.length) continue;
    groups.set(
      property,
      <div
        key={property}
        className="grid gap-y-2 border-b border-border/60 pb-5 last:border-0 last:pb-0 sm:grid-cols-[minmax(10rem,1fr)_3fr] sm:gap-x-6 in-data-[density=compact]:pb-3"
      >
        <dt lang={label.lang} className="font-semibold">
          {label.text || options.messages.unlabelled}
        </dt>
        {values}
      </div>,
    );
  }
  const keywords = bestRank(
    (Object.hasOwn(read.subject.statements, TAG_PROPERTY)
      ? read.subject.statements[TAG_PROPERTY]
      : []) as unknown as Stmt[],
  ).flatMap((statement) =>
    statement.value.type === 'value' && typeof statement.value.content === 'string' && statement.value.content
      ? [{ statement, text: statement.value.content }]
      : [],
  );
  const visibleKeywords = keywords.filter(({ statement }) => spoilerLevel(statement) <= reader.spoilerLevel);
  const spoilerKeywords = keywords.filter(({ statement }) => spoilerLevel(statement) > reader.spoilerLevel);
  const tagList = (items: typeof keywords, slot: string) => (
    <ul
      data-slot={slot}
      aria-label={m.subject_tags({}, { locale: options.locale as never })}
      className="flex flex-wrap gap-2"
    >
      {items.map(({ statement, text }) => (
        <li key={statement.id}>
          <span className="rounded-full border border-border px-2.5 py-0.5 text-sm">{text}</span>
        </li>
      ))}
    </ul>
  );
  const tags = keywords.length ? (
    <>
      {visibleKeywords.length ? tagList(visibleKeywords, 'subject-tags') : null}
      {spoilerKeywords.length ? (
        <SpoilerGate label={options.messages.spoilerShow}>
          {tagList(spoilerKeywords, 'subject-spoiler-tags')}
        </SpoilerGate>
      ) : null}
    </>
  ) : null;
  const creators = (named[CREATOR_PROPERTIES.find((property) => named[property]?.length) ?? ''] ?? []).slice(
    0,
    MAX_CREATORS,
  );
  const date = dates[DATE_PROPERTIES.find((property) => property in dates) ?? ''] ?? null;
  return {
    header: subjectHeader(read, creators, date, options),
    groups,
    tags,
    more: [...groups].filter(([property]) => !shown.has(property)).map(([, group]) => group),
    sources: {
      credit: read.summary?.cover?.credit ?? null,
      urls: [...urls],
      identifiers,
    },
  };
}

/** The nodes of one type anywhere in the document, in document order. */
function nodesOfType(content: readonly unknown[], type: string): { id: string; props: Record<string, unknown> }[] {
  return content.flatMap((node) => {
    if (!isRecord(node) || !isRecord(node.props)) return [];
    const nested = Object.values(node.props).flatMap((value) => (Array.isArray(value) ? nodesOfType(value, type) : []));
    return [
      ...(node.type === type && typeof node.props.id === 'string' ? [{ id: node.props.id, props: node.props }] : []),
      ...nested,
    ];
  });
}

export function PageData({
  locale,
  subject = null,
  subjectLabel,
  account,
  base,
  document,
  reads,
  messages,
  link = PlainLink,
  reader = defaultReader,
  typeLabel,
  ratio,
  relations = {},
  headerActions,
  children,
}: {
  locale: string;
  subject?: string | null;
  subjectLabel?: string;
  /** The account of an agent page, and the address of its overview. */
  account?: { id: string; handle: string };
  base?: string;
  document: PageDocument;
  reads: Record<string, { status: number; body: unknown }>;
  messages: PageMessages;
  link?: PageLink;
  reader?: Reader;
  typeLabel?: string;
  ratio?: Frame['ratio'];
  /** How each relation property reads from this page, from the definition release. */
  relations?: Record<string, RelationDefinition>;
  /** Subject-only actions placed alongside the title in its header. */
  headerActions?: ReactNode;
  children?: ReactNode;
}) {
  // Page documents have already passed the composition contract at the kernel boundary.
  const composition = document as CompositionDocument;
  const plan = planReads(platformRegistry, composition, { subject, account: account ?? null });
  const shown = new Set(shownProperties(composition));
  const resolved = { ...subjectMessages, ...messages };
  const labels: ValueLabels = {
    spoilerShow: resolved.spoilerShow,
    documentSpoiler: resolved.documentSpoiler,
    cover: {
      withheld: resolved.coverWithheld,
      reveal: resolved.coverReveal,
      credit: resolved.coverCredit,
      via: resolved.coverVia,
    },
  };
  const options: Options = {
    locale,
    messages: resolved,
    link,
    reader,
    frame: { ...(typeLabel ? { typeLabel } : {}), ...(ratio ? { ratio } : {}) },
    labels,
    ...(headerActions ? { headerActions } : {}),
  };
  const prepared = new Map<string, PreparedRead>();
  let overviewSubjectLabel = subjectLabel;
  let sources: Sources | null = null;
  for (const [key, planned] of Object.entries(plan.reads)) {
    const result = Object.hasOwn(reads, key) ? reads[key] : undefined;
    if (result?.status !== 200 || !isRecord(result.body)) continue;
    if (planned.kind === 'subject' && isRecord(result.body.subject) && isRecord(result.body.related)) {
      const read = prepareSubject(result.body as SubjectRead, options, shown);
      prepared.set(key, read);
      if (planned.id === subject) {
        sources = read.sources ?? null;
        if (overviewSubjectLabel === undefined) {
          const body = result.body as SubjectRead;
          overviewSubjectLabel =
            pageText(body.subject.labels, locale, originalLanguage(body.subject)).text || resolved.unlabelled;
        }
      }
    } else if (planned.kind === 'search' && Array.isArray(result.body.subjects)) {
      const subjects = (result.body as SearchRead).subjects.slice(0, planned.body.limit);
      const total = (result.body as SearchRead).total;
      prepared.set(key, {
        hits: subjects,
        ...(total ? { total } : {}),
      });
    }
  }
  const nodes = new Map<string, PreparedRead>();
  for (const [id, key] of Object.entries(plan.nodes)) {
    const read = prepared.get(key);
    if (read) nodes.set(id, read);
  }
  const appearance = isRecord(composition.root.props.appearance) ? composition.root.props.appearance : {};
  const token =
    typeof appearance.cover === 'string' && Object.hasOwn(tokenRatios, appearance.cover) ? appearance.cover : '';
  const zoneRatio = token ? tokenRatios[token] : undefined;
  const sections = new Map<string, overview.Section>();
  for (const [id, key] of Object.entries(plan.nodes)) {
    const planned = plan.reads[key];
    const result = Object.hasOwn(reads, key) ? reads[key] : undefined;
    if (!planned) continue;
    sections.set(
      id,
      result?.status === 200 && isRecord(result.body)
        ? {
            ok: true,
            read: planned,
            body: result.body,
            ...(prepared.get(key)?.sources ? { sources: prepared.get(key)!.sources! } : {}),
          }
        : { ok: false },
    );
  }
  const profile = Object.entries(plan.reads).flatMap(([key, planned]) =>
    planned.kind === 'account' && reads[key]?.status === 200 ? [accountOf(reads[key].body)] : [],
  )[0];
  // About gathers the first Statements node's facts and the tags after the summary, when the page places a Summary.
  const firstStatements = nodesOfType(composition.content, 'Statements')[0];
  const aboutRead = firstStatements ? nodes.get(firstStatements.id) : undefined;
  const about =
    firstStatements && nodesOfType(composition.content, 'Summary').length > 0
      ? {
          statements: firstStatements.id,
          facts: statementList(aboutRead, firstStatements.props.properties, 'subject-facts'),
          tags: aboutRead?.tags ?? null,
        }
      : undefined;
  const overviewValue: overview.OverviewValue = {
    locale,
    subject,
    ...(overviewSubjectLabel !== undefined ? { subjectLabel: overviewSubjectLabel } : {}),
    ...(account ? { account } : {}),
    ...(base !== undefined ? { agentBase: base } : {}),
    ...(profile ? { profile } : {}),
    link,
    reader,
    labels,
    unlabelled: resolved.unlabelled,
    spoilerShow: resolved.spoilerShow,
    details: resolved.details,
    cover: resolved.cover,
    coverVia: resolved.coverVia,
    source: resolved.source,
    sources: resolved.sources,
    sections,
    ...(about ? { about } : {}),
    relations,
    relationNodes: nodesOfType(composition.content, 'RelationGroups'),
    ...(zoneRatio ? { ratio: zoneRatio } : {}),
    ...(ratio ? { frameRatio: ratio } : {}),
  };
  return (
    <overview.OverviewContext.Provider value={overviewValue}>
      <PageContext.Provider
        value={{
          locale,
          messages: resolved,
          nodes,
          subject,
          agentHeader: profile !== undefined,
          sources,
          link,
          ...(zoneRatio ? { ratio: zoneRatio } : {}),
        }}
      >
        {children}
      </PageContext.Provider>
    </overview.OverviewContext.Provider>
  );
}

/** The overview's last section: the cover's credit, the sources of the facts shown, identifiers, and Details. */
export function SubjectSources() {
  const { sources } = useContext(PageContext);
  const value = useContext(overview.OverviewContext);
  if (!value?.subject || !sources) return null;
  return <overview.SourcesSection value={value} sources={sources} />;
}

function useNodeRead(id: unknown) {
  return useContext(PageContext).nodes.get(typeof id === 'string' ? id : '');
}

/** The subject's header, unless the page is an agent's and shows the account's own presentation instead. */
function SubjectHeader(props: Record<string, unknown>) {
  const read = useNodeRead(props.id);
  return useContext(PageContext).agentHeader ? null : (read?.header ?? null);
}

/** The rows of the named properties the subject holds, in the order the template names them. */
function statementList(read: PreparedRead | undefined, properties: unknown, slot: string): ReactNode {
  const named = Array.isArray(properties) ? properties : [];
  const groups = named.flatMap((property) =>
    typeof property === 'string' && read?.groups?.has(property) ? [read.groups.get(property)] : [],
  );
  return groups.length ? (
    <dl data-slot={slot} className={listClass}>
      {groups}
    </dl>
  ) : null;
}

function Statements(props: Record<string, unknown>) {
  const read = useNodeRead(props.id);
  // About shows the facts of the first Statements node when the page has a summary.
  if (useContext(overview.OverviewContext)?.about?.statements === props.id) return null;
  return statementList(read, props.properties, 'subject-facts');
}

function MoreStatements(props: Record<string, unknown>) {
  const groups = useNodeRead(props.id)?.more;
  return groups?.length ? <dl className={listClass}>{groups}</dl> : null;
}

/** The bounded count of a search read: a lower bound is shown with a plus sign. */
function countText(total: NonNullable<PreparedRead['total']>, locale: string): string {
  return `${new Intl.NumberFormat(locale).format(total.value)}${total.relation === 'lower_bound' ? '+' : ''}`;
}

/**
 * One vertical of the home: a row of cover cards with the section's count and a link to the whole search. The row
 * shares one frame ratio, so a mixed row stays aligned; the heading names the type for every card in the row.
 */
function TypeList(props: Record<string, unknown>) {
  const read = useNodeRead(props.id);
  const { locale, messages, ratio: zoneRatio } = useContext(PageContext);
  const title = pageText(props.title, locale);
  if (!read?.hits?.length) return null;
  const hits = read.hits;
  const id = typeof props.id === 'string' ? props.id : 'type-list';
  const type = Array.isArray(props.types) && typeof props.types[0] === 'string' ? props.types[0] : undefined;
  const subjects = hits.map((hit) => {
    const text = pageText(hit.labels, locale);
    return {
      hit,
      text,
      subject: coverSubject(hit.id, text.text, hit.summary, hit.type),
    };
  });
  const ratio = zoneRatio ?? sharedRatio(subjects.map((item) => item.subject));
  return (
    <section
      data-slot="type-list"
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-4 in-data-[density=compact]:space-y-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2
            id={`${id}-title`}
            lang={title.lang}
            className="text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl"
          >
            {title.text}
          </h2>
          {read.total && (
            <span data-slot="type-count" className="text-sm text-muted-foreground tabular-nums">
              {m.home_section_count({ count: countText(read.total, locale) }, { locale: locale as never })}
            </span>
          )}
        </div>
        {type && (
          <a
            data-slot="see-all"
            href={`/${encodeURIComponent(locale)}/search?type=${encodeURIComponent(type)}`}
            aria-describedby={`${id}-title`}
            className={`${linkClass} ${linkColor} text-sm font-medium hover:underline`}
          >
            {m.home_see_all({}, { locale: locale as never })}
          </a>
        )}
      </div>
      <CoverRow ratio={ratio} label={m.home_section_row({ title: title.text }, { locale: locale as never })}>
        {subjects.map(({ hit, text, subject }) => (
          <CoverCard
            key={hit.id}
            href={subjectHref({ id: hit.id, label: text.text || messages.unlabelled }, locale).href}
            cover={{ subject, cover: coverOf(hit.summary), src: coverSrc }}
            title={text.text || messages.unlabelled}
            {...(text.lang ? { titleLang: text.lang } : {})}
          />
        ))}
      </CoverRow>
    </section>
  );
}

export const dataComponents = {
  Cover: overview.Cover,
  AccountIdentity: accounts.AccountIdentity,
  AccountPosts: accounts.AccountPosts,
  AccountThreads: accounts.AccountThreads,
  AccountCollections: accounts.AccountCollections,
  Summary: overview.Summary,
  RelationGroups: overview.RelationGroups,
  Appearances: overview.Appearances,
  Credits: overview.Credits,
  RatingSummary: overview.RatingSummary,
  ThreadList: overview.ThreadList,
  ReviewList: overview.ReviewList,
  CollectionList: overview.CollectionList,
  Sources: overview.Sources,
  SubjectHeader,
  Statements,
  MoreStatements,
  SubjectList: overview.SubjectList,
  TypeList,
};
