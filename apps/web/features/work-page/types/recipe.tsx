'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { cn } from '@rezics/ui/utils';
import { Clock3Icon, PencilIcon, XIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import { browserMainApi } from '../../api/browser.ts';
import { followHref } from '../../entity-page/href.ts';
import { appendRecipePage, readRecipePage, recipePageQuery } from '../../recipe-editor/pages.ts';
import { formatMeasure } from '../../recipe-editor/quantity.ts';
import Link from '../../shell/localized-link.tsx';
import type { WorkPageMessages } from '../messages.ts';
import { Region } from '../region.tsx';
import type { RecipeWorkPage } from '../types.ts';

/** What the published page and the editor's preview both render. The editor fills it from its own state. */
export interface ReadableRecipe {
  ingredients: readonly ReadableIngredient[];
  occurrences: readonly ReadableOccurrence[];
  measures: readonly ReadableMeasure[];
}

interface ReadableIngredient {
  occurrence: string;
  originalText: string;
  line: string;
  alternateLine?: string;
  alternateSystem?: 'us' | 'metric';
  hint?: string;
  judgment?: 'seasoning' | 'leavening';
  reason?: 'unparsed' | 'non-linear' | 'not-scalable';
}

interface ReadableOccurrence {
  occurrence: string;
  role: string;
  parent: string;
  labels: readonly { value: string }[];
  qualifier?: {
    type: string;
    instructionText?: { value: string };
    usesIngredient?: readonly string[];
  };
}

interface ReadableMeasure {
  kind: string;
  value: { numerator: number; denominator: number };
  unitText?: string;
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

/** The units a reader sees: each line as its cook wrote it, or all of them converted to one system. */
type Units = 'written' | 'us' | 'metric';

function shownLine(item: ReadableIngredient, units: Units): string {
  if (units !== 'written' && item.alternateSystem === units && item.alternateLine) return item.alternateLine;
  return item.line ?? item.originalText;
}

/**
 * Ingredients under their section headings. A section is opened when its group arrives, so a later
 * page's lines join that heading instead of starting another. Lines outside any section come first.
 */
function sectioned(page: ReadableRecipe): { key: string; heading: string | null; items: ReadableIngredient[] }[] {
  const groups = page.occurrences.filter(item => item.role === 'group');
  const labels = new Map(groups.map(item => [item.occurrence, item.labels[0]?.value ?? '']));
  const parents = new Map(page.occurrences.map(item => [item.occurrence, item.parent]));
  const blocks: { key: string; heading: string | null; items: ReadableIngredient[] }[] = groups.map(group => ({
    key: group.occurrence, heading: labels.get(group.occurrence) ?? '', items: [],
  }));
  for (const item of page.ingredients) {
    const parent = parents.get(item.occurrence);
    const key = parent !== undefined && labels.has(parent) ? parent : '';
    const block = blocks.find(candidate => candidate.key === key) ?? (blocks.push({
      key, heading: key === '' ? null : labels.get(key) ?? '', items: [],
    }), blocks.at(-1)!);
    block.items.push(item);
  }
  return blocks.sort((left, right) => Number(left.key !== '') - Number(right.key !== ''));
}

function IngredientList({ page, units, messages: t }: {
  page: ReadableRecipe; units: Units; messages: WorkPageMessages;
}) {
  return <div className="grid gap-4">{sectioned(page).map(block => <div key={block.key} className="grid gap-1">
    {block.heading !== null ? <h4 className="font-medium text-muted-foreground text-sm">{block.heading}</h4> : null}
    {block.items.length ? <ul className="grid gap-2">{block.items.map(item => {
      const text = shownLine(item, units);
      const quiet = text !== item.originalText && (units !== 'written' || item.hint) ? item.originalText : null;
      const note = item.judgment ? t.scaleByTaste
        : item.reason === 'unparsed' ? t.scaleUnparsed
          : item.reason ? t.scaleHeld : null;
      return <li key={item.occurrence} className="border-border/60 flex flex-col gap-0.5 border-b py-2 last:border-0">
        <span className="font-medium text-pretty">{text}</span>
        {quiet ? <span className="text-muted-foreground text-sm">{quiet}</span> : null}
        {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
      </li>;
    })}</ul> : null}
  </div>)}</div>;
}

function UnitToggle({ value, onChange, messages: t }: {
  value: Units; onChange: (value: Units) => void; messages: WorkPageMessages;
}) {
  return <div role="radiogroup" aria-label={t.unitSystem} className="flex rounded-full border border-border/60 p-0.5">
    {(['written', 'us', 'metric'] as const).map(option => <button key={option} type="button" role="radio"
      aria-checked={value === option} onClick={() => onChange(option)}
      className={cn('rounded-full px-3 py-1 text-sm', value === option
        ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
      {option === 'written' ? t.unitWritten : option === 'us' ? t.unitUs : t.unitMetric}</button>)}
  </div>;
}

/** The ingredient lines a step names, in the unit system the reader is looking at. */
function linkedLines(step: ReadableOccurrence, page: ReadableRecipe, units: Units): string[] {
  const ids = step.qualifier?.type === 'recipe-step' ? step.qualifier.usesIngredient ?? [] : [];
  return ids.flatMap(id => {
    const item = page.ingredients.find(ingredient => ingredient.occurrence === id);
    return item ? [shownLine(item, units)] : [];
  });
}

function Steps({ page, units, messages: t }: { page: ReadableRecipe; units: Units; messages: WorkPageMessages }) {
  const steps = page.occurrences.filter(item => item.role === 'step' && item.qualifier?.type === 'recipe-step');
  return <ol className="grid gap-5">{steps.map((step, index) => {
    const instruction = step.qualifier?.type === 'recipe-step' ? step.qualifier.instructionText?.value ?? '' : '';
    const linked = linkedLines(step, page, units);
    const seconds = stepSeconds(instruction);
    return <li key={step.occurrence} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <span aria-hidden="true" className="bg-primary/10 flex size-8 items-center justify-center rounded-full font-semibold">
        {index + 1}</span>
      <div className="grid gap-2"><p className="leading-7">{instruction}</p>
        {linked.length ? <p className="text-muted-foreground text-sm">{linked.join(' · ')}</p> : null}
        {seconds ? <StepTimer seconds={seconds} messages={t} /> : null}</div>
    </li>;
  })}</ol>;
}

/** A focused recipe task keeps the display awake while its steps are open. */
function CookMode({ page, messages: t, units, onClose }: {
  page: ReadableRecipe; messages: WorkPageMessages; units: Units;
  onClose: () => void;
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
          <IngredientList page={page} units={units} messages={t} /></section>
        <section className="grid content-start gap-3"><h3 className="font-semibold text-xl">{t.method}</h3>
          <Steps page={page} units={units} messages={t} /></section>
      </div>
    </div>
  </div>;
}

/** Yield, times, ingredients and method, shared by the Work page and the editor's preview. */
export function RecipeContent({ page, units, messages: t, notes, controls, columns = true }: {
  page: ReadableRecipe; units: Units; messages: WorkPageMessages; notes?: string | null; controls?: ReactNode;
  /** Side by side from the `md` viewport. A narrow preview stacks instead. */
  columns?: boolean;
}) {
  const measures = page.measures;
  const total = measures.find(item => item.kind === 'total-duration');
  const prep = measures.find(item => item.kind === 'preparation-duration');
  const cook = measures.find(item => item.kind === 'cooking-duration');
  const yieldMeasure = measures.find(item => item.kind === 'yield');
  const facts = Boolean(yieldMeasure || prep || cook || total);
  return <div className="grid gap-4">
    {facts ? <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {yieldMeasure ? <span><strong>{t.recipeYield}</strong> {formatMeasure(yieldMeasure.value, yieldMeasure.unitText)}</span> : null}
      {prep ? <span><strong>{t.prepTime}</strong> {formatMeasure(prep.value, prep.unitText)}</span> : null}
      {cook ? <span><strong>{t.cookTime}</strong> {formatMeasure(cook.value, cook.unitText)}</span> : null}
      {total ? <span><strong>{t.totalTime}</strong> {formatMeasure(total.value, total.unitText)}</span> : null}
    </div> : null}
    {controls}
    <div className={cn('grid gap-8', columns && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]')}>
      <section className="grid content-start gap-3"><h3 className="font-semibold text-lg">{t.ingredients}</h3>
        <IngredientList page={page} units={units} messages={t} /></section>
      <section className="grid content-start gap-3"><h3 className="font-semibold text-lg">{t.method}</h3>
        <Steps page={page} units={units} messages={t} /></section>
    </div>
    {notes ? <section className="grid gap-2"><h3 className="font-semibold">{t.recipeNotes}</h3>
      <p className="whitespace-pre-wrap leading-7">{notes}</p></section> : null}
  </div>;
}

/** One page of a recipe. The cursor and a new serving count are never sent together. */
export type RecipePageRead = (query: { cursor?: string; servings?: number }) => Promise<{
  data: RecipeWorkPage | null; error: { status: number; value?: unknown } | null;
}>;

function wholeServings(page: RecipeWorkPage | null): number | null {
  const value = page?.measures.find(item => item.kind === 'servings')?.value;
  if (!value || value.denominator === 0) return null;
  const amount = value.numerator / value.denominator;
  return Number.isInteger(amount) && amount >= 1 && amount <= 100 ? amount : null;
}

export function RecipeExperience({ initial, href, actingSubject, text, edit, messages: t, readPage }: {
  initial: RecipeWorkPage | null; /** The recipe section's link in the Work's page projection. */ href: string;
  actingSubject: string | null; /** The way into the recipe editor, for a viewer who may edit it. */ edit?: { href: string; label: string } | null;
  text: string | null; locale: UiLocale; messages: WorkPageMessages;
  /** Stories answer a later page without the network. Showing more reads that one page. */
  readPage?: RecipePageRead;
}) {
  const [page, setPage] = useState(initial);
  const [servings, setServings] = useState(() => wholeServings(initial) ?? 1);
  // Quantities show as the cook wrote them; converting is the reader's choice.
  const [units, setUnits] = useState<Units>('written');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [continueFailed, setContinueFailed] = useState(false);
  const [changed, setChanged] = useState(false);
  const [cooking, setCooking] = useState(false);
  const applied = useRef(wholeServings(initial));
  /** A newer scale or reload ignores a continuation that was already on its way. */
  const generation = useRef(0);
  const read = readPage ?? ((query: { cursor?: string; servings?: number }) => followHref<RecipeWorkPage | null>(
    browserMainApi(), href, recipePageQuery(actingSubject, query))());
  useEffect(() => {
    const open = () => setCooking(true);
    window.addEventListener('rezics-cook', open);
    return () => window.removeEventListener('rezics-cook', open);
  }, []);
  const convertible = page?.ingredients.some(item => item.alternateLine) ?? false;
  const base = initial?.measures.find(item => item.kind === 'servings');
  const editorLink = edit ? <Link href={edit.href} className={buttonVariants({ variant: 'outline' })}>
    <PencilIcon aria-hidden="true" />{edit.label}</Link> : null;
  const scale = async (event: FormEvent) => {
    event.preventDefault();
    if (!Number.isInteger(servings) || servings < 1 || servings > 100) return;
    const ticket = ++generation.current;
    setContinuing(false);
    setBusy(true);
    setError(false);
    try {
      const filled = await readRecipePage(read, { servings });
      if (ticket !== generation.current) return;
      if (!filled.ok && filled.stale) {
        setChanged(true);
        const again = await readRecipePage(read, { servings });
        if (ticket !== generation.current) return;
        if (!again.ok || !again.page) setError(true);
        else {
          applied.current = servings;
          setContinueFailed(false);
          setPage(again.page);
        }
        return;
      }
      const next = filled.page;
      if (!filled.ok && !next) {
        setError(true);
        return;
      }
      if (!next) throw new Error('scale');
      applied.current = servings;
      setChanged(false);
      setContinueFailed(false);
      setPage(next);
    } catch { if (ticket === generation.current) setError(true); }
    finally { if (ticket === generation.current) setBusy(false); }
  };
  // One click reads the next page only. A refusal leaves what is shown, so Show more is offered again.
  const more = async () => {
    const cursor = page?.next;
    if (!cursor || continuing) return;
    const ticket = generation.current;
    setContinuing(true);
    setContinueFailed(false);
    try {
      const filled = await readRecipePage(read, { cursor });
      if (ticket !== generation.current) return;
      if (!filled.ok && filled.stale) {
        setChanged(true);
        const again = await readRecipePage(read, applied.current != null ? { servings: applied.current } : {});
        if (ticket !== generation.current) return;
        if (!again.ok || !again.page) setContinueFailed(true);
        else {
          applied.current = wholeServings(again.page) ?? applied.current;
          setPage(again.page);
        }
        return;
      }
      const chunk = filled.ok ? filled.page : null;
      if (!chunk) {
        setContinueFailed(true);
        return;
      }
      setChanged(false);
      setPage(current => current ? appendRecipePage(current, chunk) : chunk);
    } catch { if (ticket === generation.current) setContinueFailed(true); }
    finally { if (ticket === generation.current) setContinuing(false); }
  };
  const controls = <div className="flex flex-wrap items-end justify-between gap-4">
    <div className="flex flex-wrap items-end gap-4">
      {base && base.value.numerator > 0 ? <form onSubmit={event => void scale(event)} className="flex items-end gap-2">
        <label className="grid gap-1 text-sm" htmlFor="recipe-servings">{t.servings}
          <Input id="recipe-servings" type="number" min={1} max={100} step="any" value={servings}
            onChange={event => setServings(Number(event.target.value))} className="w-24" /></label>
        <Button type="submit" variant="outline" disabled={busy || continuing || !Number.isInteger(servings)
          || servings < 1 || servings > 100}>
          {busy ? t.scaling : t.scaleRecipe}</Button>
      </form> : null}
      {convertible ? <UnitToggle value={units} onChange={setUnits} messages={t} /> : null}
    </div>
    <div className="flex flex-wrap gap-2">{editorLink}</div>
  </div>;
  return <Region id="recipe-experience" title={t.recipeMethod}>
    {page ? <>
      <div aria-busy={busy || continuing || undefined} className="grid gap-4">
        <RecipeContent page={page} units={units} messages={t} notes={text} controls={<>
          {controls}
          {error ? <p role="alert" className="text-destructive text-sm">{t.scaleFailed}</p> : null}
        </>} />
        {page.next || changed || continueFailed ? <div className="grid justify-items-start gap-2">
          {changed ? <p role="status">{t.recipeChanged}</p> : null}
          {continueFailed ? <p role="alert" className="text-destructive text-sm">{t.recipeContinueFailed}</p> : null}
          {page.next ? <Button type="button" variant="outline" disabled={continuing || busy} onClick={() => void more()}>
            {continuing ? t.loadingMoreRecipe : t.showMoreRecipe}</Button> : null}
        </div> : null}
      </div>
      {cooking ? <CookMode page={page} messages={t} units={units}
        onClose={() => setCooking(false)} /> : null}
    </> : <>
      {editorLink}
      <p className="text-muted-foreground text-sm">{t.recipeUnstructured}</p>
      {text ? <p className="whitespace-pre-wrap leading-7">{text}</p> : null}
    </>}
  </Region>;
}
