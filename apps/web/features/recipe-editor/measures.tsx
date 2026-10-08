'use client';

import { useState } from 'react';
import { SyncedInput } from './controls.tsx';
import type { Copy } from './messages.ts';
import { measureOf, minutesOf, type RecipeState, type TimingName } from './model.ts';
import { amountText, type Rational, typedAmount } from './quantity.ts';
import { timingLeave, timingShown } from './timing-field.ts';
import type { RecipeStore } from './store.ts';
import { directionOf } from '../studio/types.ts';

interface Common { store: RecipeStore; state: RecipeState; language: string; t: Copy; busy: boolean }

const rationalText = (value: Rational | undefined) => amountText(value);

/** Yield, servings and the three times. Each field is written when it is left, as one intent for the field's measure. */
export function MeasuresSection({ store, state, language, t }: Common) {
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const yieldMeasure = measureOf(state, 'yield');
  const servings = measureOf(state, 'servings');
  const read = (form: HTMLElement, name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? '';
  const flag = (name: string, message: string | null) =>
    setInvalid(current => { const next = { ...current }; if (message) next[name] = message; else delete next[name]; return next; });

  const commitYield = (form: HTMLElement) => {
    const amount = read(form, 'makes');
    const unitText = read(form, 'makesUnit');
    const people = read(form, 'servings');
    const makes = amount ? typedAmount(amount) : null;
    const serves = people ? typedAmount(people) : null;
    flag('makes', amount && !makes ? t.amountInvalid : null);
    flag('servings', people && !serves ? t.amountInvalid : null);
    flag('makesUnit', amount && !unitText ? t.makesUnit : null);
    if ((amount && !makes) || (people && !serves) || (amount && !unitText)) return;
    void store.submit({ kind: 'yield', yield: makes ? { value: makes, unitText } : null, servings: serves, servingsWord: t.servingsWord });
  };
  const commitTime = (name: TimingName, input: HTMLInputElement) => {
    const decision = timingLeave(measureOf(state, name), input.value);
    if (decision.kind === 'invalid') { flag(name, t.minutesInvalid); return; }
    flag(name, null);
    if (decision.kind === 'unchanged') return;
    void store.submit({ kind: 'timings', times: { [name]: decision.minutes } });
  };

  const lang = { lang: language, dir: directionOf(language) } as const;
  const timing = (name: TimingName, label: string) => {
    const measure = measureOf(state, name);
    const shown = timingShown(measure);
    const other = minutesOf(measure) === 'other';
    const problem = invalid[name];
    const described = problem ? `${name}-problem` : other ? `${name}-other` : undefined;
    return <label key={name} className="grid min-w-0 gap-1 text-sm">{label}
      <SyncedInput name={name} inputMode={/^\d*$/.test(shown) ? 'numeric' : 'text'} value={shown} autoComplete="off"
        placeholder={other ? undefined : t.minutesUnit}
        aria-invalid={problem ? true : undefined} aria-describedby={described}
        onBlur={event => commitTime(name, event.currentTarget)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
      {problem ? <span id={`${name}-problem`} className="text-destructive-foreground text-xs">{problem}</span>
        : other ? <span id={`${name}-other`} className="text-muted-foreground text-xs">{t.timeOther({ value: shown })}</span>
          : null}
    </label>;
  };
  return <section aria-labelledby="recipe-measures" className="grid gap-4">
    <h2 id="recipe-measures" className="font-semibold text-xl">{t.measuresHeading}</h2>
    <div role="group" aria-label={t.makes} className="grid grid-cols-2 gap-3 sm:grid-cols-[7rem_minmax(0,1fr)_7rem]"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitYield(event.currentTarget); }}>
      <label className="grid min-w-0 gap-1 text-sm">{t.makes}
        <SyncedInput name="makes" inputMode="decimal" value={rationalText(yieldMeasure?.value)} autoComplete="off"
          aria-invalid={invalid.makes ? true : undefined} />
        {invalid.makes ? <span className="text-destructive-foreground text-xs">{invalid.makes}</span> : null}</label>
      <label className="col-span-2 grid min-w-0 gap-1 text-sm sm:col-span-1 sm:col-start-2 sm:row-start-1">{t.makesUnit}
        <SyncedInput name="makesUnit" value={yieldMeasure?.unitText ?? ''} placeholder={t.makesUnitHelp} autoComplete="off" maxLength={100}
          aria-invalid={invalid.makesUnit ? true : undefined} {...lang} /></label>
      <label className="grid min-w-0 gap-1 text-sm sm:col-start-3 sm:row-start-1">{t.servings}
        <SyncedInput name="servings" inputMode="decimal" value={rationalText(servings?.value)} autoComplete="off"
          aria-invalid={invalid.servings ? true : undefined} />
        {invalid.servings ? <span className="text-destructive-foreground text-xs">{invalid.servings}</span> : null}</label>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {timing('preparation', t.prepTime)}{timing('cooking', t.cookTime)}{timing('total', t.totalTime)}
    </div>
  </section>;
}
