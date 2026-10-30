import { documentText } from '@rezics/document';
import { pickLanguage } from '@rezics/composition';
import { coverImagePreload, type CoverSummary } from '@rezics/ui/cover';
import { coverSrc } from '../../media/cover-src';
import { originalLanguage } from '../../subject/language';
import { locales, type Locale } from '../../paraglide/runtime.js';
import { pageHead, type PagePaths } from '../../shell/head';
import { subjectBody, subjectDisplayLabel, subjectPageJsonLd, type SubjectPageData } from './subject';
import { bestRank, isRecord, pageText, spoilerLevel, type Stmt } from './shared';
import { readableDocument } from './values';

type SubjectHeadContext = {
  origin: string;
  locale: string;
  path: string;
  paths?: Record<string, string>;
  typeLabel?: string;
  schemaOrgType?: string;
  view?: string;
  viewLabel?: string;
  /** The one-based relations page; only pages after the first are excluded from indexing. */
  page?: number;
  cursor?: string;
  includeJsonLd?: boolean;
  ratings?: { figures: { population: string; count: number; mean?: number; remaining?: number }[] };
};

const DATE_PROPERTIES = ['schema:datePublished', 'schema:startDate', 'schema:dateCreated'];
const GLOBAL = '00000000-0000-8000-8000-000000000000';

function pathForLocale(path: string, locale: string): string {
  const prefix = `/${encodeURIComponent(locale)}`;
  return path === prefix ? '/' : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

function localePaths(paths: Record<string, string> | undefined): PagePaths | undefined {
  if (!paths) return;
  return Object.fromEntries(
    locales.map((locale) => [locale, pathForLocale(paths[locale] ?? '/', locale)]),
  ) as PagePaths;
}

function releaseYear(
  subject: NonNullable<ReturnType<typeof subjectBody>>['subject'],
  locale: string,
): string | undefined {
  const statements = subject.statements as unknown as Record<string, Stmt[]>;
  for (const property of DATE_PROPERTIES) {
    const chosen = bestRank(Object.hasOwn(statements, property) ? (statements[property] ?? []) : []);
    for (const statement of chosen) {
      const content = statement.value.type === 'value' ? statement.value.content : undefined;
      if (!isRecord(content) || typeof content.time !== 'string') continue;
      const match = /^\+?(\d{4,})-/.exec(content.time);
      if (!match) continue;
      const date = new Date(0);
      date.setUTCFullYear(Number(match[1]), 0, 1);
      if (Number.isFinite(date.getTime()))
        return new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(date);
    }
  }
}

function summaryText(subject: NonNullable<ReturnType<typeof subjectBody>>['subject'], locale: string): string {
  const held = Object.hasOwn(subject.statements, 'schema:abstract')
    ? (subject.statements as unknown as Record<string, Stmt[]>)['schema:abstract']
    : undefined;
  const documents = bestRank(held ?? []).flatMap((statement) => {
    if (spoilerLevel(statement) > 0 || statement.value.type !== 'value' || !isRecord(statement.value.content))
      return [];
    const content = statement.value.content;
    const document = readableDocument(content.document);
    return document && typeof content.language === 'string' ? [{ document, language: content.language }] : [];
  });
  if (!documents.length) return '';
  const original = originalLanguage(subject);
  const language = pickLanguage(
    documents.map((document) => document.language),
    locale,
    original,
  );
  const selected = documents.find((document) => document.language === language) ?? documents[0]!;
  return documentText(selected.document);
}

function descriptionFor(
  subject: NonNullable<ReturnType<typeof subjectBody>>['subject'],
  locale: string,
): string | undefined {
  const description = pageText(subject.descriptions, locale, originalLanguage(subject)).text;
  return description || summaryText(subject, locale) || undefined;
}

function visibleStatement(subject: NonNullable<ReturnType<typeof subjectBody>>['subject']): boolean {
  return Object.values(subject.statements).some((statements) =>
    bestRank(statements as unknown as Stmt[]).some((statement) => spoilerLevel(statement) === 0),
  );
}

function coverOf(subjectSummary: unknown): CoverSummary | undefined {
  if (!isRecord(subjectSummary) || !isRecord(subjectSummary.cover)) return;
  const cover = subjectSummary.cover;
  if (
    typeof cover.media !== 'string' ||
    !Array.isArray(cover.variants) ||
    cover.variants.length === 0 ||
    cover.withheld === 'suitability'
  )
    return;
  return cover as unknown as CoverSummary;
}

/** Subject metadata and preload data use the same public page read, cover summary and locale fallback as the page. */
export function subjectHead(page: SubjectPageData, context: SubjectHeadContext) {
  const read = subjectBody(page);
  const locale = context.locale;
  const paths = localePaths(context.paths);
  if (!read)
    return pageHead(
      {},
      {
        origin: context.origin,
        locale: locale as Locale,
        path: pathForLocale(context.path, locale),
        ...(paths === undefined ? {} : { paths }),
      },
    );

  const titleLabel = subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject));
  const parts = [context.typeLabel, releaseYear(read.subject, locale)].filter((part): part is string => !!part);
  const title = `${titleLabel}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const titleWithView = context.viewLabel || context.view ? `${title} – ${context.viewLabel ?? context.view}` : title;
  const description = descriptionFor(read.subject, locale);
  const cover = coverOf(read.summary);
  const largest = cover?.variants.reduce((current, variant) => (variant.width > current.width ? variant : current));
  const jsonLd =
    context.includeJsonLd === false
      ? undefined
      : subjectPageJsonLd(page, locale, {
          origin: context.origin,
          ...(context.typeLabel ? { typeLabel: context.typeLabel } : {}),
          ...(context.schemaOrgType ? { schemaOrgType: context.schemaOrgType } : {}),
          ...(context.ratings ? { ratings: context.ratings } : {}),
        });
  const result = pageHead(
    {
      title: titleWithView,
      ...(description ? { description } : {}),
      ...(cover && largest
        ? {
            image: {
              url: coverSrc(cover.media, largest.format, largest.width),
              width: largest.width,
              height: Math.round((cover.height * largest.width) / Math.max(cover.width, 1)),
              alt: titleLabel,
            },
          }
        : {}),
      ...(context.cursor !== undefined || (context.view === 'relations' && (context.page ?? 1) > 1)
        ? { robots: 'noindex, follow' }
        : !description && !cover && !visibleStatement(read.subject)
          ? { robots: 'noindex, follow' }
          : {}),
      ...(jsonLd ? { jsonLd: JSON.parse(jsonLd) } : {}),
    },
    {
      origin: context.origin,
      locale: locale as Locale,
      path: pathForLocale(context.path, locale),
      ...(paths === undefined ? {} : { paths }),
    },
  );
  if (!cover) return result;
  return {
    ...result,
    links: [
      {
        rel: 'preload',
        as: 'image',
        ...coverImagePreload(cover, coverSrc),
        fetchpriority: 'high',
      },
    ],
  };
}
