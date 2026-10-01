import type { BrowseHeaderSlotProps, WorkCardSlotProps, ZoneMatchedRelease, ZoneSlotProps } from '@rezics/zone-sdk';
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

/** The translators as a list in the reader's language ("A, B and C"), each name in its own language and direction. */
function Translators({ names, locale }: { names: ZoneMatchedRelease['translators']; locale: string }) {
  const parts = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
    .formatToParts(names.map((_, index) => String(index)));
  return <>{parts.map((part, index) => {
    const name = part.type === 'element' ? names[Number(part.value)] : undefined;
    return name ? <bdi key={index} lang={name.lang || undefined} dir={name.dir}>{name.value}</bdi>
      : <span key={index}>{part.value}</span>;
  })}</>;
}

/** "English · Windows · complete · fan translation by Foo": one matched release, fact by fact. */
export function ReleaseLine({ match, locale }: { match: ZoneMatchedRelease; locale: string }) {
  const t = strings(locale);
  const facts = [match.language ? languageName(match.language, locale) : null, match.platform,
    completenessWord(match.completeness, t)].filter(fact => fact !== null);
  const origin = match.origin === 'official' ? t.officialRelease
    : match.translators.length ? t.fanTranslationBy('\u2063').split('\u2063') : t.fanTranslation;
  return <span data-release-line="">
    {facts.join(' · ')}{' · '}
    {typeof origin === 'string' ? origin : <>{origin[0]}<Translators names={match.translators} locale={locale} />
      {origin[1]}</>}
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

/** VNDB's name and licences, in text: a package links only into the platform. */
function Source({ zone, note }: Pick<ZoneSlotProps, 'zone'> & { note?: boolean }) {
  const t = strings(zone.locale);
  return <p className="vn-source">{note ? <>{t.filterNote}{' '}</> : null}{t.attribution}</p>;
}

/** Above the results: the release filter, and where its data comes from. */
export function VisualNovelBrowseHeader({ zone, filter }: BrowseHeaderSlotProps) {
  return <div className="vn-browse-head">
    {filter}
    <Source zone={zone} note />
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
        <Source zone={zone} />
      </section>
      <section aria-labelledby="vn-sibling">
        <h2 id="vn-sibling" className="vn-footer-title">{t.siblingTitle}</h2>
        <p>{t.siblingBody}</p>
        <p><Link href="/r/light-novels">{t.siblingLink}</Link></p>
      </section>
    </div>
  </footer>;
}
