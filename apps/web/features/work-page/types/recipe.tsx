'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { Clock3Icon, CookingPotIcon, XIcon } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import { browserMainApi } from '../../api/browser.ts';
import type { WorkPageMessages } from '../messages.ts';
import { Region } from '../region.tsx';
import type { RecipeWorkPage } from '../types.ts';

type Ingredient = RecipeWorkPage['ingredients'][number];
type Occurrence = RecipeWorkPage['occurrences'][number];

function fraction(value: { numerator: number; denominator: number }, locale: UiLocale): string {
  const whole = Math.floor(value.numerator / value.denominator);
  const rest = value.numerator % value.denominator;
  if (!rest) return new Intl.NumberFormat(locale).format(whole);
  return `${whole ? `${new Intl.NumberFormat(locale).format(whole)} ` : ''}${rest}/${value.denominator}`;
}

function duration(value: { numerator: number; denominator: number }, unit: string | undefined): string {
  const amount = value.numerator / value.denominator;
  return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} ${unit ?? 'min'}`;
}

function stepSeconds(instruction: string): number | null {
  const match = /(?:\b(\d{1,3})\s*(?:minutes?|mins?)\b|(?<!\d)(\d{1,3})\s*分钟)/i.exec(instruction);
  const minutes = Number(match?.[1] ?? match?.[2]);
  return minutes > 0 && minutes <= 180 ? minutes * 60 : null;
}

function StepTimer({ seconds, messages: t }: { seconds: number; messages: WorkPageMessages }) {
  const [left, setLeft] = useState(seconds);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running || left <= 0) return;
    const timer = window.setInterval(() => setLeft(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [running, left]);
  return <div className="flex items-center gap-2 text-sm">
    <Clock3Icon aria-hidden="true" className="size-4" />
    <span role="timer" aria-live={left === 0 ? 'polite' : 'off'}>{Math.floor(left / 60)}:
      {String(left % 60).padStart(2, '0')}</span>
    <Button type="button" size="sm" variant="outline" onClick={() => {
      if (left === 0) setLeft(seconds);
      setRunning(value => !value);
    }}>{running ? t.pauseTimer : left === 0 ? t.restartTimer : t.startTimer}</Button>
  </div>;
}

function IngredientList({ items, scaled, locale, messages: t }: {
  items: Ingredient[]; scaled: boolean; locale: UiLocale; messages: WorkPageMessages;
}) {
  return <ul className="grid gap-2">{items.map(item => <li key={item.occurrence}
    className="border-border/60 flex flex-col gap-0.5 border-b py-2 last:border-0">
    {scaled && item.scaled && item.amount ? <>
      <span><strong>{fraction(item.amount, locale)}{item.amountUpper
        ? `–${fraction(item.amountUpper, locale)}` : ''} {item.unitText ?? ''}</strong></span>
      <span className="text-muted-foreground text-sm">{item.originalText}</span>
    </> : <span>{item.originalText}</span>}
    {scaled && item.reason ? <span className="text-muted-foreground text-xs">{t.scaleByTaste}</span> : null}
  </li>)}</ul>;
}

function Steps({ items, messages: t }: { items: Occurrence[]; messages: WorkPageMessages }) {
  const steps = items.filter(item => item.role === 'step' && item.qualifier?.type === 'recipe-step');
  return <ol className="grid gap-5">{steps.map((step, index) => {
    const instruction = step.qualifier?.type === 'recipe-step' ? step.qualifier.instructionText.value : '';
    const seconds = stepSeconds(instruction);
    return <li key={step.occurrence} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <span aria-hidden="true" className="bg-primary/10 flex size-8 items-center justify-center rounded-full font-semibold">
        {index + 1}</span>
      <div className="grid gap-2"><p className="leading-7">{instruction}</p>
        {seconds ? <StepTimer seconds={seconds} messages={t} /> : null}</div>
    </li>;
  })}</ol>;
}

/** A focused recipe task keeps the display awake while its steps are open. */
function CookMode({ page, locale, messages: t, scaled, onClose }: {
  page: RecipeWorkPage; locale: UiLocale; messages: WorkPageMessages; scaled: boolean; onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prior = document.body.style.overflow;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
      try {
        const held = await navigator.wakeLock.request('screen');
        if (disposed) await held.release(); else sentinel = held;
      } catch { /* The recipe remains usable when a device declines the wake lock. */ }
    };
    const visible = () => { if (document.visibilityState === 'visible') void acquire(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button:not(:disabled)')];
      if (!buttons.length) return;
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault(); buttons.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
        event.preventDefault(); buttons[0]?.focus();
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', visible);
    document.addEventListener('keydown', escape);
    return () => {
      disposed = true;
      document.body.style.overflow = prior;
      document.removeEventListener('visibilitychange', visible);
      document.removeEventListener('keydown', escape);
      void sentinel?.release();
      opener?.focus();
    };
  }, [onClose]);
  return <div role="dialog" aria-modal="true" aria-label={t.cookMode}
    className="bg-background fixed inset-0 z-50 overflow-y-auto p-4 sm:p-8">
    <div className="mx-auto grid max-w-4xl gap-8">
      <div className="flex items-center justify-between gap-4 border-b pb-4">
        <h2 className="font-semibold text-2xl">{t.cookMode}</h2>
        <Button ref={close} type="button" variant="outline" onClick={onClose}>
          <XIcon aria-hidden="true" />{t.closeCookMode}</Button>
      </div>
      <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="grid content-start gap-3"><h3 className="font-semibold text-xl">{t.ingredients}</h3>
          <IngredientList items={page.ingredients} scaled={scaled} locale={locale} messages={t} /></section>
        <section className="grid content-start gap-3"><h3 className="font-semibold text-xl">{t.method}</h3>
          <Steps items={page.occurrences} messages={t} /></section>
      </div>
    </div>
  </div>;
}

export function RecipeExperience({ initial, workId, actingSubject, text, locale, messages: t }: {
  initial: RecipeWorkPage | null; workId: string; actingSubject: string | null;
  text: string | null; locale: UiLocale; messages: WorkPageMessages;
}) {
  const [page, setPage] = useState(initial);
  const [servings, setServings] = useState(() => {
    const value = initial?.measures.find(item => item.kind === 'servings')?.value;
    return value ? value.numerator / value.denominator : 1;
  });
  const [scaled, setScaled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [cooking, setCooking] = useState(false);
  const base = initial?.measures.find(item => item.kind === 'servings');
  const measures = page?.measures ?? [];
  const total = measures.find(item => item.kind === 'total-duration');
  const active = measures.find(item => item.kind === 'preparation-duration');
  const yieldMeasure = measures.find(item => item.kind === 'yield');
  const scale = async (event: FormEvent) => {
    event.preventDefault();
    if (!Number.isInteger(servings) || servings < 1 || servings > 100) return;
    setBusy(true); setError(false);
    try {
      const answer = await browserMainApi().v1.recipes.works({ id: workId }).get({ query: {
        actingSubject: actingSubject ?? undefined, servings } });
      if (answer.error || !answer.data) throw new Error('scale');
      setPage(answer.data); setScaled(true);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <Region id="recipe-experience" title={t.recipeMethod}>
    {page ? <>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {yieldMeasure ? <span><strong>{t.recipeYield}</strong> {duration(yieldMeasure.value, yieldMeasure.unitText)}</span> : null}
        {total ? <span><strong>{t.totalTime}</strong> {duration(total.value, total.unitText)}</span> : null}
        {active ? <span><strong>{t.activeTime}</strong> {duration(active.value, active.unitText)}</span> : null}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        {base && base.value.numerator > 0 ? <form onSubmit={event => void scale(event)} className="flex items-end gap-2">
          <label className="grid gap-1 text-sm" htmlFor="recipe-servings">{t.servings}
            <Input id="recipe-servings" type="number" min={1} max={100} step="any" value={servings}
              onChange={event => setServings(Number(event.target.value))} className="w-24" /></label>
          <Button type="submit" variant="outline" disabled={busy || !Number.isInteger(servings)
            || servings < 1 || servings > 100}>
            {busy ? t.scaling : t.scaleRecipe}</Button>
        </form> : null}
        <Button type="button" onClick={() => setCooking(true)}><CookingPotIcon aria-hidden="true" />
          {t.cookThis}</Button>
      </div>
      {error ? <p role="alert" className="text-destructive text-sm">{t.scaleFailed}</p> : null}
      <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="grid content-start gap-3"><h3 className="font-semibold text-lg">{t.ingredients}</h3>
          <IngredientList items={page.ingredients} scaled={scaled} locale={locale} messages={t} /></section>
        <section className="grid content-start gap-3"><h3 className="font-semibold text-lg">{t.method}</h3>
          <Steps items={page.occurrences} messages={t} /></section>
      </div>
      {text ? <section className="grid gap-2"><h3 className="font-semibold">{t.recipeNotes}</h3>
        <p className="whitespace-pre-wrap leading-7">{text}</p></section> : null}
      {cooking ? <CookMode page={page} locale={locale} messages={t} scaled={scaled}
        onClose={() => setCooking(false)} /> : null}
    </> : <>
      <p className="text-muted-foreground text-sm">{t.recipeUnstructured}</p>
      {text ? <p className="whitespace-pre-wrap leading-7">{text}</p> : null}
    </>}
  </Region>;
}
