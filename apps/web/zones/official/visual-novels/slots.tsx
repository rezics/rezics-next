import type { BrowseHeaderSlotProps, WorkCardSlotProps, WorkDetailSlotProps, ZoneMatchedRelease, ZoneSlotProps }
  from '@rezics/zone-sdk';
import { strings } from './strings.ts';

// Slots of the official Visual Novels Zone. They render only what the platform passes in: the release
// filter control, the releases Main matched for each result, and the regions of a Work's page. The release
// line states exactly the releases in `matches`; no slot infers a playable release from a title or language.

type Strings = ReturnType<typeof strings>;

function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const completenessWord = (value: ZoneMatchedRelease['completeness'], t: Strings) => ({ complete: t.releaseComplete,
  partial: t.releasePartial, trial: t.releaseTrial, unknown: t.releaseUnknown })[value];

/** "English · Windows · complete · fan translation by Foo": one matched release, fact by fact. */
export function ReleaseLine({ match, locale }: { match: ZoneMatchedRelease; locale: string }) {
  const t = strings(locale);
  const facts = [match.language ? languageName(match.language, locale) : null, match.platform,
    completenessWord(match.completeness, t)].filter(fact => fact !== null);
  const origin = match.origin === 'official' ? t.officialRelease
    : match.translators.length ? t.fanTranslationBy('⁣').split('⁣') : t.fanTranslation;
  return <span data-release-line="">
    {facts.join(' · ')}{' · '}
    {typeof origin === 'string' ? origin : <>{origin[0]}{match.translators.map((translator, index) =>
      <span key={`${translator.value}-${index}`}>{index ? ', ' : ''}<bdi lang={translator.lang || undefined}
        dir={translator.dir}>{translator.value}</bdi></span>)}{origin[1]}</>}
  </span>;
}

/**
 * A result row: the platform's own row (cover, title, library state) and, under it, the release or releases
 * Main matched. A card that is not a release-filtered result has no `matches` and keeps the platform row.
 */
export function VisualNovelCard({ zone, matches, fallback }: WorkCardSlotProps) {
  if (!matches) return fallback;
  const t = strings(zone.locale);
  return <div className="vn-card">
    {fallback}
    {matches.releases.length ? <ul aria-label={t.matchedRelease} className="vn-matches">
      {matches.releases.map(match => <li key={match.id} data-release={match.id}>
        <ReleaseLine match={match} locale={zone.locale} /></li>)}
    </ul> : null}
    {matches.more ? <p className="vn-more">{t.moreMatches}</p> : null}
  </div>;
}

function Source({ zone, Link, note }: Pick<ZoneSlotProps, 'zone' | 'Link'> & { note?: boolean }) {
  const t = strings(zone.locale);
  return <p className="vn-source">
    {note ? <>{t.filterNote}{' '}</> : null}{t.attribution}{' '}
    <Link href="https://vndb.org" rel="noreferrer">{t.attributionLink}</Link>
  </p>;
}

/** Above the results: the release filter, and where its data comes from. */
export function VisualNovelBrowseHeader({ zone, filter, Link }: BrowseHeaderSlotProps) {
  return <div className="vn-browse-head">
    {filter}
    <Source zone={zone} Link={Link} note />
  </div>;
}

/** A visual novel's page leads with where it can be played, then the description. */
export function VisualNovelDetail({ zone, regions, Link }: WorkDetailSlotProps) {
  const t = strings(zone.locale);
  return <div className="vn-detail">
    <section aria-labelledby="vn-availability" className="vn-availability">
      <h2 id="vn-availability" className="sr-only">{t.availability}</h2>
      {regions.availability}
      <Source zone={zone} Link={Link} />
    </section>
    <section aria-labelledby="vn-about" className="vn-about">
      <h2 id="vn-about" className="sr-only">{t.about}</h2>
      {regions.about}
    </section>
    {regions.volumes}
    {regions.progress}
  </div>;
}

/** What this Zone does not cover, the data's source and the sibling Zone over the same library. */
export function VisualNovelFooter({ zone, Link }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="vn-footer">
    <div className="vn-footer-grid">
      <section aria-labelledby="vn-coverage">
        <h2 id="vn-coverage" className="vn-footer-title">{t.coverageTitle}</h2>
        <p>{t.coverageBody}</p>
        <Source zone={zone} Link={Link} />
      </section>
      <section aria-labelledby="vn-sibling">
        <h2 id="vn-sibling" className="vn-footer-title">{t.siblingTitle}</h2>
        <p>{t.siblingBody}</p>
        <p><Link href="/r/light-novels">{t.siblingLink}</Link></p>
      </section>
    </div>
  </footer>;
}
