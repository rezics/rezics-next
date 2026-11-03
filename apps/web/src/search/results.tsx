import type { KernelClient } from '@rezics/client';
import type { CalendarDate } from '@rezics/filter';
import { pickText } from '@rezics/composition';
import {
  Cover,
  fallbackListFactProperties,
  fallbackListPresentation,
  parseListPresentation,
  sharedRatio,
  type CoverRatio,
  type ListPresentation,
} from '@rezics/ui/cover';
import { ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { ListRow, ListRowControl } from '@rezics/ui/list-row';
import { MetaLine } from '@rezics/ui/meta-line';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ItemDescription } from '@rezics/ui/shadcn/item';
import { cn } from '@rezics/ui/utils';
import { PublicRatingFigure } from '../features/pages/public-rating-figure';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../media/summary';
import { listKeyFacts } from '../media/type-presentation';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { pickResultAliases } from './result-aliases';
import { hitCalendarDate, releaseDateText } from './release-search-date';

type NativeHit = Extract<
  NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>,
  { subjects: unknown }
>['subjects'][number];
export type Fact = NonNullable<NativeHit['facts']>[string][number];

export type SubjectHit = {
  id: string;
  type: string;
  labels: Record<string, string>;
  summary?: SubjectSummary;
  facts?: Record<string, Fact[]>;
  /** An optional presentation already resolved from the release read by the caller. */
  listPresentation?: ListPresentation;
};
export type ResultHit = SubjectHit & {
  descriptions?: Record<string, string>;
  aliases?: Record<string, string[]>;
  figure?: NativeHit['figure'];
  storyOverlay?: boolean;
};

export function localizedLabel(labels: Record<string, string>, locale: string): { text: string; lang?: string } {
  const picked = pickText(labels, locale);
  return { text: picked.text, ...(picked.lang ? { lang: picked.lang } : {}) };
}

export function hitYear(facts: SubjectHit['facts'], properties?: readonly string[]): number | undefined {
  return hitCalendarDate(facts, properties)?.year;
}

export function yearText(year: number, locale: string): string {
  return new Intl.NumberFormat(locale, { useGrouping: false }).format(year);
}

export function SubjectMeta({
  type,
  year,
  date,
  locale,
  className,
}: {
  type: { text: string; lang?: string | undefined };
  year: number | undefined;
  date?: CalendarDate;
  locale: string;
  className?: string;
}) {
  const recordedDate = date ?? (year === undefined ? undefined : { year });
  const dateText = recordedDate && releaseDateText(recordedDate, locale);
  if (!type.text && !dateText) return null;
  return (
    <span className={className}>
      <MetaLine
        items={[
          type.text ? <span lang={type.lang}>{type.text}</span> : null,
          dateText ? <span data-slot={recordedDate?.month === undefined ? 'year' : 'date'}>{dateText}</span> : null,
        ]}
      />
    </span>
  );
}

/** One ratio for suggestion thumbnails; search result covers retain each subject type's own ratio. */
export function listRatio(hits: readonly SubjectHit[]): CoverRatio {
  return sharedRatio(hits.map((hit) => coverSubject(hit.id, '', hit.summary, hit.type)));
}

type ResultPresentation = {
  locale: string;
  hitTypes: Record<string, Record<string, string>>;
  yearProperties: readonly string[];
  /** Optional adapter for an already available release presentation; it performs no reads. */
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
};

/** Page-local ContentItem composition: visible title anchor, independent facts and a passive text preview. */
export function ResultRow({
  hit,
  locale,
  hitTypes,
  yearProperties,
  listPresentationFor,
}: ResultPresentation & { hit: ResultHit }) {
  const label = localizedLabel(hit.labels, locale);
  const title = label.text || m.subject_value_unlabelled({}, { locale: locale as never });
  const subjectLink = subjectHref({ id: hit.id, label: title }, locale);
  const typeName = localizedLabel(Object.hasOwn(hitTypes, hit.type) ? (hitTypes[hit.type] ?? {}) : {}, locale);
  const description = localizedLabel(hit.descriptions ?? {}, locale);
  const date = hitCalendarDate(hit.facts, yearProperties);
  const subject = coverSubject(hit.id, title, hit.summary, hit.type);
  const releasedPresentation =
    parseListPresentation(hit.listPresentation) ?? parseListPresentation(listPresentationFor?.(subject.types));
  const listPresentation = releasedPresentation ?? fallbackListPresentation(subject.types);
  const factProperties = releasedPresentation?.keyFacts ?? fallbackListFactProperties(subject.types);
  // Keep each native item target attached while reusing the shared formatter and its four-value cap.
  const facts = (factProperties ?? Object.keys(hit.facts ?? {}))
    .slice(0, 4)
    .flatMap((property) =>
      (hit.facts?.[property] ?? []).slice(0, 3).flatMap((value) =>
        listKeyFacts({ [property]: [value] }, [property], yearProperties, locale).map((formatted) => ({
          ...formatted,
          ...(value.kind === 'item' ? { id: value.id } : {}),
        })),
      ),
    )
    .slice(0, 4);
  const badgeProperties = fallbackListFactProperties(subject.types) ?? [];
  const pickedAliases = pickResultAliases(hit.aliases, locale);
  const aliasLanguage = pickedAliases?.language;
  const aliases = pickedAliases?.aliases;
  return (
    <ListRow forceOverlay={hit.storyOverlay ?? false} className="flex min-w-0 items-start gap-3 py-3 sm:gap-4 sm:py-4">
      <div data-content-item-slot="visual" className="shrink-0 [&_button]:relative [&_button]:z-10">
        <div
          data-slot="member-list-row-cover"
          className={listPresentation?.imageAspect === 'landscape' ? 'w-32 sm:w-48' : 'w-[72px] sm:w-24'}
        >
          <Cover
            subject={subject}
            cover={coverOf(hit.summary)}
            src={coverSrc}
            size="fill"
            decorative
            {...(listPresentation ? { listPresentation } : {})}
          />
        </div>
      </div>
      <div
        data-slot="item-content"
        className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4"
      >
        <div className="min-w-0 wrap-anywhere">
          <ContentItemHeading
            lang={label.lang}
            dir="auto"
            data-slot="member-list-row-title"
            className="text-[17px] leading-snug font-semibold sm:text-lg md:text-xl"
          >
            <ContentItemTitleLink
              href={subjectLink.href}
              lang={label.lang}
              data-slot="list-row-link"
              className="block after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
            >
              <span className="line-clamp-2 sm:line-clamp-1">{title}</span>
            </ContentItemTitleLink>
          </ContentItemHeading>
          {typeName.text || date !== undefined || aliases?.length || facts.length > 0 ? (
            <ListRowControl
              data-content-item-slot="metadata"
              className="mt-2 flex min-w-0 flex-col gap-1 text-sm text-muted-foreground"
            >
              <SubjectMeta type={typeName} year={date?.year} date={date} locale={locale} />
              {aliases?.length ? (
                <p data-slot="search-result-aliases" lang={aliasLanguage} dir="auto" className="line-clamp-2">
                  {aliases.join(' · ')}
                </p>
              ) : null}
              {facts.length > 0 ? (
                <p data-slot="member-list-row-facts">
                  <MetaLine
                    items={facts.map((fact, index) => (
                      <span
                        key={index}
                        lang={fact.lang}
                        dir="auto"
                        data-property={fact.property}
                        className={
                          badgeProperties.includes(fact.property)
                            ? 'rounded-sm bg-muted px-1.5 py-0.5 text-xs tabular-nums'
                            : undefined
                        }
                      >
                        {fact.id ? (
                          <a
                            className={cn(
                              buttonVariants({ variant: 'link' }),
                              'h-auto min-h-11 min-w-11 max-w-full justify-start whitespace-normal px-1 py-1 text-start underline',
                            )}
                            href={subjectHref({ id: fact.id, label: fact.text }, locale).href}
                          >
                            {fact.text}
                          </a>
                        ) : (
                          fact.text
                        )}
                      </span>
                    ))}
                  />
                </p>
              ) : null}
            </ListRowControl>
          ) : null}
          {description.text ? (
            <div data-content-item-slot="preview" className="mt-2 min-w-0 text-sm leading-relaxed">
              <ItemDescription lang={description.lang} dir="auto" className="text-start">
                {description.text}
              </ItemDescription>
            </div>
          ) : null}
        </div>
        {hit.figure ? (
          <ListRowControl
            data-content-item-slot="trailing"
            className="mt-3 min-w-0 max-w-48 sm:col-start-2 sm:row-start-1 sm:mt-0 sm:text-right"
          >
            <PublicRatingFigure figure={hit.figure} locale={locale} />
          </ListRowControl>
        ) : null}
      </div>
    </ListRow>
  );
}

export function ResultList({ hits, ...presentation }: ResultPresentation & { hits: readonly ResultHit[] }) {
  return (
    <ul role="list" className="space-y-2">
      {hits.map((hit) => (
        <ResultRow key={`${hit.type}:${hit.id}`} hit={hit} {...presentation} />
      ))}
    </ul>
  );
}
