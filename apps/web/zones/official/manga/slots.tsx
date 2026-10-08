import {
  zoneSiteHref,
  type BrowseHeaderSlotProps,
  type CataloguePanelSlotProps,
  type WorkCardSlotProps,
  type ZoneCatalogueFacts,
  type ZoneSlotProps,
  type ZoneWork,
} from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import { strings } from './strings.ts';

// Slots of the official Manga Zone. They render only the facts the platform passes.
// A missing year, format or volume count is said to be unrecorded. Nothing here is
// taken from a title, a season or a chapter count. Credits stay empty until that read exists.

type Strings = ReturnType<typeof strings>;

function statusWord(status: ZoneWork['status'], t: Strings): string {
  if (status === 'ongoing') return t.statusOngoing;
  if (status === 'completed') return t.statusCompleted;
  if (status === 'hiatus') return t.statusHiatus;
  if (status === 'upcoming') return t.statusUpcoming;
  if (status === 'cancelled') return t.statusCancelled;
  return t.statusMissing;
}

function yearsText(years: readonly number[], locale: string, missing: string): string {
  if (!years.length) return missing;
  return new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(years.map(String));
}

/** Format, year, declared volume count and status. Unavailable replaces the line; it does not guess. */
export function MangaFacts({ locale, work, facts, labelled }: {
  locale: string; work: Pick<ZoneWork, 'status'>; facts: ZoneCatalogueFacts | undefined; labelled: boolean;
}) {
  const t = strings(locale);
  if (!facts || facts.unavailable) return <p data-catalogue-unavailable="">{t.unavailable}</p>;
  const count = facts.count === null ? t.countMissing : t.volumes(new Intl.NumberFormat(locale).format(facts.count));
  const rows: { key: string; label: string; value: ReactNode }[] = [
    { key: 'format', label: t.formatLabel, value: facts.format
      ? <bdi lang={facts.format.lang || undefined} dir={facts.format.dir}>{facts.format.value}</bdi>
      : t.formatMissing },
    { key: 'year', label: t.yearFactLabel, value: yearsText(facts.years, locale, t.yearMissing) },
    { key: 'count', label: t.countLabel, value: count },
    { key: 'status', label: t.statusLabel, value: statusWord(work.status, t) },
  ];
  return <dl className="manga-facts" data-catalogue-facts="">
    {rows.map(row => <div key={row.key} data-catalogue-fact={row.key}>
      <dt>{labelled ? row.label : <span className="manga-fact-label">{row.label}</span>}</dt>
      <dd>{row.value}</dd>
    </div>)}
  </dl>;
}

/** A browse card: the platform row (title and cover) and the catalogue line under it. */
export function MangaCard({ zone, work, facts, fallback }: WorkCardSlotProps) {
  return <article className="manga-card" data-catalogue-card="">
    {fallback}
    <MangaFacts locale={zone.locale} work={work} facts={facts} labelled={false} />
  </article>;
}

/** The compact fact panel a Work's page leads with. */
export function MangaCataloguePanel({ zone, work, facts }: CataloguePanelSlotProps) {
  const t = strings(zone.locale);
  return <section aria-label={t.panelLabel} className="manga-panel" data-catalogue-panel="">
    <h2 className="manga-panel-title">{t.panelLabel}</h2>
    <MangaFacts locale={zone.locale} work={work} facts={facts} labelled />
  </section>;
}

/** Above the results: a publication year, and where the facts come from. */
export function MangaBrowseHeader({ zone, year, Link }: BrowseHeaderSlotProps) {
  const t = strings(zone.locale);
  return <div className="manga-browse-head">
    {year ? <form action={year.action} method="get" className="manga-year" data-catalogue-year="">
      {year.kept.map(item => <input key={`${item.name}=${item.value}`} type="hidden" name={item.name} value={item.value} />)}
      <label className="manga-year-field">{t.yearLabel}
        <input name="year" defaultValue={year.value} inputMode="numeric" autoComplete="off"
          pattern="[1-9][0-9]{0,3}" />
      </label>
      <button type="submit">{t.yearSubmit}</button>
      {year.clearHref ? <Link href={year.clearHref}>{t.yearClear}</Link> : null}
      {year.directory ? null : <Link href={year.directoryHref}>{t.yearDirectory}</Link>}
      {year.bounded ? <p className="manga-year-note">{t.yearBounded}</p> : null}
    </form> : null}
    <p className="manga-source">{t.attribution}</p>
  </div>;
}

/** What this Zone covers, the export it names, and the anime Zone beside it. */
export function MangaFooter({ zone, Link }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="manga-footer">
    <div className="manga-footer-grid">
      <section aria-labelledby="manga-coverage">
        <h2 id="manga-coverage" className="manga-footer-title">{t.coverageTitle}</h2>
        <p>{t.coverageBody}</p>
        <p className="manga-source">{t.attribution}</p>
      </section>
      <section aria-labelledby="manga-sibling">
        <h2 id="manga-sibling" className="manga-footer-title">{t.siblingTitle}</h2>
        <p>{t.siblingBody}</p>
        <p><Link href={zoneSiteHref('anime')}>{t.siblingLink}</Link></p>
      </section>
    </div>
  </footer>;
}
