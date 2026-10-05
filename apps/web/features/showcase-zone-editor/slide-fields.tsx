'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import { cn } from '@rezics/ui/utils';
import { WorkCover } from '@rezics/ui/work-cover';
import { type ZoneWork, workCoverProps } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { type UiLocale, uiLocales } from '../../i18n/define.ts';
import { languageName } from '../showcase-editor/language.ts';
import type { WorkLevelsEditMessages } from '../work-levels-edit/messages.ts';
import { workIri } from '../work-levels-edit/route.ts';
import { WorkPicker } from '../work-levels-edit/work-picker.tsx';
import type { ZoneEditorCopy } from './messages.ts';
import { localInput, type SlideDraft, type SlideProblem, type SlideTarget, TEXT_LIMIT, utcFromInput } from './slides.ts';

function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return <section className="grid gap-3">
    <div className="grid gap-1">
      <h4 className="font-semibold">{title}</h4>
      {help ? <p className="max-w-3xl text-pretty text-muted-foreground text-sm">{help}</p> : null}
    </div>
    {children}
  </section>;
}

/** A Work as the slide names it: its cover and title, or why nothing can be shown. */
export function WorkLine({ work, loading, t }: { work: ZoneWork | null | undefined; loading: boolean; t: ZoneEditorCopy }) {
  if (!work) return <p className={cn('text-sm', loading ? 'text-muted-foreground' : 'text-destructive')} role={loading ? 'status' : undefined}>
    {loading ? t.workLoading : t.workUnavailable}</p>;
  return <div className="flex min-w-0 items-center gap-3">
    <span className="relative block aspect-[3/4] w-10 shrink-0 overflow-hidden rounded-md"><WorkCover size="fill" {...workCoverProps(work)} /></span>
    <span className="min-w-0 break-words font-medium" lang={work.title?.lang} dir={work.title?.dir}>{work.title?.value}</span>
  </div>;
}

/** Where a slide leads: a Work found by search (or named by its address), or a page of this site. */
export function TargetFields({ slide, work, loading, locale, pickerMessages, problems, onTarget, onPick, t }: {
  slide: SlideDraft; work: ZoneWork | null | undefined; loading: boolean; locale: UiLocale; pickerMessages: WorkLevelsEditMessages;
  problems: readonly SlideProblem[]; onTarget: (target: SlideTarget) => void; onPick: (work: string) => void; t: ZoneEditorCopy;
}) {
  const id = useId();
  const [changing, setChanging] = useState(false);
  const picker = materializeData(pickerMessages, { locale });
  const target = slide.target;
  const link = problems.find(problem => problem.kind === 'link');
  return <Section title={t.targetHeading}>
    <SegmentGroup aria-label={t.targetHeading} value={target.kind}
      onValueChange={details => {
        if (details.value === 'link' && target.kind !== 'link') onTarget({ kind: 'link', href: '' });
        else if (details.value === 'work' && target.kind !== 'work') { onTarget({ kind: 'work', work: '' }); setChanging(true); }
      }}>
      {(['work', 'link'] as const).map(kind => <SegmentGroupItem key={kind} value={kind}>
        <SegmentGroupItemText>{kind === 'work' ? t.targetWork : t.targetLink}</SegmentGroupItemText></SegmentGroupItem>)}
    </SegmentGroup>
    {target.kind === 'work' ? <div className="grid gap-2">
      <span className="font-medium text-sm">{t.workField}</span>
      {target.work && !changing ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card p-3">
        <WorkLine work={work} loading={loading} t={t} />
        <Button type="button" variant="outline" size="sm" onClick={() => setChanging(true)}>{t.workChange}</Button>
      </div> : <WorkPicker name={`${id}-work`} locale={locale} t={picker} label={t.workField} invalid={!target.work && problems.some(problem => problem.kind === 'no-work')}
        onChange={chosen => { if (chosen) { setChanging(false); onPick(workIri(chosen.id)); } }} />}
    </div> : <label className="grid gap-1 text-sm">
      <span className="font-medium">{t.linkField}</span>
      <Input value={target.href} onChange={event => onTarget({ kind: 'link', href: event.target.value })} inputMode="url" autoComplete="off" spellCheck={false}
        aria-invalid={Boolean(link) || undefined} aria-describedby={`${id}-link`} dir="ltr" />
      <span id={`${id}-link`} className={cn('text-xs', link ? 'text-destructive' : 'text-muted-foreground')}>
        {link?.kind === 'link' ? (link.reason === 'empty' ? t.linkEmpty : t.linkForm) : t.linkHelp}</span>
    </label>}
  </Section>;
}

/** The slide's kicker and title, and their translations to the languages the interface has. */
export function WordsFields({ slide, locale, problems, onChange, t }: {
  slide: SlideDraft; locale: UiLocale; problems: readonly SlideProblem[]; t: ZoneEditorCopy; onChange: (change: Partial<SlideDraft>) => void;
}) {
  const id = useId();
  const long = (field: 'kicker' | 'title', language: UiLocale | null) =>
    problems.some(problem => problem.kind === 'long' && problem.field === field && problem.language === language);
  const field = (label: string, name: 'kicker' | 'title', language: UiLocale | null, help?: string) => {
    const value = language ? slide[name === 'kicker' ? 'kickers' : 'titles'][language] ?? '' : slide[name];
    const invalid = long(name, language);
    const key = `${id}-${name}-${language ?? 'default'}`;
    return <label key={key} className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input value={value} lang={language ?? undefined} aria-invalid={invalid || undefined} aria-describedby={`${key}-help`} autoComplete="off"
        onChange={event => {
          const text = event.target.value;
          if (!language) onChange({ [name]: text });
          else onChange(name === 'kicker' ? { kickers: { ...slide.kickers, [language]: text } } : { titles: { ...slide.titles, [language]: text } });
        }} />
      <span id={`${key}-help`} className={cn('text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>
        {invalid ? t.tooLong({ max: String(TEXT_LIMIT) }) : help ?? ''}</span>
    </label>;
  };
  const translated = uiLocales.filter(language => slide.kickers[language]?.trim() || slide.titles[language]?.trim()).length;
  return <Section title={t.wordsHeading} help={t.wordsHelp}>
    <div className="grid gap-4 sm:grid-cols-2">
      {field(t.kicker, 'kicker', null, t.kickerHelp)}
      {field(t.title, 'title', null, t.titleHelp)}
    </div>
    <details className="group rounded-xl border border-border/70 bg-card" open={translated > 0 || undefined}>
      <summary className="cursor-pointer select-none rounded-xl px-4 py-3 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t.translations}{translated ? ` · ${translated}` : ''}</summary>
      <div className="grid gap-4 border-border/70 border-t p-4">
        <p className="text-muted-foreground text-sm">{t.translationsHelp}</p>
        {uiLocales.map(language => <div key={language} className="grid gap-3 sm:grid-cols-2">
          {field(t.kickerIn({ language: languageName(language, locale) }), 'kicker', language)}
          {field(t.titleIn({ language: languageName(language, locale) }), 'title', language)}
        </div>)}
      </div>
    </details>
  </Section>;
}

/** The time zone the schedule's inputs use, known only once the page is in a browser. */
function useClockZone() {
  const [zone, setZone] = useState('');
  useEffect(() => {
    const offset = -new Date().getTimezoneOffset();
    const sign = offset < 0 ? '−' : '+';
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
    setZone(`${Intl.DateTimeFormat().resolvedOptions().timeZone} (UTC${sign}${hours}:${minutes})`);
  }, []);
  return zone;
}

/** When the slide is shown. The inputs read and write the person's own clock; Main stores exact UTC times. */
export function ScheduleFields({ slide, problems, onChange, t }: {
  slide: SlideDraft; problems: readonly SlideProblem[]; t: ZoneEditorCopy; onChange: (change: Partial<Pick<SlideDraft, 'startsAt' | 'endsAt'>>) => void;
}) {
  const id = useId();
  const zone = useClockZone();
  const schedule = problems.find(problem => problem.kind === 'schedule');
  const input = (name: 'startsAt' | 'endsAt', label: string) => {
    const value = localInput(slide[name]);
    return <div className="grid gap-1 text-sm">
      <label htmlFor={`${id}-${name}`} className="font-medium">{label}</label>
      <div className="flex gap-2">
        <Input id={`${id}-${name}`} type="datetime-local" value={value} aria-invalid={Boolean(schedule) || undefined} aria-describedby={`${id}-help`}
          onChange={event => { const next = utcFromInput(event.target.value); if (next !== 'invalid') onChange({ [name]: next }); }} />
        <Button type="button" variant="ghost" size="sm" disabled={!value} onClick={() => onChange({ [name]: null })}>{t.clearTime}</Button>
      </div>
    </div>;
  };
  return <Section title={t.scheduleHeading} help={t.scheduleHelp}>
    <div className="grid gap-4 sm:grid-cols-2">{input('startsAt', t.startsAt)}{input('endsAt', t.endsAt)}</div>
    <p id={`${id}-help`} className={cn('text-xs', schedule ? 'text-destructive' : 'text-muted-foreground')}>
      {schedule?.kind === 'schedule' ? (schedule.reason === 'empty' ? t.scheduleEmpty : t.scheduleInvalid) : zone ? t.scheduleZone({ zone }) : ''}</p>
  </Section>;
}

