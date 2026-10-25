import { createFileRoute, Link, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { kernelClient } from '../../kernel/client';
import type { KernelClient } from '@rezics/client';
import type { Related } from '../../subject/types';

type Read = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>['data']>;
type LangText = { text: string; lang?: string };
type Value =
  | { kind: 'text'; text: LangText; muted?: boolean }
  | { kind: 'link'; text: LangText; href: string; subjectId?: string; muted?: boolean };
type SubjectPage = {
  id: string;
  label: LangText;
  description?: LangText;
  aliases: LangText[];
  groups: {
    property: LangText;
    statements: { value: Value | null; qualifiers: { property: LangText; value: Value | null }[] }[];
  }[];
  sources: string[];
};

function label(labels: Record<string, string>, locale: string): LangText {
  const order =
    locale === 'zh-Hant'
      ? ['zh-Hant', 'zh-Hans', 'en']
      : locale === 'zh-Hans'
        ? ['zh-Hans', 'zh-Hant', 'en']
        : [locale, 'en'];
  const language = order.find((key) => labels[key]) ?? Object.keys(labels)[0];
  const text = language ? labels[language]! : '';
  return { text, ...(language && language !== locale ? { lang: language } : {}) };
}

const readSubject = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('locale' in input) ||
      typeof input.locale !== 'string'
    )
      throw notFound();
    return { id: input.id, locale: input.locale };
  })
  .handler(async ({ data }): Promise<SubjectPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    // Subject reads are public; the kernel enforces visibility.
    const client = kernelClient();
    const result = await client.subjects({ id: data.id }).get();
    if (result.error) {
      if (result.status === 404) throw notFound();
      throw new Error(String(result.error.value?.title ?? 'Kernel subject read failed'));
    }
    const read = result.data as Read;
    const subject = read.subject;
    const locale = data.locale;
    if (subject.id !== data.id) throw redirect({ href: `/${locale}/subjects/${subject.id}`, statusCode: 308 });
    const related = read.related as Related;
    const render = (snak: {
      property: { data_type: string };
      value: { type: string; content?: unknown };
    }): Value | null => {
      const value = snak.value;
      if (value.type === 'somevalue') return { kind: 'text', text: { text: m.subject_value_unknown() }, muted: true };
      if (value.type === 'novalue') return { kind: 'text', text: { text: m.subject_value_none() }, muted: true };
      if (snak.property.data_type === 'wikibase-item' && typeof value.content === 'string') {
        const entry = related[value.content];
        const hrefId = entry?.redirect ?? value.content;
        return {
          kind: 'link',
          href: `/${locale}/subjects/${hrefId}`,
          subjectId: hrefId,
          text: entry ? label(entry.labels, locale) : { text: m.subject_value_unlabelled() },
          ...(!entry ? { muted: true } : {}),
        };
      }
      if (snak.property.data_type === 'quantity' && value.content && typeof value.content === 'object') {
        const quantity = value.content as { amount?: string; unit?: string };
        const number = Number(quantity.amount);
        const formatted = Number.isFinite(number)
          ? new Intl.NumberFormat(locale).format(number)
          : String(quantity.amount ?? '');
        return {
          kind: 'text',
          text: { text: `${formatted}${quantity.unit && quantity.unit !== '1' ? ` ${quantity.unit}` : ''}` },
        };
      }
      if (typeof value.content === 'string')
        return snak.property.data_type === 'url'
          ? { kind: 'link', href: value.content, text: { text: value.content } }
          : { kind: 'text', text: { text: value.content } };
      return null;
    };
    const groups: SubjectPage['groups'] = [];
    const sources = new Set<string>();
    for (const [propertyId, statements] of Object.entries(subject.statements)) {
      const preferred = statements.filter((statement) => statement.rank === 'preferred');
      const chosen = preferred.length ? preferred : statements.filter((statement) => statement.rank === 'normal');
      if (!chosen.length) continue;
      const propertyLabels = related[propertyId]?.labels ?? {};
      const group = {
        property: label(propertyLabels, locale),
        statements: chosen.map((statement) => ({
          value: render(statement),
          qualifiers: statement.qualifiers.map((qualifier) => ({
            property: label(related[qualifier.property.id]?.labels ?? {}, locale),
            value: render(qualifier),
          })),
        })),
      };
      groups.push(group);
      for (const statement of chosen)
        for (const reference of statement.references)
          for (const part of reference.parts) {
            if (
              part.property.data_type === 'url' &&
              part.value.type === 'value' &&
              typeof part.value.content === 'string'
            )
              sources.add(part.value.content);
          }
    }
    const descriptionLanguage = subject.descriptions[locale] ? locale : subject.descriptions.en ? 'en' : undefined;
    const description = descriptionLanguage
      ? {
          text: subject.descriptions[descriptionLanguage]!,
          ...(descriptionLanguage !== locale ? { lang: descriptionLanguage } : {}),
        }
      : undefined;
    return {
      id: subject.id,
      label: label(subject.labels, locale),
      ...(description ? { description } : {}),
      aliases: (subject.aliases[locale] ?? []).map((text) => ({ text })),
      groups,
      sources: [...sources],
    };
  });

export const Route = createFileRoute('/subjects/$id')({
  loader: ({ params }) => readSubject({ data: { id: params.id, locale: getLocale() } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.label.text ?? m.not_found_heading() }] }),
  component: SubjectPageView,
});

function InlineValue({ value }: { value: Value | null }) {
  if (!value) return null;
  const mutedClass = value.muted ? 'text-muted-foreground' : undefined;
  return value.kind === 'link' ? (
    value.subjectId ? (
      <Link to="/subjects/$id" params={{ id: value.subjectId }} lang={value.text.lang} className={mutedClass}>
        {value.text.text}
      </Link>
    ) : (
      <a href={value.href} lang={value.text.lang} className={mutedClass}>
        {value.text.text}
      </a>
    )
  ) : (
    <span lang={value.text.lang} className={mutedClass}>
      {value.text.text}
    </span>
  );
}
function SubjectPageView() {
  const page = Route.useLoaderData();
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <h1 lang={page.label.lang} className="font-serif text-4xl font-semibold tracking-tight">
          {page.label.text}
        </h1>
        {page.description && <p lang={page.description.lang}>{page.description.text}</p>}
        {page.aliases.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground">{m.subject_aliases()}</h2>
            <ul className="flex flex-wrap gap-2">
              {page.aliases.map((alias) => (
                <li key={alias.text} lang={getLocale()}>
                  {alias.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>
      <dl className="space-y-5">
        {page.groups.map((group, index) => (
          <div
            className="grid gap-y-2 border-b border-border/60 pb-4 sm:grid-cols-[minmax(10rem,1fr)_3fr] sm:gap-x-4"
            key={`${group.property.text}-${index}`}
          >
            <dt className="font-semibold">
              {group.property.lang ? (
                <span lang={group.property.lang}>{group.property.text}</span>
              ) : (
                group.property.text
              )}
            </dt>
            {group.statements.map((statement, statementIndex) => (
              <dd key={statementIndex} className="space-y-2 sm:col-start-2">
                <InlineValue value={statement.value} />
                {statement.qualifiers.length > 0 && (
                  <dl className="ms-4 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-muted-foreground">
                    {statement.qualifiers.map((qualifier, q) => (
                      <div className="contents" key={q}>
                        <dt lang={qualifier.property.lang}>{qualifier.property.text}</dt>
                        <dd>
                          <InlineValue value={qualifier.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </dd>
            ))}
          </div>
        ))}
      </dl>
      {page.sources.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">{m.subject_sources()}</h2>
          <ul className="list-disc space-y-1 ps-5">
            {page.sources.map((source) => (
              <li key={source}>
                <a className="break-all text-link underline" href={source}>
                  {source}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
