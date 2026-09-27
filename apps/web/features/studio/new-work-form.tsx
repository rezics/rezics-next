'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { BookOpenIcon, CookingPotIcon, FileTextIcon, HourglassIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useActionState, useId } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { StudioMessages } from './messages.ts';
import { AgentIdentity, studioAgentName } from './studio-frame.tsx';
import { languageName } from './parts.tsx';
import { type WorkType, writingLanguages } from './types.ts';

interface Values { title: string; type: string; language: string }

export type NewWorkState =
  | { status: 'idle'; key: string; values?: Values }
  | { status: 'error'; message: string; key: string; values: Values }
  /** Main is still activating the Work; a retry sends the same key and gets the same Work. */
  | { status: 'pending'; message: string; key: string; values: Values };

const types: Array<{ value: WorkType; icon: typeof BookOpenIcon; label: 'typeBook' | 'typeDocument' | 'typeRecipe';
  help: 'typeBookHelp' | 'typeDocumentHelp' | 'typeRecipeHelp' }> = [
  { value: 'book', icon: BookOpenIcon, label: 'typeBook', help: 'typeBookHelp' },
  { value: 'document', icon: FileTextIcon, label: 'typeDocument', help: 'typeDocumentHelp' },
  { value: 'recipe', icon: CookingPotIcon, label: 'typeRecipe', help: 'typeRecipeHelp' },
];

/**
 * Starts a Work: a title, what kind of Work it is and the language of its text.
 * The Studio Agent is shown on the button itself, so nobody creates as someone else by accident.
 */
export function NewWorkForm({ agent, action: create, initialState, locale, messages }: {
  agent: AgentOption; action: (previous: NewWorkState, form: FormData) => Promise<NewWorkState>;
  initialState: NewWorkState; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const [state, action, pending] = useActionState(create, initialState);
  const errorId = useId();
  // A person writing in this interface most likely writes in its language.
  const values = state.values ?? { title: '', type: 'book', language: locale };
  const languages: readonly string[] = writingLanguages.includes(values.language as never)
    ? writingLanguages : [values.language, ...writingLanguages];
  return <form action={action} className="grid gap-7" aria-describedby={state.status === 'idle' ? undefined : errorId}>
    <input type="hidden" name="agent" value={agent.iri} />
    <input type="hidden" name="key" value={state.key} />
    <Field invalid={state.status === 'error' && !values.title}>
      <FieldLabel>{t.workTitle}</FieldLabel>
      <Input name="title" size="lg" maxLength={200} required defaultValue={values.title} autoComplete="off"
        className="font-work-title text-lg" />
      <FieldHelper>{t.titleHint}</FieldHelper>
    </Field>
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-2 font-medium text-sm">{t.workType}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {types.map(({ value, icon: Icon, label, help }) => <label key={value} className="flex cursor-pointer items-start
          gap-3 rounded-2xl border border-border p-3 hover:bg-accent/60 has-checked:border-primary has-checked:bg-primary/5
          has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32">
          <input type="radio" name="type" value={value} defaultChecked={values.type === value} className="sr-only" />
          <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
          <span className="grid gap-0.5"><span className="font-medium text-sm">{t[label]}</span>
            <span className="text-muted-foreground text-xs">{t[help]}</span></span>
        </label>)}
      </div>
    </fieldset>
    <Field>
      <FieldLabel>{t.writingLanguage}</FieldLabel>
      <NativeSelect name="language" defaultValue={values.language} className="sm:max-w-72">
        {languages.map(tag => <NativeSelectOption key={tag} value={tag} lang={tag}>
          {languageName(tag, locale)}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
    {state.status === 'error' ? <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription id={errorId} role="alert" className="text-destructive-foreground">{state.message}</AlertDescription>
    </Alert> : null}
    {state.status === 'pending' ? <Alert variant="info">
      <HourglassIcon aria-hidden="true" />
      <AlertDescription id={errorId} role="status" className="text-foreground">{state.message}</AlertDescription>
    </Alert> : null}
    <div className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid gap-1">
        <span className="text-muted-foreground text-xs">{t.writingAs}</span>
        <AgentIdentity agent={agent} messages={messages} locale={locale} />
      </div>
      <Button type="submit" size="lg" isLoading={pending} disabled={pending}>
        {pending ? t.creating : t.createAs({ agent: studioAgentName(agent, t) })}</Button>
    </div>
  </form>;
}
