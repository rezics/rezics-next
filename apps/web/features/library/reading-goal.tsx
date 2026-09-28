'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { materializeData } from 'native-i18n';
import { useState, type FormEvent } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { saveYearlyGoal } from './api.ts';
import type { LibraryMessages } from './messages.ts';
import type { Loaded, YearlyGoal } from './types.ts';

export function ReadingGoal({ agent, initial, locale, messages,
  save = saveYearlyGoal }: { agent: string; initial: Loaded<YearlyGoal>; locale: UiLocale;
  messages: LibraryMessages; save?: typeof saveYearlyGoal }) {
  const t = materializeData(messages, { locale });
  const [goal, setGoal] = useState(initial.ok ? initial.data : null);
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(String(goal?.target ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!goal) return null;

  async function commit(next: number | null) {
    setBusy(true);
    setError(null);
    const result = await save(agent, goal!.year, next, goal!.version);
    setBusy(false);
    if (!result.ok) {
      setError(result.failure === 'moved' ? t.goalChanged : t.goalSaveFailed);
      return;
    }
    setGoal(result.data);
    setTarget(String(result.data.target ?? ''));
    setEditing(false);
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number(target);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return;
    void commit(parsed);
  };
  return <section aria-labelledby="library-yearly-goal" className="grid gap-3 rounded-2xl border border-border/70 p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="library-yearly-goal" className="font-semibold text-lg">
          {t.yearlyGoal({ year: String(goal.year) })}</h2>
        <p className="text-muted-foreground text-sm">{goal.target === null ? t.goalUnset
          : t.goalProgress({ completed: String(goal.completed), target: String(goal.target) })}</p>
      </div>
      {!editing ? <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
        {goal.target === null ? t.setGoal : t.editGoal}</Button> : null}
    </div>
    {goal.target !== null ? <div role="progressbar" aria-label={t.yearlyGoal({ year: String(goal.year) })}
      aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={Math.min(goal.completed, goal.target)}
      className="h-2 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100,
        goal.completed / goal.target * 100)}%` }} /></div> : null}
    {editing ? <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label htmlFor="library-goal-target" className="grid gap-1 text-sm">
        <span>{t.goalTarget}</span>
        <Input id="library-goal-target" type="number" min={1} max={1000} required value={target}
          onChange={event => setTarget(event.target.value)} className="w-28" /></label>
      <Button size="sm" type="submit" disabled={busy}>{t.save}</Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => { setEditing(false); setError(null); }}>
        {t.cancel}</Button>
      {goal.target !== null ? <Button size="sm" type="button" variant="ghost" disabled={busy}
        onClick={() => void commit(null)}>{t.clearGoal}</Button> : null}
    </form> : null}
    {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
  </section>;
}
