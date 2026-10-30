import { pickText } from '@rezics/composition';
import {
  fallbackListFactProperties,
  fallbackListPresentation,
  parseListPresentation,
  sharedRatio,
  type CoverRatio,
  type ListPresentation,
} from '@rezics/ui/cover';
import { MemberListRow } from '@rezics/ui/list-presentation';
import { MetaLine } from '@rezics/ui/meta-line';
import { ItemDescription } from '@rezics/ui/shadcn/item';
import { m } from '../paraglide/messages.js';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../media/summary';
import { listKeyFacts } from '../media/type-presentation';
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
  /** An optional presentation already resolved from the release read by the caller. */
  listPresentation?: ListPresentation;
};
export type ResultHit = SubjectHit & {
  descriptions?: Record<string, string>;
  publicRating?: { score: number | null };
  storyOverlay?: boolean;
};

export function localizedLabel(labels: Record<string, string>, locale: string): { text: string; lang?: string } {
  const picked = pickText(labels, locale);
  return { text: picked.text, ...(picked.lang ? { lang: picked.lang } : {}) };
}

export function hitYear(facts: SubjectHit['facts'], properties?: readonly string[]): number | undefined {
  for (const property of (properties ?? Object.keys(facts ?? {})).slice(0, 4)) {
    const found = facts?.[property]?.slice(0, 3).find((value) => value.kind === 'time' && Number.isInteger(value.year));
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
      <MetaLine
        items={[
          type.text ? <span lang={type.lang}>{type.text}</span> : null,
          year !== undefined ? <span data-slot="year">{yearText(year, locale)}</span> : null,
        ]}
      />
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
  listPresentationFor,
}: {
  hits: readonly ResultHit[];
  locale: string;
  hitTypes: Record<string, Record<string, string>>;
  yearProperties: readonly string[];
  /** Optional adapter for an already available release presentation; it performs no reads. */
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
}) {
  return (
    <ul role="list" className="space-y-2">
      {hits.map((hit) => {
        const label = localizedLabel(hit.labels, locale);
        const subjectLink = subjectHref({ id: hit.id, label: label.text }, locale);
        const typeName = localizedLabel(Object.hasOwn(hitTypes, hit.type) ? (hitTypes[hit.type] ?? {}) : {}, locale);
        const description = localizedLabel(hit.descriptions ?? {}, locale);
        const year = hitYear(hit.facts, yearProperties);
        const subject = coverSubject(hit.id, label.text, hit.summary, hit.type);
        const releasedPresentation =
          parseListPresentation(hit.listPresentation) ?? parseListPresentation(listPresentationFor?.(subject.types));
        const listPresentation = releasedPresentation ?? fallbackListPresentation(subject.types);
        const factProperties = releasedPresentation?.keyFacts ?? fallbackListFactProperties(subject.types);
        const facts = listKeyFacts(hit.facts, factProperties, yearProperties, locale);
        const badgeProperties = fallbackListFactProperties(subject.types) ?? [];
        const score = hit.publicRating?.score;
        return (
          <MemberListRow
            key={hit.id}
            href={subjectLink.href}
            subject={subject}
            cover={coverOf(hit.summary)}
            src={coverSrc}
            title={label.text}
            {...(label.lang ? { titleLang: label.lang } : {})}
            {...(listPresentation ? { listPresentation } : {})}
            {...(hit.storyOverlay ? { storyOverlay: true } : {})}
            trailing={
              score !== undefined && score !== null && Number.isFinite(score) ? (
                <div className="shrink-0 text-right text-sm" data-slot="public-rating-figure">
                  <span className="block text-xs text-muted-foreground">{m.search_global_score()}</span>
                  <strong className="tabular-nums">
                    {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(score)}
                  </strong>
                </div>
              ) : undefined
            }
          >
            <SubjectMeta type={typeName} year={year} locale={locale} className="text-sm text-muted-foreground" />
            {facts.length > 0 && (
              <p data-slot="member-list-row-facts" className="text-sm">
                <MetaLine
                  items={facts.map((fact, index) => (
                    <span
                      key={index}
                      lang={fact.lang}
                      data-property={fact.property}
                      className={
                        badgeProperties.includes(fact.property)
                          ? 'rounded-sm bg-muted px-1.5 py-0.5 text-xs tabular-nums'
                          : undefined
                      }
                    >
                      {fact.text}
                    </span>
                  ))}
                />
              </p>
            )}
            {description.text && <ItemDescription lang={description.lang}>{description.text}</ItemDescription>}
          </MemberListRow>
        );
      })}
    </ul>
  );
}
