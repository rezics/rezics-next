import type { PublicFigure } from './subject-ratings';
import { documentRead, type CompositionDocument } from '@rezics/composition';
import { coverImagePreload } from '@rezics/ui/cover';
import { coverSrc } from '../../media/cover-src';
import { publicCardImage, publicCover } from '../../media/public-card';
import { originalLanguage } from '../../subject/language';
import { locales, type Locale } from '../../paraglide/runtime.js';
import { pageHead, type PagePaths } from '../../shell/head';
import { shareCardImage } from '../../shell/share-card';
import type { ShareCardProjection } from '../../media/share-card';
import { subjectBody, subjectDisplayLabel, subjectPageJsonLd, type SubjectPageData } from './subject';
import { bestRank, isRecord, pageText, spoilerLevel, type Stmt } from './shared';
import { chosenSummary } from './overview';
import { publicDocumentText } from './jsonld';

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
  ratings?: { figure: PublicFigure };
  /** Supplied only by the current anonymous page query, never by route/search input. */
  shareCard?: ShareCardProjection | undefined;
  realm?: string | undefined;
};

const DATE_PROPERTIES = ['schema:datePublished', 'schema:startDate', 'schema:dateCreated'];

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
    const eligible = Object.hasOwn(statements, property) ? (statements[property] ?? []) : [];
    const chosen = bestRank(eligible.filter((statement) => spoilerLevel(statement) === 0));
    for (const statement of chosen) {
      if (statement.property.data_type !== 'time') continue;
      const content = statement.value.type === 'value' ? statement.value.content : undefined;
      if (
        !isRecord(content) ||
        typeof content.time !== 'string' ||
        typeof content.precision !== 'number' ||
        !Number.isInteger(content.precision) ||
        content.precision < 9
      )
        continue;
      const match = /^([+-]?)(\d{4,})-/.exec(content.time);
      if (!match) continue;
      const year = Number(`${match[1]}${match[2]}`);
      const date = new Date(0);
      date.setUTCFullYear(year, 0, 1);
      if (!Number.isFinite(date.getTime())) continue;
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        ...(year <= 0 ? { era: 'short' } : {}),
        timeZone: 'UTC',
      }).format(date);
    }
  }
}

function summaryText(
  page: SubjectPageData,
  subject: NonNullable<ReturnType<typeof subjectBody>>['subject'],
  documents: unknown,
  locale: string,
): string {
  const planned = documentRead(
    page.document as CompositionDocument,
    subject.id,
    Object.keys(subject.statements),
    page.context?.id,
  );
  if (!planned?.properties.includes('schema:abstract')) return '';
  const selected = chosenSummary(subject, locale, documents);
  if (!selected || spoilerLevel(selected.statement) > 0) return '';
  return publicDocumentText(selected.document);
}

function descriptionFor(
  page: SubjectPageData,
  subject: NonNullable<ReturnType<typeof subjectBody>>['subject'],
  documents: unknown,
  locale: string,
): string | undefined {
  const description = pageText(subject.descriptions, locale, originalLanguage(subject)).text;
  return description || summaryText(page, subject, documents, locale) || undefined;
}

function visibleStatement(subject: NonNullable<ReturnType<typeof subjectBody>>['subject']): boolean {
  return Object.values(subject.statements).some(
    (statements) =>
      bestRank((statements as unknown as Stmt[]).filter((statement) => spoilerLevel(statement) === 0)).length > 0,
  );
}

/** Subject metadata and preload data use the same public page read, cover summary and locale fallback as the page. */
export function subjectHead(page: SubjectPageData, context: SubjectHeadContext) {
  const read = subjectBody(page);
  const locale = context.locale;
  const paths = localePaths(context.paths);
  if (!read || context.realm !== undefined)
    return pageHead(context.realm === undefined ? {} : { robots: 'noindex, follow' }, {
      origin: context.origin,
      locale: locale as Locale,
      path: pathForLocale(context.path, locale),
      ...(paths === undefined ? {} : { paths }),
    });

  const titleLabel = subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject));
  const parts = [context.typeLabel, releaseYear(read.subject, locale)].filter((part): part is string => !!part);
  const title = `${titleLabel}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const titleWithView = context.viewLabel || context.view ? `${title} – ${context.viewLabel ?? context.view}` : title;
  const description = descriptionFor(page, read.subject, read.documents, locale);
  const cover = publicCover(read.summary?.cover);
  const image =
    context.shareCard === undefined
      ? (publicCardImage(cover, titleLabel) ?? shareCardImage())
      : shareCardImage(context.shareCard);
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
      ...(image ? { image } : {}),
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
