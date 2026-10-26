import { pickText, planReads, platformRegistry, shownProperties, type CompositionDocument } from '@rezics/composition';
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { Related, Subject } from '../../subject/types';
import type { PageDocument } from './render';

export type PageMessages = {
  unknown: string;
  none: string;
  unlabelled: string;
  sources: string;
  aliases: string;
  search: string;
};

type LinkProps = { href: string; lang?: string; children: ReactNode };
type PageLink = ComponentType<LinkProps>;
type Options = { locale: string; messages: PageMessages; link: PageLink };
type Snak = { property: { id: string; data_type: string }; value: { type: string; content?: unknown } };
type SubjectRead = { subject: Subject; related: Related };
type SearchRead = { subjects: Pick<Subject, 'id' | 'labels'>[] };
type PreparedRead = { header?: ReactNode; groups?: Map<string, ReactNode>; more?: ReactNode[]; list?: ReactNode[] };

const PageContext = createContext<{ locale: string; messages: PageMessages; nodes: Map<string, PreparedRead> }>({
  locale: 'en',
  messages: { unknown: '', none: '', unlabelled: '', sources: '', aliases: '', search: '' },
  nodes: new Map(),
});
const linkClass = 'underline-offset-4';
const linkColor = 'text-primary';
const listClass = 'space-y-5 in-data-[density=compact]:space-y-3';

export function usePageLocale(): string {
  return useContext(PageContext).locale;
}

export function usePageMessages(): PageMessages {
  return useContext(PageContext).messages;
}

/** Localized props and read text share the composition fallback policy. */
export function pageText(value: unknown, locale: string) {
  const safe = typeof value === 'string' || isRecord(value) ? value : '';
  const picked = pickText(safe as string | Record<string, string>, locale);
  return {
    text: typeof picked.text === 'string' ? picked.text : '',
    lang: picked.lang && picked.lang !== locale ? picked.lang : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function PlainLink({ href, lang, children }: LinkProps) {
  return (
    <a href={href} lang={lang}>
      {children}
    </a>
  );
}

/** Only absolute web URLs become external links, including in references. */
function webUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function ExternalValue({ value }: { value: string }) {
  return webUrl(value) ? (
    <a className={`${linkClass} ${linkColor} break-all`} href={value}>
      {value}
    </a>
  ) : (
    <span>{value}</span>
  );
}

function itemLink(id: string, labels: unknown, options: Options) {
  const label = pageText(labels, options.locale);
  const Link = options.link;
  return (
    <span className={`${linkClass} ${label.text ? linkColor : 'text-muted-foreground'}`}>
      <Link
        href={`/${encodeURIComponent(options.locale)}/subjects/${encodeURIComponent(id)}`}
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
  if (typeof content !== 'string') return null;
  return property.data_type === 'url' ? <ExternalValue value={content} /> : <span>{content}</span>;
}

function subjectHeader(subject: Subject, options: Options) {
  const label = pageText(subject.labels, options.locale);
  const description = pageText(subject.descriptions, options.locale);
  // Select a language for the alias list with the same policy as scalar text.
  const aliasLanguage = pickText(
    Object.fromEntries(Object.keys(subject.aliases).map((lang) => [lang, lang])),
    options.locale,
  ).lang;
  const aliases = aliasLanguage ? (subject.aliases[aliasLanguage] ?? []) : [];
  return (
    <header className="min-w-0 space-y-3 in-data-[density=compact]:space-y-2">
      <h1
        lang={label.lang}
        className={`font-serif text-4xl font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-5xl${label.text ? '' : ' text-muted-foreground'}`}
      >
        {label.text || options.messages.unlabelled}
      </h1>
      {description.text && (
        <p lang={description.lang} className="max-w-prose text-pretty leading-7 text-muted-foreground">
          {description.text}
        </p>
      )}
      {aliases.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{options.messages.aliases}</h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {aliases.map((alias, index) => {
              const text = pageText({ [aliasLanguage!]: alias }, options.locale);
              return (
                <li key={index} lang={text.lang}>
                  {text.text}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </header>
  );
}

/** Prepare every property once; multiple nodes can share the same subject read. */
function prepareSubject(read: SubjectRead, options: Options, shown: Set<string>): PreparedRead {
  const groups = new Map<string, ReactNode>();
  const relatedLabel = (id: string) =>
    pageText(Object.hasOwn(read.related, id) ? read.related[id]?.labels : {}, options.locale);
  for (const [property, statements] of Object.entries(read.subject.statements)) {
    const preferred: typeof statements = [];
    const normal: typeof statements = [];
    for (const statement of statements) {
      if (statement.rank === 'preferred') preferred.push(statement);
      else if (statement.rank === 'normal') normal.push(statement);
    }
    const chosen = preferred.length ? preferred : normal;
    if (!chosen.length) continue;
    const label = relatedLabel(property);
    const sources = new Set<string>();
    const values = chosen.map((statement) => {
      for (const reference of statement.references) {
        for (const part of reference.parts) {
          if (
            part.property.data_type === 'url' &&
            part.value.type === 'value' &&
            typeof part.value.content === 'string'
          )
            sources.add(part.value.content);
        }
      }
      return (
        <dd key={statement.id} className="min-w-0 space-y-2 break-words sm:col-start-2">
          {inlineValue(statement, read.related, options)}
          {statement.qualifiers.length > 0 && (
            <dl className="ms-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {statement.qualifiers.map((qualifier, index) => {
                const name = relatedLabel(qualifier.property.id);
                return (
                  <div className="contents" key={index}>
                    <dt lang={name.lang}>{name.text || options.messages.unlabelled}</dt>
                    <dd>{inlineValue(qualifier, read.related, options)}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </dd>
      );
    });
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
        {sources.size > 0 && (
          <dd className="min-w-0 space-y-1 text-sm sm:col-start-2">
            <span className="font-medium text-muted-foreground">{options.messages.sources}</span>
            <ul className="list-disc space-y-1 ps-5">
              {[...sources].map((source) => (
                <li key={source}>
                  <ExternalValue value={source} />
                </li>
              ))}
            </ul>
          </dd>
        )}
      </div>,
    );
  }
  return {
    header: subjectHeader(read.subject, options),
    groups,
    more: [...groups].filter(([property]) => !shown.has(property)).map(([, group]) => group),
  };
}

export function PageData({
  locale,
  subject = null,
  document,
  reads,
  messages,
  link = PlainLink,
  children,
}: {
  locale: string;
  subject?: string | null;
  document: PageDocument;
  reads: Record<string, { status: number; body: unknown }>;
  messages: PageMessages;
  link?: PageLink;
  children?: ReactNode;
}) {
  // Page documents have already passed the composition contract at the kernel boundary.
  const composition = document as CompositionDocument;
  const plan = planReads(platformRegistry, composition, { subject });
  const shown = new Set(shownProperties(composition));
  const options = { locale, messages, link };
  const prepared = new Map<string, PreparedRead>();
  for (const [key, planned] of Object.entries(plan.reads)) {
    const result = Object.hasOwn(reads, key) ? reads[key] : undefined;
    if (result?.status !== 200 || !isRecord(result.body)) continue;
    if (planned.kind === 'subject' && isRecord(result.body.subject) && isRecord(result.body.related)) {
      prepared.set(key, prepareSubject(result.body as SubjectRead, options, shown));
    } else if (planned.kind === 'search' && Array.isArray(result.body.subjects)) {
      const subjects = (result.body as SearchRead).subjects.slice(0, planned.body.limit);
      prepared.set(key, {
        list: subjects.map((item) => <li key={item.id}>{itemLink(item.id, item.labels, options)}</li>),
      });
    }
  }
  const nodes = new Map<string, PreparedRead>();
  for (const [id, key] of Object.entries(plan.nodes)) {
    const read = prepared.get(key);
    if (read) nodes.set(id, read);
  }
  return <PageContext.Provider value={{ locale, messages, nodes }}>{children}</PageContext.Provider>;
}

function useNodeRead(id: unknown) {
  return useContext(PageContext).nodes.get(typeof id === 'string' ? id : '');
}

function SubjectHeader(props: Record<string, unknown>) {
  return useNodeRead(props.id)?.header ?? null;
}

function Statements(props: Record<string, unknown>) {
  const read = useNodeRead(props.id);
  const properties = Array.isArray(props.properties) ? props.properties : [];
  const groups = properties.flatMap((property) =>
    typeof property === 'string' && read?.groups?.has(property) ? [read.groups.get(property)] : [],
  );
  return groups.length ? <dl className={listClass}>{groups}</dl> : null;
}

function MoreStatements(props: Record<string, unknown>) {
  const groups = useNodeRead(props.id)?.more;
  return groups?.length ? <dl className={listClass}>{groups}</dl> : null;
}

function SubjectList(props: Record<string, unknown>) {
  return <TypeListContent {...props} />;
}

function TypeList(props: Record<string, unknown>) {
  return <TypeListContent {...props} />;
}

function TypeListContent(props: Record<string, unknown>) {
  const list = useNodeRead(props.id)?.list;
  const locale = usePageLocale();
  const title = pageText(props.title, locale);
  if (!list?.length) return null;
  return (
    <section className="min-w-0 space-y-4 in-data-[density=compact]:space-y-3">
      <h2
        lang={title.lang}
        className="text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl"
      >
        {title.text}
      </h2>
      <ul className="space-y-2 break-words leading-7">{list}</ul>
    </section>
  );
}

export const dataComponents = { SubjectHeader, Statements, MoreStatements, SubjectList, TypeList };
