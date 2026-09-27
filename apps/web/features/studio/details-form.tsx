'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { Textarea } from '@rezics/ui/textarea';
import { CircleCheckIcon, InfoIcon, PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useActionState, useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { StudioMessages } from './messages.ts';
import { languageName } from './studio-home.tsx';
import { writingLanguages } from './types.ts';

export interface DetailsEntry { language: string; title: string; description: string }
export interface DetailsValues { originalTitle: string; originalLanguage: string; entries: DetailsEntry[] }

export interface DetailsState {
  status: 'idle' | 'saved' | 'error' | 'denied' | 'stale';
  message?: string;
  /** The metadata head the next save expects: Main's header revision, or null before the first save. */
  head: string | null;
  values: DetailsValues;
  /** On a stale save: what the winning save holds, shown beside the writer's kept values. */
  theirs?: DetailsEntry[];
}

let rowKeys = 0;
const rows = (entries: DetailsEntry[]) => (entries.length ? entries : [{ language: '', title: '', description: '' }])
  .map(entry => ({ ...entry, key: ++rowKeys }));

/**
 * A Work's details as readers see them: a title and description per language
 * and the original title. Saving expects the head it was loaded from; when
 * someone saved first, the writer's values stay and the head moves, so a
 * second save is a deliberate overwrite.
 */
export function DetailsForm({ agent, work, action: save, initialState, locale, messages }: {
  agent: AgentOption; work: string; action: (previous: DetailsState, form: FormData) => Promise<DetailsState>;
  initialState: DetailsState; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const [state, action, pending] = useActionState(save, initialState);
  const [entries, setEntries] = useState(() => rows(state.values.entries));
  useEffect(() => { setEntries(rows(state.values.entries)); }, [state]);
  const choices = (current: string) => current && !writingLanguages.includes(current as never)
    ? [current, ...writingLanguages] : writingLanguages;
  return <form action={action} className="grid gap-5">
    <input type="hidden" name="agent" value={agent.iri} />
    <input type="hidden" name="work" value={work} />
    <input type="hidden" name="expectedHead" value={state.head ?? ''} />
    <ul className="grid gap-4">
      {entries.map((entry, index) => <li key={entry.key} className="grid gap-3 rounded-2xl border border-border/60 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field className="w-full sm:w-64">
            <FieldLabel>{t.detailsLanguage}</FieldLabel>
            <NativeSelect name="entryLanguage" defaultValue={entry.language} required size="sm">
              <NativeSelectOption value="" disabled>—</NativeSelectOption>
              {choices(entry.language).map(tag => <NativeSelectOption key={tag} value={tag} lang={tag}>
                {languageName(tag, locale)}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          {entries.length > 1 ? <Button type="button" variant="ghost" size="sm"
            onClick={() => setEntries(current => current.filter((_, other) => other !== index))}>
            <XIcon aria-hidden="true" />{t.removeLanguage}</Button> : null}
        </div>
        <Field>
          <FieldLabel>{t.localizedTitle}</FieldLabel>
          <Input name="entryTitle" defaultValue={entry.title} maxLength={500} lang={entry.language || undefined}
            className="font-work-title" />
        </Field>
        <Field>
          <FieldLabel>{t.description}</FieldLabel>
          <Textarea name="entryDescription" defaultValue={entry.description} maxLength={4000} rows={4}
            lang={entry.language || undefined} className="[text-autospace:normal]" />
        </Field>
      </li>)}
    </ul>
    <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={entries.length >= 20}
      onClick={() => setEntries(current => [...current, ...rows([{ language: '', title: '', description: '' }])])}>
      <PlusIcon aria-hidden="true" />{t.addLanguage}</Button>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
      <Field>
        <FieldLabel>{t.originalTitle}</FieldLabel>
        <Input name="originalTitle" defaultValue={state.values.originalTitle} maxLength={500}
          lang={state.values.originalLanguage || undefined} className="font-work-title" />
      </Field>
      <Field>
        <FieldLabel>{t.detailsLanguage}</FieldLabel>
        <NativeSelect name="originalLanguage" defaultValue={state.values.originalLanguage} size="md">
          <NativeSelectOption value="">—</NativeSelectOption>
          {choices(state.values.originalLanguage).map(tag => <NativeSelectOption key={tag} value={tag} lang={tag}>
            {languageName(tag, locale)}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
    </div>
    {state.status === 'saved' ? <p role="status" className="flex items-center gap-2 text-sm text-success-foreground">
      <CircleCheckIcon aria-hidden="true" className="size-4" />{state.message}</p> : null}
    {state.status === 'error' ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription role="alert" className="text-destructive-foreground">{state.message}</AlertDescription></Alert> : null}
    {state.status === 'denied' ? <Alert variant="warning"><InfoIcon aria-hidden="true" />
      <AlertTitle role="alert">{state.message}</AlertTitle><AlertDescription>{t.detailsDeniedHelp}</AlertDescription></Alert>
      : null}
    {state.status === 'stale' ? <Alert variant="info"><InfoIcon aria-hidden="true" />
      <AlertTitle role="alert">{state.message}</AlertTitle>
      {state.theirs?.length ? <AlertDescription><dl className="grid gap-1">{state.theirs.map(entry =>
        <div key={entry.language} className="flex flex-wrap gap-x-2"><dt className="font-medium">
          {languageName(entry.language, locale)}</dt>
          <dd lang={entry.language}>{[entry.title, entry.description].filter(Boolean).join(' — ')}</dd></div>)}</dl>
      </AlertDescription> : null}</Alert> : null}
    <Button type="submit" className="justify-self-start" isLoading={pending} disabled={pending}>
      {pending ? t.savingDetails : t.saveDetails}</Button>
  </form>;
}
