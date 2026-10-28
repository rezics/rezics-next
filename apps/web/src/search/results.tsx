import { pickText } from '@rezics/composition';
import { Link } from '@tanstack/react-router';
import { Cover, sharedRatio, type CoverRatio } from '@rezics/ui/cover';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@rezics/ui/shadcn/item';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../media/summary';
import { subjectHref } from '../subject/subject-href';

export type Fact =
  | { kind: 'item'; id: string; labels: Record<string, string> }
  | { kind: 'time'; year: number }
  | { kind: 'quantity'; amount: number; unit: string }
  | { kind: 'code'; value: string };

/** What a search hit and a suggestion share: the subject, its labels and the summary that draws its cover. */
export type SubjectHit = {
  id: string;
  type: string;
  labels: Record<string, string>;
  summary?: SubjectSummary;
  facts?: Record<string, Fact[]>;
};
export type ResultHit = SubjectHit & { descriptions?: Record<string, string> };

/** At most this many values of one property are shown on a result. */
const FACT_VALUES = 3;

/** The same chain the subject page uses: the page locale, its language, sibling scripts, then English. */
export function localizedLabel(labels: Record<string, string>, locale: string): { text: string; lang?: string } {
  const picked = pickText(labels, locale);
  return { text: picked.text, ...(picked.lang ? { lang: picked.lang } : {}) };
}

/** The shown form of one fact value; an item without a label in the asked languages has nothing to show. */
function factText(fact: Fact, locale: string): { text: string; lang?: string } {
  if (fact.kind === 'item') return localizedLabel(fact.labels, locale);
  if (fact.kind === 'time') return { text: String(fact.year) };
  if (fact.kind === 'quantity')
    return { text: `${new Intl.NumberFormat(locale).format(fact.amount)}${fact.unit ? ` ${fact.unit}` : ''}` };
  return { text: fact.value };
}

/** The year of a hit: the first time value of the given properties, or of any property when none are named. */
export function hitYear(facts: SubjectHit['facts'], properties?: readonly string[]): number | undefined {
  for (const property of properties ?? Object.keys(facts ?? {})) {
    const values = facts && Object.hasOwn(facts, property) ? facts[property] : undefined;
    const found = values?.find((value) => value.kind === 'time');
    if (found?.kind === 'time') return found.year;
  }
  return undefined;
}

export function yearText(year: number, locale: string): string {
  return new Intl.NumberFormat(locale, { useGrouping: false }).format(year);
}

/** The type name and year under a subject's title, as one line. */
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

/** One ratio for a list that mixes types, from the subjects' own types. */
export function listRatio(hits: readonly SubjectHit[]): CoverRatio {
  return sharedRatio(hits.map((hit) => coverSubject(hit.id, '', hit.summary, hit.type)));
}

/** A search result list: each hit's cover frame, title, type and year, then its leading facts and description. */
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
  const ratio = listRatio(hits);
  return (
    <ItemGroup className="gap-2">
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
        return (
          <Item key={hit.id} role="listitem" variant="outline" className="items-start gap-4 flex-nowrap">
            <ItemMedia>
              <Link
                to={subjectLink.to}
                params={subjectLink.params}
                tabIndex={-1}
                aria-hidden
                className="block rounded-lg"
              >
                <Cover
                  subject={coverSubject(hit.id, label.text, hit.summary, hit.type)}
                  cover={coverOf(hit.summary)}
                  size="sm"
                  ratio={ratio}
                  src={coverSrc}
                  decorative
                />
              </Link>
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="line-clamp-none text-base">
                <Link
                  to={subjectLink.to}
                  params={subjectLink.params}
                  lang={label.lang}
                  className="underline-offset-4 hover:underline"
                >
                  {label.text}
                </Link>
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
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
}
