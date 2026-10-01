'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { useEffect, useId, useState } from 'react';
import { type UiLocale, uiLocales } from '../../i18n/define.ts';
import { useReaderActions } from '../catalogue/reader-actions.tsx';
import Link from '../shell/localized-link.tsx';
import type { TrackingApi } from './api.ts';
import { languageName, locatorParts } from './display.ts';
import { copyOf, type Copy } from './messages.ts';
import { SeriesStates } from './series-states.tsx';
import type { ReadFailure } from '../feed/types.ts';
import type { EditionChoice, EditionPreference, Editions, ProgressSummary, Relations, SeriesPart, SeriesSummary } from './types.ts';

const uuid = (iri: string) => iri.slice(-36);

/** A correspondence Main records as equivalent between this Work and another. */
export interface Counterpart { work: string; title: string }

/**
 * The Works recorded as equivalent counterparts of this one (G-831's `correspondence-equivalent`):
 * the only kind that may be offered as "also mark as read". Partial and revised correspondences are
 * different texts and offer nothing. Names come from Main's counterpart summaries.
 */
export function equivalentCounterparts(relations: Relations, definition: string): Counterpart[] {
  const found = new Map<string, Counterpart>();
  for (const entry of relations.items) {
    const rendering = entry.rendering;
    if (!rendering || rendering.meaning.definition !== definition) continue;
    for (const projection of rendering.projections) {
      if (projection.fromRole !== rendering.viewingRole) continue;
      for (const argument of projection.arguments) {
        const value = argument.value as { kind?: string; ref?: string } | null;
        if (argument.role !== projection.toRole || value?.kind !== 'resource' || !value.ref) continue;
        const summary = entry.counterparts.find(item => item.reference === value.ref);
        if (summary?.status !== 'available' || summary.type !== 'work') continue;
        found.set(value.ref, { work: value.ref, title: summary.name.value });
      }
    }
  }
  return [...found.values()];
}

function PartLine({ part, t }: { part: SeriesPart; t: Copy }) {
  return <span className="inline-flex flex-wrap items-baseline gap-x-2">
    <Link href={`/w/${uuid(part.work)}`} className="font-medium underline-offset-4 hover:underline">{part.displayLabel || t.unnamedPart}</Link>
    {part.inclusion === 'optional' ? <span className="text-muted-foreground text-xs">{t.optionalPart}</span> : null}
    {part.inclusion === 'extra' ? <span className="text-muted-foreground text-xs">{t.extraPart}</span> : null}
  </span>;
}

function reasonText(reason: NonNullable<SeriesSummary['next']>['reason'], t: Copy) {
  return reason === 'next_available_required_part' ? t.reasonNextAvailable
    : reason === 'awaiting_chosen_language' ? t.reasonAwaiting : t.reasonOptional;
}

/** The series' language and edition, saved against the version read; another device's change is shown, not overwritten. */
function PreferenceForm({ work, preference, language, editions, api, locale, t, onSaved, onLanguage }: {
  work: string; preference: EditionPreference | null; language: string; editions: Editions | null; api: TrackingApi;
  locale: UiLocale; t: Copy; onSaved: (preference: EditionPreference | null) => void; onLanguage: (language: string) => void;
}) {
  const [edition, setEdition] = useState(preference?.edition ? `${preference.edition.kind}|${preference.edition.resource}` : '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<'saved' | 'failed' | null>(null);
  const [stale, setStale] = useState<{ current: EditionPreference | null; mine: EditionChoice } | null>(null);
  // The interface languages, the current choice and every language the Work's own editions are in.
  const languages = [...new Map([...uiLocales, language, ...(editions?.realizations ?? []).map(item => item.language),
    ...(editions?.releases ?? []).flatMap(item => item.contentLanguages)].map(tag => [tag.toLowerCase(), tag])).values()];
  const same = (tag: string | null) => tag?.toLowerCase() === language.toLowerCase();
  const offered = [
    ...(editions?.realizations ?? []).filter(item => same(item.language)).map(item => ({ kind: 'realization' as const,
      resource: item.id, revision: item.revision, name: (item.kind === 'original' ? t.originalText : t.translationText)({
        language: languageName(item.language, locale) }) })),
    ...(editions?.releases ?? []).filter(item => item.contentLanguages.some(same)).map(item => ({ kind: 'release' as const,
      resource: item.id, revision: item.revision, name: item.title.value }))];

  async function save(choice: EditionChoice, version: number) {
    setBusy(true);
    setNote(null);
    const written = await api.setPreference(work, version, choice);
    setBusy(false);
    if (written.ok) { setStale(null); setNote('saved'); onSaved(written.data); }
    else if (written.failure === 'stale') setStale({ current: written.current, mine: written.submitted });
    else setNote('failed');
  }
  const mine = (): EditionChoice => {
    const chosen = offered.find(item => `${item.kind}|${item.resource}` === edition);
    return { language, edition: chosen ? { kind: chosen.kind, resource: chosen.resource, revision: chosen.revision } : null };
  };
  return <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void save(mine(), preference?.version ?? 0); }}>
    <div className="flex flex-wrap items-end gap-3">
      <Field className="gap-1">
        <FieldLabel className="text-muted-foreground text-xs">{t.language}</FieldLabel>
        <NativeSelect size="sm" value={language} onChange={event => { setEdition(''); onLanguage(event.target.value); }}>
          {languages.map(tag => <NativeSelectOption key={tag} value={tag}>{languageName(tag, locale)}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <Field className="gap-1">
        <FieldLabel className="text-muted-foreground text-xs">{t.edition}</FieldLabel>
        <NativeSelect size="sm" value={edition} onChange={event => setEdition(event.target.value)} className="max-w-60">
          <NativeSelectOption value="">{t.anyEdition}</NativeSelectOption>
          {offered.map(item => <NativeSelectOption key={`${item.kind}|${item.resource}`} value={`${item.kind}|${item.resource}`}>
            {item.name}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <Button type="submit" size="sm" variant="outline" disabled={busy}>{t.savePreference}</Button>
    </div>
    {note === 'saved' ? <p role="status" className="text-muted-foreground text-xs">{t.preferenceSaved}</p> : null}
    {note === 'failed' ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p> : null}
    {stale ? <Alert variant="warning" role="alert"><AlertDescription className="grid gap-2">
      <p className="font-medium">{t.preferenceStale}</p><p>{t.preferenceStaleBody}</p>
      <p className="text-sm">{t.conflictTheirs}: {stale.current ? languageName(stale.current.language, locale) : t.notSet}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void save(stale.mine, stale.current?.version ?? 0)}>{t.keepMine}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => {
            const current = stale.current;
            setStale(null);
            setEdition(current?.edition ? `${current.edition.kind}|${current.edition.resource}` : '');
            onSaved(current);
            if (current) onLanguage(current.language);
          }}>{t.useTheirs}</Button>
      </div>
    </AlertDescription></Alert> : null}
  </form>;
}

/** Counterparts to offer: the reader's own action, never a silent completion. */
function Correspondences({ offers, marked, counterparts, failed, onMark, t }: {
  offers: Counterpart[]; marked: ReadonlySet<string>; counterparts: Counterpart[]; failed: string | null;
  onMark: (counterpart: Counterpart) => void; t: Copy;
}) {
  if (!offers.length && !marked.size) return null;
  return <div className="grid gap-2" role="group" aria-label={t.correspondences}>
    {offers.map(item => <div key={item.work} className="grid gap-1.5 rounded-xl bg-muted/40 p-3">
      <p className="text-sm">{t.alsoMarkNote({ title: item.title })}</p>
      <div><Button size="sm" variant="outline" onClick={() => onMark(item)}>{t.alsoMark({ title: item.title })}</Button></div>
      {failed === item.work ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p> : null}
    </div>)}
    {counterparts.filter(item => marked.has(item.work)).map(item =>
      <p key={item.work} role="status" className="text-sm">{t.marked({ title: item.title })}</p>)}
  </div>;
}

/** What the panel reads once, before it asks for progress: the choice that names the language, editions, correspondences. */
interface Setup { preference: EditionPreference | null; editions: Editions | null; counterparts: Counterpart[] }
type Progress = { language: string; value: ProgressSummary } | { language: string; failure: ReadFailure };

/**
 * Where the reader stands in a series, as Main reports it: the four states as separate lines, the
 * next part with its reason, the furthest part finished, and the language and edition choice. Where a
 * correspondence is recorded it offers to mark the counterpart read, only when the reader asks.
 * Nothing is computed here; a Work with no parts and no correspondence shows nothing.
 */
export function SeriesProgressPanel({ work, locale, className }: { work: string; locale: UiLocale; className?: string }) {
  const actions = useReaderActions();
  const api = actions.kind === 'ready' ? actions.tracking ?? null : null;
  const t = copyOf(locale);
  const [setup, setSetup] = useState<Setup | null>(null);
  // The preference names the language; without one the interface language stands until the reader chooses.
  const [language, setLanguage] = useState<string>(locale);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    if (!api) return;
    let current = true;
    void Promise.all([api.preference(work), api.editions(work), api.relations(work), api.definition('correspondence-equivalent')])
      .then(([saved, offered, relations, equivalent]) => {
        if (!current) return;
        const preference = saved.ok ? saved.data : null;
        if (preference) setLanguage(preference.language);
        setSetup({ preference, editions: offered.ok ? offered.data : null,
          counterparts: relations.ok && equivalent.ok ? equivalentCounterparts(relations.data, equivalent.data.definition) : [] });
      });
    return () => { current = false; };
  }, [api, work]);

  const preference = setup?.preference ?? null;
  const headingId = useId();
  // Shelving or finishing this Work elsewhere on the page changes what Main reports: read it again.
  const ownStatus = actions.kind === 'ready' ? actions.stateOf(work).status : null;
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [markFailed, setMarkFailed] = useState<string | null>(null);
  // Kept on screen while the write is out: the shelf it changes would otherwise withdraw the offer first.
  const [marking, setMarking] = useState(false);
  useEffect(() => {
    if (!api || !setup) return;
    let current = true;
    void api.series(work, language).then(result => {
      if (current) setProgress(result.ok ? { language, value: result.data } : { language, failure: result.failure });
    });
    return () => { current = false; };
  }, [api, work, language, setup, ownStatus]);

  if (!api || !setup || !progress) return null;
  const ready = actions.kind === 'ready' ? actions : null;
  const value = 'value' in progress && progress.language === language ? progress.value : null;
  const failure = 'failure' in progress ? progress.failure : null;
  const counterparts = setup.counterparts;
  // A Work with no composition answers for itself; only a composition has parts, a next part and a series to report.
  const series = value?.scope === 'disclosed-composition' ? value : null;
  const standalone = value?.scope === 'work' ? value : null;
  const hasParts = Boolean(series && (series.counts.required || series.counts.completed || series.next));
  // Offered once this Work is finished and the counterpart, by Main's own status, is not.
  const finished = standalone ? standalone.status === 'finished' : ownStatus === 'read';
  const offers = finished ? counterparts.filter(item => !marked.has(item.work) && ready?.stateOf(item.work).status !== 'read') : [];
  // A failed read says so unless Main simply has nothing (404) or the reader is signed out.
  const silent = failure === 'missing' || failure === 'sign-in';
  if (!hasParts && !offers.length && !marked.size && !marking && (!failure || silent)) return null;
  async function mark(counterpart: Counterpart) {
    setMarkFailed(null);
    setMarking(true);
    const written = await api!.start(counterpart.work, { state: 'finished' });
    setMarking(false);
    if (written.ok) setMarked(current => new Set([...current, counterpart.work]));
    else setMarkFailed(counterpart.work);
  }

  return <section aria-labelledby={headingId} data-series-progress={series ? 'series' : 'work'}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{series ? t.seriesProgress : t.workProgress}</h2>
    {failure && !value ? <Alert variant="destructive" role="alert"><AlertDescription>{t.seriesUnavailable}</AlertDescription></Alert> : null}
    {standalone ? <p className="text-sm" data-work-status={standalone.status ?? 'unknown'}>
      {standalone.status === 'finished' ? t.stateFinished : standalone.status === 'reading' ? t.stateActive
        : standalone.status === 'not-started' ? t.notStarted : t.unknown}</p> : null}
    {series ? <>
      <SeriesStates states={series.states} t={t} />
      {series.partial ? <p className="text-muted-foreground text-xs" data-partial>{t.partialNote}</p> : null}
      <p className="text-sm">{t.countsLine({ count: series.counts.required, completedRequired: String(series.counts.completedRequired) })}
        <span className="text-muted-foreground"> · {t.partsFinished(series.counts.completed)}</span></p>
      <div className="grid gap-1" data-next>
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t.nextPart}</h3>
        {series.next ? <>
          <p><PartLine part={series.next.part} t={t} /></p>
          <p className="text-muted-foreground text-sm">{reasonText(series.next.reason, t)}</p>
        </> : <p className="text-muted-foreground text-sm">{series.partial ? t.unknown : t.noNext}</p>}
      </div>
      {series.furthestCompleted ? <div className="grid gap-1" data-furthest>
        <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t.furthestFinished}</h3>
        <p><PartLine part={series.furthestCompleted.part} t={t} />
          {series.furthestCompleted.locator
            ? <span className="text-muted-foreground text-sm"> · {locatorParts(series.furthestCompleted.locator, t).furthest}</span> : null}</p>
      </div> : null}
    </> : null}
    {hasParts ? <div className="grid gap-2 border-border/60 border-t pt-3">
      <h3 className="font-medium text-sm">{t.preference}</h3>
      <p className="text-muted-foreground text-xs">{t.preferenceNote}</p>
      <PreferenceForm work={work} preference={preference} language={language}
        editions={setup.editions} api={api} locale={locale} t={t}
        onSaved={saved => setSetup({ ...setup, preference: saved })} onLanguage={setLanguage} />
    </div> : null}
    <Correspondences offers={offers} marked={marked} counterparts={counterparts} failed={markFailed} onMark={item => void mark(item)} t={t} />
  </section>;
}
