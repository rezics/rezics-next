import { pickText } from '@rezics/composition';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { Cover, sharedRatio, type CoverRatio } from '@rezics/ui/cover';
import { ItemDescription, ItemTitle } from '@rezics/ui/shadcn/item';
import { m } from '../paraglide/messages.js';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../media/summary';
import { subjectHref } from '../subject/subject-href';

export type Fact =
  | { kind: 'item'; id: string; labels: Record<string, string> }
  | { kind: 'time'; year: number }
  | { kind: 'quantity'; amount: number; unit: string }
  | { kind: 'code'; value: string };

export type SubjectHit = {
  id: string;
  type: string;
  labels: Record<string, string>;
  summary?: SubjectSummary;
  facts?: Record<string, Fact[]>;
};
export type ResultHit = SubjectHit & {
  descriptions?: Record<string, string>;
  publicRating?: { score: number | null };
  storyOverlay?: boolean;
};

const FACT_VALUES = 3;

export function localizedLabel(labels: Record<string, string>, locale: string): { text: string; lang?: string } {
  const picked = pickText(labels, locale);
  return { text: picked.text, ...(picked.lang ? { lang: picked.lang } : {}) };
}

function factText(fact: Fact, locale: string): { text: string; lang?: string } {
  if (fact.kind === 'item') return localizedLabel(fact.labels, locale);
  if (fact.kind === 'time') return { text: String(fact.year) };
  if (fact.kind === 'quantity')
    return { text: `${new Intl.NumberFormat(locale).format(fact.amount)}${fact.unit ? ` ${fact.unit}` : ''}` };
  return { text: fact.value };
}

export function hitYear(facts: SubjectHit['facts'], properties?: readonly string[]): number | undefined {
  for (const property of properties ?? Object.keys(facts ?? {})) {
    const found = facts?.[property]?.find((value) => value.kind === 'time');
    if (found?.kind === 'time') return found.year;
  }
  return undefined;
}

export function yearText(year: number, locale: string): string {
  return new Intl.NumberFormat(locale, { useGrouping: false }).format(year);
}

export function SubjectMeta({
  type,
  year,
  locale,
  className,
}: {
  type: { text: string; lang?: string | undefined };
  year: number | undefined;
  locale: string;
  className?: string;
}) {
  if (!type.text && year === undefined) return null;
  return (
    <span className={className}>
      {type.text && <span lang={type.lang}>{type.text}</span>}
      {type.text && year !== undefined && ' · '}
      {year !== undefined && <span data-slot="year">{yearText(year, locale)}</span>}
    </span>
  );
}

/** One ratio for suggestion thumbnails; search result covers retain each subject type's own ratio. */
export function listRatio(hits: readonly SubjectHit[]): CoverRatio {
  return sharedRatio(hits.map((hit) => coverSubject(hit.id, '', hit.summary, hit.type)));
}

export function ResultList({
  hits,
  locale,
  hitTypes,
  yearProperties,
}: {
  hits: readonly ResultHit[];
  locale: string;
  hitTypes: Record<string, Record<string, string>>;
  yearProperties: readonly string[];
}) {
  return (
    <ul role="list" className="space-y-2">
      {hits.map((hit) => {
        const label = localizedLabel(hit.labels, locale);
        const subjectLink = subjectHref({ id: hit.id, label: label.text }, locale);
        const typeName = localizedLabel(Object.hasOwn(hitTypes, hit.type) ? (hitTypes[hit.type] ?? {}) : {}, locale);
        const description = localizedLabel(hit.descriptions ?? {}, locale);
        const year = hitYear(hit.facts, yearProperties);
        const facts = Object.entries(hit.facts ?? {}).flatMap(([property, values]) =>
          yearProperties.includes(property)
            ? []
            : values
                .slice(0, FACT_VALUES)
                .map((value) => factText(value, locale))
                .filter((value) => value.text),
        );
        const score = hit.publicRating?.score;
        return (
          <ListRow key={hit.id} forceOverlay={hit.storyOverlay} className="flex min-w-0 items-start gap-4 py-2">
            <ListRowLink href={subjectLink.href}>{label.text}</ListRowLink>
            <div className="w-[72px] shrink-0 sm:w-24">
              <Cover
                subject={coverSubject(hit.id, label.text, hit.summary, hit.type)}
                cover={coverOf(hit.summary)}
                size="fill"
                src={coverSrc}
                decorative
              />
            </div>
            <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
              <div data-slot="item-content" className="min-w-0 space-y-1">
                <ItemTitle className="line-clamp-none text-base" lang={label.lang}>
                  {label.text}
                </ItemTitle>
                <SubjectMeta type={typeName} year={year} locale={locale} className="text-sm text-muted-foreground" />
                {facts.length > 0 && (
                  <p className="text-sm">
                    {facts.map((fact, index) => (
                      <span key={index}>
                        {index > 0 && ' · '}
                        <span lang={fact.lang}>{fact.text}</span>
                      </span>
                    ))}
                  </p>
                )}
                {description.text && <ItemDescription lang={description.lang}>{description.text}</ItemDescription>}
              </div>
              {score !== undefined && score !== null && (
                <div className="shrink-0 text-right text-sm" data-slot="public-rating-figure">
                  <span className="block text-xs text-muted-foreground">{m.search_global_score()}</span>
                  <strong className="tabular-nums">
                    {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(score)}
                  </strong>
                </div>
              )}
            </div>
          </ListRow>
        );
      })}
    </ul>
  );
}
