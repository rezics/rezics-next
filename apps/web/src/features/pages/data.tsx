import { Members } from './member-list';
import type { MemberPageTarget } from './member-list-query';
import {
  pickLanguage,
  pickText,
  pageDocumentReferences,
  planReads,
  platformRegistry,
  shownProperties,
  type CompositionDocument,
  type SelectedContext,
  type PageContinuation,
} from '@rezics/composition';
import { type CoverRatio } from '@rezics/ui/cover';
import { MetaLine } from '@rezics/ui/meta-line';
import { TypeList, TypeListContext } from './type-list';
import type { TypeListTarget } from './type-list-model';
import { createContext, useContext, type ReactNode } from 'react';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { m } from '../../paraglide/messages.js';
import { languageName, LANGUAGE_PROPERTY, originalLanguage, originalTitle } from '../../subject/language';
import { defaultReader, type Reader } from '../../subject/reader';
import type { RelationDefinition } from '../../subject/relations';
import type { Related, Subject, Summary } from '../../subject/types';
import { subjectHref } from '../../subject/subject-href';
import { quantityPresentation } from '../../subject/quantity-presentation';
import type { PageDocument } from './render';
import { statementDocument } from './documents';
import * as accounts from './account';
import { accountOf } from './account-read';
import * as overview from './overview';
import { SubjectPageCover } from './subject-page-cover';
import { SubjectPurchaseSlot } from './subject-slots';
import { StatementCorrectionLink } from '../catalogue/statement-editor-link';
import { ValueExplanationEntry } from '../catalogue/value-explanation-entry';
import {
  bestRank,
  ExternalValue,
  fieldLabel,
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
import { DocumentValue, LanguageTag, MediaValue, SPOILER_PROPERTY, SpoilerGate, type ValueLabels } from './values';

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
  licence: string;
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
  licence: 'Licence',
  source: 'Source',
  spoilerShow: 'Show spoilers',
};

export { pageText };
type Frame = { typeLabel?: string; ratio?: CoverRatio };
type Options = {
  locale: string;
  subject?: string;
  messages: CoreMessages & SubjectMessages;
  link: PageLink;
  reader: Reader;
  frame: Frame;
  labels: ValueLabels;
  overview?: boolean;
  headerActions?: ReactNode;
};
type SubjectRead = {
  subject: Subject;
  related: Related;
  documents?: unknown;
  summary?: Summary | null;
};
type PreparedRead = {
  header?: ReactNode;
  groups?: Map<string, ReactNode>;
  more?: ReactNode[];
  /** The subject's tags, as chips; a tag above the reader's spoiler level waits behind a reveal. */
  tags?: ReactNode;
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

/** Layout-only editor previews use the selected language without acquiring page data or read authority. */
export function PageLocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const context = useContext(PageContext);
  return <PageContext.Provider value={{ ...context, locale }}>{children}</PageContext.Provider>;
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
  if (property.data_type === 'quantity') {
    const quantity = quantityPresentation(content, related, options.locale);
    if (!quantity) return null;
    const unit = quantity.unitLabel ?? m.quantity_unit_unavailable({}, { locale: options.locale as never });
    return (
      <span>
        {quantity.numbers}
        {unit ? ` ${unit}` : ''}
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

/** Reuse ordinary field rendering in the private candidate comparison, without exposing raw JSON or ids. */
export function CandidateValue({
  snak,
  related,
  locale,
  subject,
  documents,
  link = PlainLink,
}: {
  snak: Snak & { id?: string };
  related: Related;
  locale: string;
  subject?: string;
  /** Authorized responses from this comparison's current read, never draft envelopes or a shared cache. */
  documents?: unknown;
  link?: PageLink;
}) {
  const messages = {
    ...subjectMessages,
    unknown: m.subject_value_unknown({}, { locale: locale as never }),
    none: m.subject_value_none({}, { locale: locale as never }),
    unlabelled: m.subject_value_unlabelled({}, { locale: locale as never }),
    sources: '',
    aliases: '',
    search: '',
  };
  const content = snak.value.type === 'value' ? snak.value.content : undefined;
  if (snak.value.type === 'somevalue' || snak.value.type === 'novalue')
    return (
      <span className="text-muted-foreground">
        {snak.value.type === 'somevalue' ? messages.unknown : messages.none}
      </span>
    );
  if (snak.value.type === 'value' && snak.property.data_type === 'document') {
    const document = statementDocument(subject ?? '', snak, documents);
    if (document && isRecord(content))
      return (
        <DocumentValue
          document={document}
          lang={typeof content.language === 'string' ? content.language : undefined}
          labels={{
            documentSpoiler: m.thread_reveal_spoiler({}, { locale: locale as never }),
            spoilerShow: '',
            cover: { withheld: '', reveal: '', credit: '', via: '' },
          }}
        />
      );
    return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  }
  if (snak.property.data_type === 'media')
    return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  if (snak.property.data_type === 'quantity') {
    const quantity = quantityPresentation(content, related, locale);
    if (!quantity) return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
    const unit = quantity.unitLabel ?? m.quantity_unit_unavailable({}, { locale: locale as never });
    return (
      <span>
        {quantity.numbers}
        {unit ? ` ${unit}` : ''}
      </span>
    );
  }
  return (
    inlineValue(snak, related, {
      locale,
      messages,
      link,
      reader: defaultReader,
      frame: {},
      labels: { documentSpoiler: '', spoilerShow: '', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    }) ?? <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>
  );
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
    <SubjectPageCover
      subject={coverFor}
      cover={coverOf(summary)}
      size={size}
      src={coverSrc}
      suitability={options.reader.suitability}
      labels={options.labels.cover}
      title={title}
      via={options.messages.coverVia}
      openLabel={m.subject_cover_open({ title }, { locale: options.locale as never })}
      closeLabel={m.subject_cover_close({}, { locale: options.locale as never })}
      ratio={options.frame.ratio ?? '5:7'}
      {...(size === 'lg' ? { priority: true } : { decorative: true })}
    />
  );
  const facts = [options.frame.typeLabel, date].filter((fact): fact is string => !!fact);
  return (
    <div
      id="subject-identity"
      data-slot="subject-header"
      className="min-w-0 space-y-4 in-data-[density=compact]:space-y-3"
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-3 sm:gap-x-6">
        <div className="shrink-0 sm:row-span-2">
          <div className="sm:hidden">{cover('sm')}</div>
          <div className="hidden w-60 sm:block">{cover('lg')}</div>
        </div>
        <div data-slot="subject-identity" className="min-w-0 space-y-2 in-data-[density=compact]:space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1
              lang={label.lang}
              className={`min-w-0 break-words font-sans text-2xl font-semibold tracking-tight text-balance sm:text-4xl in-data-[heading-scale=lg]:sm:text-5xl${label.text ? '' : ' text-muted-foreground'}`}
            >
              {title}
            </h1>
            {label.text && <LanguageTag lang={label.lang} locale={options.locale} />}
          </div>
          {quiet && (
            <p lang={quiet.lang} className="break-words text-base text-muted-foreground">
              {quiet.text}
            </p>
          )}
          {facts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <MetaLine items={facts} />
            </p>
          )}
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
        </div>
        <div
          data-slot="subject-primary-actions"
          className="col-span-full grid min-w-0 grid-cols-1 gap-3 sm:col-span-1 sm:col-start-2 sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          {options.headerActions}
        </div>
        {aliases.length > 0 && (
          <dl
            data-slot="subject-aliases"
            className="col-span-full grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-x-4 gap-y-1 text-sm sm:col-start-2 sm:col-span-1"
          >
            <dt className="font-semibold text-muted-foreground">{options.messages.aliases}</dt>
            <dd className="min-w-0 break-words">
              <MetaLine
                items={aliases.map((alias, index) => {
                  const text = pageText({ [aliasLanguage!]: alias }, options.locale);
                  return (
                    <span key={index} lang={text.lang}>
                      {text.text}
                    </span>
                  );
                })}
              />
            </dd>
          </dl>
        )}
      </div>
      {options.subject === subject.id && (
        <SubjectPurchaseSlot context={{ subjectId: subject.id, subjectType: subject.type, locale: options.locale }} />
      )}
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
  const records = (() => {
    const value: unknown = Reflect.get(read.subject, 'sourceRecords');
    return Array.isArray(value) ? value : [];
  })();
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
      const document = statementDocument(read.subject.id, statement, read.documents);
      if (!isRecord(content) || document === undefined || typeof content.language !== 'string')
        return <span>{m.candidate_value_unavailable({}, { locale: options.locale as never })}</span>;
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
    let chosen: Stmt[];
    if (all.some((statement) => statement.property.data_type === 'document')) {
      const candidate = pageDocumentReferences(read.subject, [property], options.locale)[0]?.candidate;
      chosen = candidate ? (all as unknown as Stmt[]).filter((statement) => statement.id === candidate) : [];
    } else {
      chosen = bestRank(all as unknown as Stmt[]);
    }
    if (!chosen.length) continue;
    // A document-valued property contributes only its selected public candidate to the page.
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
    const values = (options.overview ? chosen.slice(0, 3) : chosen).flatMap((statement) => {
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
            <dl className="ms-4 min-w-0 space-y-2 text-sm text-muted-foreground">
              {qualifiers.map(({ qualifier, shownValue }, index) => {
                const name = fieldLabel(relatedLabel(qualifier.property.id), options.locale);
                return (
                  <div
                    className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                    key={index}
                  >
                    <dt lang={name.lang} className="min-w-0 [overflow-wrap:anywhere]">
                      {name.text || options.messages.unlabelled}
                    </dt>
                    <dd className="min-w-0 [overflow-wrap:anywhere]">{shownValue}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </>
      );
      return [
        <dd
          key={statement.id}
          className="min-w-0 space-y-2 [overflow-wrap:anywhere] sm:col-start-2 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-ring [&_a]:focus-visible:outline-offset-2"
        >
          {gated ? (
            <SpoilerGate
              key={JSON.stringify([
                read.subject.id,
                read.subject.context,
                options.locale,
                reader.spoilerLevel,
                statement.id,
                statement.property,
                statement.value,
                statement.qualifiers,
              ])}
              label={options.messages.spoilerShow}
              hideLabel={options.labels.spoilerHide}
            >
              {body}
            </SpoilerGate>
          ) : (
            body
          )}
          <div className="flex min-w-0 flex-wrap items-start gap-x-3 [&_a]:ms-0">
            <StatementCorrectionLink
              id={read.subject.id}
              title={pageText(read.subject.labels, options.locale).text}
              statement={statement.id}
              property={property}
              datatype={statement.property.data_type}
              locale={options.locale}
            />
            <ValueExplanationEntry
              id={read.subject.id}
              title={pageText(read.subject.labels, options.locale, original).text}
              statement={statement.id}
              property={property}
              context={read.subject.context}
              locale={options.locale}
            />
          </div>
        </dd>,
      ];
    });
    if (!values.length) continue;
    groups.set(
      property,
      <div
        key={property}
        className="grid min-w-0 gap-y-2 border-b border-border/60 pb-5 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] sm:gap-x-6 in-data-[density=compact]:pb-3"
      >
        <dt lang={label.lang} className="min-w-0 font-semibold [overflow-wrap:anywhere]">
          {fieldLabel(label, options.locale).text || options.messages.unlabelled}
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
  const spoilerKeywordPreview = options.overview ? spoilerKeywords.slice(0, 6) : spoilerKeywords;
  const spoilerKeywordIdentity = spoilerKeywordPreview
    .map(({ statement, text }) => [statement.id, text, spoilerLevel(statement)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const spoilerKeywordKey = JSON.stringify([
    read.subject.id,
    read.subject.context,
    options.locale,
    reader.spoilerLevel,
    spoilerKeywordIdentity,
  ]);
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
      {visibleKeywords.length
        ? tagList(options.overview ? visibleKeywords.slice(0, 6) : visibleKeywords, 'subject-tags')
        : null}
      {spoilerKeywords.length ? (
        <SpoilerGate
          key={spoilerKeywordKey}
          label={options.messages.spoilerShow}
          hideLabel={options.labels.spoilerHide}
        >
          {tagList(spoilerKeywordPreview, 'subject-spoiler-tags')}
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
      records,
      urls: [...urls].filter((url) => !records.some((record) => isRecord(record) && record.url === url)),
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
  pageTarget,
  context,
  continuation,
  listTarget,
  fullList,
  realm,
  cacheReader,
  account,
  operator,
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
  readingView,
  children,
}: {
  locale: string;
  subject?: string | null;
  subjectLabel?: string;
  pageTarget?: MemberPageTarget | undefined;
  context?: SelectedContext | undefined;
  continuation?: PageContinuation | undefined;
  listTarget?: TypeListTarget | undefined;
  fullList?: string | undefined;
  realm?: string | undefined;
  cacheReader?: string | null | undefined;
  /** The account of an agent page, and the address of its overview. */
  account?: { id: string; handle: string };
  operator?: { id: string; handle: string | null; displayName: string | null };
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
  /** Only Overview bounds fact previews; Details retains every admitted value. */
  readingView?: string;
  children?: ReactNode;
}) {
  // Page documents have already passed the composition contract at the kernel boundary.
  const composition = document as CompositionDocument;
  const plan = planReads(platformRegistry, composition, {
    subject,
    account: account ?? null,
    ...(context ? { context } : {}),
    ...(continuation ? { continuation } : {}),
  });
  const shown = new Set(shownProperties(composition));
  const resolved = { ...subjectMessages, ...messages };
  const labels: ValueLabels = {
    spoilerShow: resolved.spoilerShow,
    spoilerHide: m.subject_spoiler_hide({}, { locale: locale as never }),
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
    ...(subject ? { subject } : {}),
    messages: resolved,
    link,
    reader,
    frame: { ...(typeLabel ? { typeLabel } : {}), ...(ratio ? { ratio } : {}) },
    labels,
    overview: readingView === 'overview',
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
        : { ok: false, status: result?.status },
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
          facts: statementList(
            aboutRead,
            options.overview && Array.isArray(firstStatements.props.properties)
              ? firstStatements.props.properties.slice(0, 8)
              : firstStatements.props.properties,
            'subject-facts',
          ),
          tags: aboutRead?.tags ?? null,
        }
      : undefined;
  const overviewValue: overview.OverviewValue = {
    locale,
    // Public pages intentionally use a null reader partition; do not interpret that as a missing page identity.
    cacheReader: cacheReader ?? null,
    pageTarget: pageTarget ?? listTarget,
    subject,
    ...(overviewSubjectLabel !== undefined ? { subjectLabel: overviewSubjectLabel } : {}),
    ...(account ? { account } : {}),
    ...(base !== undefined ? { agentBase: base } : {}),
    ...(profile ? { profile } : {}),
    ...(operator ? { operator } : {}),
    link,
    reader,
    labels,
    unlabelled: resolved.unlabelled,
    spoilerShow: resolved.spoilerShow,
    details: resolved.details,
    cover: resolved.cover,
    coverVia: resolved.coverVia,
    source: resolved.source,
    licence: resolved.licence,
    sources: resolved.sources,
    sections,
    ...(context ? { context } : {}),
    ...(realm ? { realm } : {}),
    ...(about ? { about } : {}),
    relations,
    relationNodes: nodesOfType(composition.content, 'RelationGroups'),
    ...(zoneRatio ? { ratio: zoneRatio } : {}),
    ...(ratio ? { frameRatio: ratio } : {}),
  };
  return (
    <overview.OverviewContext.Provider value={overviewValue}>
      <TypeListContext.Provider
        value={{ ...(listTarget ? { target: listTarget } : {}), ...(fullList ? { full: fullList } : {}) }}
      >
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
      </TypeListContext.Provider>
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

/** Entry to the current, public per-field explanation, even when no citations were supplied. */
export function SubjectSourcesLink() {
  const { subject, locale, link: Link } = useContext(PageContext);
  const value = useContext(overview.OverviewContext);
  if (!subject) return null;
  const href = subjectHref({ id: subject, label: value?.subjectLabel ?? '' }, locale).href;
  return (
    <p className="text-sm">
      <Link className="text-primary underline underline-offset-4" href={`${href}/sources`}>
        {m.sources_open_detail({}, { locale: locale as never })}
      </Link>
    </p>
  );
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

export const dataComponents = {
  Members,
  Cover: overview.Cover,
  AccountIdentity: accounts.AccountIdentity,
  AccountPosts: accounts.AccountPosts,
  AccountThreads: accounts.AccountThreads,
  AccountCollections: accounts.AccountCollections,
  Summary: overview.Summary,
  RelationGroups: overview.RelationGroups,
  OutgoingRelations: overview.OutgoingRelations,
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
