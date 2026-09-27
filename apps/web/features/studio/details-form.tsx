'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { Textarea } from '@rezics/ui/textarea';
import { CircleCheckIcon, InfoIcon, PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { type FormEvent, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { saveWorkDetails } from './details-api.ts';
import type { StudioMessages } from './messages.ts';
import { languageName } from './studio-home.tsx';
import { writingLanguages } from './types.ts';

export interface DetailsEntry { language: string; title: string; description: string }
export interface DetailsValues { originalTitle: string; originalLanguage: string; entries: DetailsEntry[] }

export interface DetailsState {
  status: 'idle' | 'saved' | 'error' | 'denied' | 'stale';
  /** Why an error happened, for its message. */
  reason?: 'invalid' | 'pending' | 'failed';
  /** The metadata head the next save expects: Main's header revision, or null before the first save. */
  head: string | null;
  values: DetailsValues;
  /** On a stale save: what the winning save holds, shown beside the writer's kept values. */
  theirs?: DetailsEntry[];
}

export type SaveDetails = (input: { actingSubject: string; work: string; head: string | null; values: DetailsValues }) =>
  Promise<Omit<DetailsState, 'message'>>;

/**
 * A Work's details as readers see them: a title and description per language
 * and the original title. The fields belong to the writer until a save
 * succeeds; a refusal or a stale head only adds a note, and after a stale
 * head the next save is a deliberate overwrite of the version shown.
 */
export function DetailsForm({ agent, work, initialState, save = saveWorkDetails, locale, messages }: {
  agent: AgentOption; work: string; initialState: DetailsState;
  /** Stories pass a stand-in; the app saves through the BFF. */
  save?: SaveDetails; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const keys = useRef(0);
  const keyed = (entry: DetailsEntry) => ({ ...entry, key: ++keys.current });
  const [state, setState] = useState(initialState);
  const [entries, setEntries] = useState(() => (initialState.values.entries.length ? initialState.values.entries
    : [{ language: '', title: '', description: '' }]).map(keyed));
  const [original, setOriginal] = useState({ title: initialState.values.originalTitle,
    language: initialState.values.originalLanguage });
  const [pending, setPending] = useState(false);
  const edit = (index: number, patch: Partial<DetailsEntry>) =>
    setEntries(current => current.map((entry, other) => other === index ? { ...entry, ...patch } : entry));
  const choices = (current: string) => current && !writingLanguages.includes(current as never)
    ? [current, ...writingLanguages] : writingLanguages;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    const values = { originalTitle: original.title, originalLanguage: original.language,
      entries: entries.map(({ key: _key, ...entry }) => entry) };
    setState(await save({ actingSubject: agent.iri, work, head: state.head, values }));
    setPending(false);
  };
  const error = state.reason === 'invalid' ? t.detailsInvalid : state.reason === 'pending' ? t.detailsPending : t.detailsFailed;
  return <form onSubmit={event => void submit(event)} className="grid gap-5">
    <ul className="grid gap-4">
      {entries.map((entry, index) => <li key={entry.key} className="grid gap-3 rounded-2xl border border-border/60 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field className="w-full sm:w-64">
            <FieldLabel>{t.detailsLanguage}</FieldLabel>
            <NativeSelect value={entry.language} onChange={event => edit(index, { language: event.target.value })}
              required={Boolean(entry.title || entry.description)} size="sm">
              <NativeSelectOption value="">—</NativeSelectOption>
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
          <Input value={entry.title} onChange={event => edit(index, { title: event.target.value })} maxLength={500}
            lang={entry.language || undefined} className="font-work-title" />
        </Field>
        <Field>
          <FieldLabel>{t.description}</FieldLabel>
          <Textarea value={entry.description} onChange={event => edit(index, { description: event.target.value })}
            maxLength={4000} rows={4} lang={entry.language || undefined} className="[text-autospace:normal]" />
        </Field>
      </li>)}
    </ul>
    <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={entries.length >= 20}
      onClick={() => setEntries(current => [...current, keyed({ language: '', title: '', description: '' })])}>
      <PlusIcon aria-hidden="true" />{t.addLanguage}</Button>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
      <Field>
        <FieldLabel>{t.originalTitle}</FieldLabel>
        <Input value={original.title} onChange={event => setOriginal(current => ({ ...current, title: event.target.value }))}
          maxLength={500} lang={original.language || undefined} className="font-work-title" />
      </Field>
      <Field>
        <FieldLabel>{t.detailsLanguage}</FieldLabel>
        <NativeSelect value={original.language} required={Boolean(original.title)}
          onChange={event => setOriginal(current => ({ ...current, language: event.target.value }))}>
          <NativeSelectOption value="">—</NativeSelectOption>
          {choices(original.language).map(tag => <NativeSelectOption key={tag} value={tag} lang={tag}>
            {languageName(tag, locale)}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
    </div>
    {state.status === 'saved' ? <p role="status" className="flex items-center gap-2 text-sm text-success-foreground">
      <CircleCheckIcon aria-hidden="true" className="size-4" />{t.detailsSaved}</p> : null}
    {state.status === 'error' ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription role="alert" className="text-destructive-foreground">{error}</AlertDescription></Alert> : null}
    {state.status === 'denied' ? <Alert variant="warning"><InfoIcon aria-hidden="true" />
      <AlertTitle role="alert">{t.detailsDenied}</AlertTitle><AlertDescription>{t.detailsDeniedHelp}</AlertDescription></Alert>
      : null}
    {state.status === 'stale' ? <Alert variant="info"><InfoIcon aria-hidden="true" />
      <AlertTitle role="alert">{t.detailsStale}</AlertTitle>
      {state.theirs?.length ? <AlertDescription><dl className="grid gap-1">{state.theirs.map(entry =>
        <div key={entry.language} className="flex flex-wrap gap-x-2"><dt className="font-medium">
          {languageName(entry.language, locale)}</dt>
          <dd lang={entry.language}>{[entry.title, entry.description].filter(Boolean).join(' — ')}</dd></div>)}</dl>
      </AlertDescription> : null}</Alert> : null}
    <Button type="submit" className="justify-self-start" isLoading={pending} disabled={pending}>
      {pending ? t.savingDetails : t.saveDetails}</Button>
  </form>;
}
