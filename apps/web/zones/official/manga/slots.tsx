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
import { CatalogueYearForm } from './catalogue-year.tsx';
import { strings } from './strings.ts';

// Slots of the official Manga Zone. They render only the facts the platform passes.
// A card leaves out a fact that was not recorded, so an empty grid cell stays scannable.
// The work page names each missing fact. Nothing is taken from a title, a season or a
// chapter count. Credits stay empty until that read exists.

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

/** The property's reviewed name when the page language has one; otherwise the package's word. */
function countFactLabel(facts: ZoneCatalogueFacts, fallback: string): ReactNode {
  const name = facts.countName;
  if (!name) return fallback;
  return <bdi lang={name.lang || undefined} dir={name.dir}>{name.value}</bdi>;
}

/** Format, year, declared volume count and status. Unavailable replaces the line; it does not guess. */
export function MangaFacts({ locale, work, facts, labelled }: {
  locale: string; work: Pick<ZoneWork, 'status'>; facts: ZoneCatalogueFacts | undefined; labelled: boolean;
}) {
  const t = strings(locale);
  if (!facts || facts.unavailable) return <p data-catalogue-unavailable="">{t.unavailable}</p>;
  const count = facts.count === null ? t.countMissing : t.volumes(new Intl.NumberFormat(locale).format(facts.count));
  const rows: { key: string; label: ReactNode; value: ReactNode; recorded: boolean }[] = [
    { key: 'format', label: t.formatLabel, recorded: facts.format !== null, value: facts.format
      ? <bdi lang={facts.format.lang || undefined} dir={facts.format.dir}>{facts.format.value}</bdi>
      : t.formatMissing },
    { key: 'year', label: t.yearFactLabel, recorded: facts.years.length > 0,
      value: yearsText(facts.years, locale, t.yearMissing) },
    { key: 'count', label: countFactLabel(facts, t.countLabel), recorded: facts.count !== null, value: count },
    { key: 'status', label: t.statusLabel, recorded: work.status !== null, value: statusWord(work.status, t) },
  ];
  // The work page names every gap. A card shows only what was recorded.
  const shown = labelled ? rows : rows.filter(row => row.recorded);
  if (!shown.length) return null;
  return <dl className="manga-facts" data-catalogue-facts="">
    {shown.map(row => <div key={row.key} data-catalogue-fact={row.key}>
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
  const name = work.title?.value ? `${t.panelLabel}: ${work.title.value}` : t.panelLabel;
  return <section aria-label={name} className="manga-panel" data-catalogue-panel="">
    <h2 className="manga-panel-title">{t.panelLabel}</h2>
    <MangaFacts locale={zone.locale} work={work} facts={facts} labelled />
  </section>;
}

/** Above the results: a publication year, in the browse row. The source credit stays in the footer, once. */
export function MangaBrowseHeader({ zone, year, Link }: BrowseHeaderSlotProps) {
  if (!year) return null;
  const t = strings(zone.locale);
  return <CatalogueYearForm year={year} label={t.yearLabel} submit={t.yearSubmit} clear={t.yearClear}
    directory={t.yearDirectory} bounded={t.yearBounded(String(year.window))} Link={Link} />;
}

/** Bangumi, and the CC BY-SA 3.0 deed, at the addresses the host supplies. */
function SourceCredit({ t, credit }: { t: Strings; credit: ZoneSlotProps['credit'] }) {
  const source = credit?.sourceHref
    ? <a className="underline" href={credit.sourceHref} rel="noreferrer noopener">{t.sourceName}</a> : t.sourceName;
  const licence = credit?.licenceHref
    ? <a className="underline" href={credit.licenceHref} rel="noreferrer noopener">{t.licenceName}</a> : t.licenceName;
  return <p className="manga-source">
    {t.attributionBefore}{source}{t.attributionBetween}{licence}{t.attributionAfter}
  </p>;
}

/** What this Zone covers, the source it credits, and the anime Zone beside it. */
export function MangaFooter({ zone, Link, credit }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="manga-footer">
    <div className="manga-footer-grid">
      <section aria-labelledby="manga-coverage">
        <h2 id="manga-coverage" className="manga-footer-title">{t.coverageTitle}</h2>
        <p>{t.coverageBody}</p>
        <SourceCredit t={t} credit={credit} />
      </section>
      <section aria-labelledby="manga-sibling">
        <h2 id="manga-sibling" className="manga-footer-title">{t.siblingTitle}</h2>
        <p>{t.siblingBody}</p>
        <p><Link href={zoneSiteHref('anime')}>{t.siblingLink}</Link></p>
      </section>
    </div>
  </footer>;
}
