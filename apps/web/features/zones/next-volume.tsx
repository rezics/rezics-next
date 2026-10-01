'use client';

import type { ZoneWork } from '@rezics/zone-sdk';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { useReaderActions } from '../catalogue/reader-actions.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { languageName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import { reasonText } from '../tracking/series-progress-panel.tsx';
import type { SeriesSummary } from '../tracking/types.ts';

// The next volume of a series as Main reports it for the signed-in reader, in the language they
// chose (their edition preference, else the interface language). Nothing is computed here: the next
// part, whether it has text in that language and why it is next are Main's progress summary. Signed
// out, or for a Work that is not a series, these draw nothing.

interface Reading { language: string; series: SeriesSummary }

function useReadings(works: readonly string[], locale: UiLocale): ReadonlyMap<string, Reading> {
  const actions = useReaderActions();
  const api = actions.kind === 'ready' ? actions.tracking ?? null : null;
  const [found, setFound] = useState<ReadonlyMap<string, Reading>>(new Map());
  const key = works.join(' ');
  useEffect(() => {
    if (!api) return;
    let current = true;
    void Promise.all(works.map(async (work): Promise<[string, Reading] | null> => {
      const saved = await api.preference(work);
      const language = saved.ok && saved.data ? saved.data.language : locale;
      const read = await api.series(work, language);
      return read.ok && read.data.scope === 'disclosed-composition' ? [work, { language, series: read.data }] : null;
    })).then(items => {
      if (current) setFound(new Map(items.filter(item => item !== null)));
    });
    return () => { current = false; };
    // `key` stands for the list: a new array of the same Works is not a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, locale]);
  return found;
}

const uuid = (iri: string) => iri.slice(-36);

function NextLine({ reading, locale }: { reading: Reading; locale: UiLocale }) {
  const t = copyOf(locale);
  const next = reading.series.next;
  if (!next) return null;
  return <p data-next-volume="" data-available={String(next.part.available)} className="text-sm">
    <span className="font-medium">{t.nextPart}: </span>
    <LocalizedLink href={`/w/${uuid(next.part.work)}`} className="rounded-sm font-medium text-primary underline-offset-4
      outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
      {next.part.displayLabel || t.unnamedPart}</LocalizedLink>
    <span className="text-muted-foreground"> · {languageName(reading.language, locale)} · {reasonText(next.reason, t)}</span>
  </p>;
}

/** The next volume of one series, as a line under its card. */
export function NextVolume({ work, locale }: { work: string; locale: UiLocale }) {
  const reading = useReadings([work], locale).get(work);
  return reading ? <NextLine reading={reading} locale={locale} /> : null;
}

/**
 * "Continue your series": the series the reader has started, each with its next volume. Series the
 * reader has not started are left out; with none, nothing is drawn.
 */
export function NextVolumeShelf({ works, heading, locale }: {
  works: readonly Pick<ZoneWork, 'id' | 'href' | 'title'>[]; heading: string; locale: UiLocale;
}) {
  const readings = useReadings(works.map(work => work.id), locale);
  const started = works.flatMap(work => {
    const reading = readings.get(work.id);
    return reading?.series.next && reading.series.counts.completed > 0 ? [{ work, reading }] : [];
  });
  if (!started.length) return null;
  return <section aria-label={heading} data-next-volume-shelf="" className="grid gap-3">
    <h2 className="font-semibold text-lg">{heading}</h2>
    <ul className="grid gap-3">
      {started.map(({ work, reading }) => <li key={work.id} className="grid gap-1 rounded-xl border border-border/60 bg-card p-3">
        <LocalizedLink href={work.href} lang={work.title?.lang} dir={work.title?.dir}
          className="w-fit rounded-sm font-medium font-work-title outline-none hover:underline focus-visible:ring-2
            focus-visible:ring-ring">{work.title?.value}</LocalizedLink>
        <NextLine reading={reading} locale={locale} />
      </li>)}
    </ul>
  </section>;
}
