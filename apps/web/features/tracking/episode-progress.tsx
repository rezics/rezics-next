'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Progress } from '@rezics/ui/progress';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { Episode, EpisodeApi, EpisodeProgress as Mark } from './episode-api.ts';
import { type EpisodeKind, mainNumbered, markPosition, numberOf, type Standing, standingOf } from './episodes.ts';
import type { Copy } from './messages.ts';

/** The words for one kind of installment, so a phone shows "chapter" for a serial and "episode" for a series. */
function wordsOf(kind: EpisodeKind, t: Copy) {
  return kind === 'chapter'
    ? { title: t.chTitle, label: t.chLabel, through: t.chThrough, throughOf: t.chThroughOf, none: t.chNone, cont: t.chContinue,
      markNext: t.chMarkNext, done: t.chDone, jump: t.chJump, missing: t.chJumpMissing, watched: t.chWatched,
      unwatched: t.chUnwatched, mark: t.chMark, unmark: t.chUnmark }
    : { title: t.epTitle, label: t.epLabel, through: t.epThrough, throughOf: t.epThroughOf, none: t.epNone, cont: t.epContinue,
      markNext: t.epMarkNext, done: t.epDone, jump: t.epJump, missing: t.epJumpMissing, watched: t.epWatched,
      unwatched: t.epUnwatched, mark: t.epMark, unmark: t.epUnmark };
}

type Words = ReturnType<typeof wordsOf>;

function nameOf(episode: Episode, standing: Pick<Standing, 'mains' | 'specials'>, words: Words, t: Copy): string {
  const number = episode.special ? (episode.ordinal ?? standing.specials.indexOf(episode) + 1) : numberOf(episode, standing.mains);
  return episode.label ?? (number === null ? words.title : (episode.special ? t.spLabel : words.label)({ number: String(number) }));
}

type Selected = { episode: Episode; mark: Mark | 'loading' | 'failed' };

/**
 * Where the reader stands in a series' episodes or chapters, and the ways to move: mark the next one
 * in a tap, jump to any by number, set a special apart from the main run. Everything shown is Main's;
 * after each write the standing is read again, so a second device that loads the page sees the same.
 */
export function EpisodeProgress({ work, api, t, className }: { work: string; api: EpisodeApi; t: Copy; className?: string }) {
  const headingId = useId();
  const jumpId = useId();
  const [standing, setStanding] = useState<Awaited<ReturnType<typeof standingOf>> | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  const [missing, setMissing] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    void standingOf(api, work).then(read => { if (current) setStanding(read); });
    return () => { current = false; };
  }, [api, work, reload]);

  if (!standing) return null;
  if (!standing.ok) {
    return standing.failure === 'missing' || standing.failure === 'sign-in' ? null
      : <section aria-labelledby={headingId} className={className}>
        <Alert variant="destructive" role="alert"><AlertDescription>{t.trackedUnavailable}</AlertDescription></Alert></section>;
  }
  const read = standing.data;
  if (!read) return null;
  const words = wordsOf(read.kind, t);
  const throughNumber = read.through ? numberOf(read.through, read.mains) : null;
  const caughtUp = read.through !== undefined && read.through !== null && read.next === null;

  async function select(episode: Episode) {
    setSelected({ episode, mark: 'loading' });
    setFailed(false);
    const state = await api.progress(episode);
    setSelected(now => (now?.episode.occurrence === episode.occurrence ? { episode, mark: state.ok ? state.data : 'failed' } : now));
  }

  async function write(episode: Episode, completed: boolean) {
    setSaving(true);
    setFailed(false);
    const number = episode.special ? episode.ordinal : numberOf(episode, read!.mains);
    const written = await api.mark(episode, { completed, ...(completed ? { position: markPosition(episode, number) } : {}) });
    setSaving(false);
    if (!written.ok) { setFailed(true); return; }
    setSelected(now => (now?.episode.occurrence === episode.occurrence ? { episode, mark: written.data } : now));
    setReload(count => count + 1);
  }

  async function jump() {
    const number = Number(typed.trim());
    if (!/^[1-9]\d*$/.test(typed.trim()) || !Number.isSafeInteger(number)) return;
    setMissing(null);
    let found: Episode | null = null;
    try { found = await mainNumbered(api, work, read!, number); } catch { setFailed(true); return; }
    if (!found) { setMissing(number); setSelected(null); return; }
    await select(found);
  }

  const mark = selected && typeof selected.mark === 'object' ? selected.mark : null;
  return <section aria-labelledby={headingId} data-episode-progress={read.kind}
    data-through={throughNumber ?? ''} data-continue={read.next ? numberOf(read.next, read.mains) ?? '' : ''}
    className={className ?? 'grid gap-4 rounded-2xl border border-border/60 p-4 sm:p-5'}>
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{words.title}</h2>

    <div className="grid gap-2">
      <p className="font-medium text-base" data-where>
        {read.through === undefined ? t.unknown : throughNumber === null ? words.none
          : read.total !== null ? words.throughOf({ number: String(throughNumber), total: String(read.total) })
            : words.through({ number: String(throughNumber) })}</p>
      {read.total !== null && throughNumber !== null
        ? <Progress value={Math.round((throughNumber / read.total) * 100)} aria-label={words.title} /> : null}
    </div>

    {read.next ? <div className="grid gap-2" data-next>
      <p className="text-muted-foreground text-sm">{words.cont({ number: String(numberOf(read.next, read.mains) ?? '') })}</p>
      <div><Button type="button" className="min-h-11 w-full sm:w-auto" disabled={saving}
        onClick={() => void write(read.next!, true)}>
        <CheckIcon aria-hidden="true" />{saving ? t.episodeSaving : words.markNext({ number: String(numberOf(read.next, read.mains) ?? '') })}</Button></div>
    </div> : caughtUp ? <p className="text-muted-foreground text-sm" data-caught-up>{words.done}</p> : null}

    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void jump(); }}>
      <Field className="gap-1">
        <FieldLabel htmlFor={jumpId} className="text-muted-foreground text-xs">{words.jump}</FieldLabel>
        <Input id={jumpId} size="sm" inputMode="numeric" className="h-11 w-32 sm:h-8" value={typed}
          onChange={event => { setTyped(event.target.value); setMissing(null); }} />
      </Field>
      <Button type="submit" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving || !/^[1-9]\d*$/.test(typed.trim())}>{t.jumpGo}</Button>
    </form>
    {missing !== null ? <p role="status" className="text-muted-foreground text-sm">{words.missing({ number: String(missing) })}</p> : null}

    {read.specials.length ? <div className="grid gap-2 border-border/60 border-t pt-3" data-specials>
      <h3 className="font-medium text-sm">{t.specialsTitle}</h3>
      <p className="text-muted-foreground text-xs">{t.specialsNote}</p>
      <ul className="flex flex-wrap gap-2">
        {read.specials.map(episode => <li key={episode.occurrence}>
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8"
            variant={selected?.episode.occurrence === episode.occurrence ? 'default' : 'outline'}
            aria-pressed={selected?.episode.occurrence === episode.occurrence}
            data-special={episode.occurrence} onClick={() => void select(episode)}>{nameOf(episode, read, words, t)}</Button>
        </li>)}
      </ul>
    </div> : null}

    {selected ? <div className="grid gap-2 rounded-xl bg-muted/40 p-3" data-selected={selected.episode.special ? 'special' : 'main'}
      aria-live="polite">
      <p className="font-medium text-sm">{nameOf(selected.episode, read, words, t)}
        {mark ? <span className="text-muted-foreground" data-state={mark.completed ? 'done' : 'open'}>
          {' · '}{mark.completed ? words.watched : words.unwatched}</span> : null}</p>
      {mark ? <div><Button type="button" variant={mark.completed ? 'ghost' : 'outline'} className="min-h-11 sm:min-h-8" disabled={saving}
        onClick={() => void write(selected.episode, !mark.completed)}>
        {mark.completed ? words.unmark : words.mark}</Button></div> : null}
    </div> : null}

    {!read.complete ? <p className="text-muted-foreground text-xs">{t.listedOnly({ count: String(read.items.length) })}</p> : null}
    <p role="status" className="text-destructive-foreground text-xs">{failed || selected?.mark === 'failed' ? t.saveFailed : null}</p>
  </section>;
}
