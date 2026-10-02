'use client';

import { RadioGroup, RadioGroupItem } from '@rezics/ui/radio-group';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { BookOpenIcon, CookingPotIcon, FileTextIcon, HourglassIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useActionState, useId } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { StudioMessages } from './messages.ts';
import { AgentIdentity, studioAgentName } from './studio-frame.tsx';
import { languageName } from './parts.tsx';
import { entryLabel, type Presentation } from '../catalogue/types.ts';
import { writableTypes, writingLanguages } from './types.ts';

interface Values { title: string; type: string; language: string }

export type NewWorkState =
  | { status: 'idle'; key: string; values?: Values }
  | { status: 'error'; message: string; key: string; values: Values }
  /** Main is still activating the Work; a retry sends the same key and gets the same Work. */
  | { status: 'pending'; message: string; key: string; values: Values };

// The registry names each type and says how it is presented; the picker adds only an icon and a
// line of help per presentation, never per type.
const presentations: Partial<Record<Presentation, { icon: typeof BookOpenIcon;
  help: 'typeBookHelp' | 'typeDocumentHelp' | 'typeRecipeHelp' }>> = {
  book: { icon: BookOpenIcon, help: 'typeBookHelp' },
  recipe: { icon: CookingPotIcon, help: 'typeRecipeHelp' },
};
const documentPresentation = { icon: FileTextIcon, help: 'typeDocumentHelp' } as const;

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
  const choices = writableTypes();
  const values = state.values ?? { title: '', type: choices[0]?.type ?? '', language: '' };
  const languages: readonly string[] = !values.language || values.language === 'und'
    || writingLanguages.includes(values.language as never)
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
      <RadioGroup name="type" defaultValue={values.type} aria-label={t.workType}>
        <div className="grid gap-2 sm:grid-cols-3">
          {choices.map(entry => ({ entry, ...presentations[entry.presentation] ?? documentPresentation }))
            .map(({ entry, icon: Icon, help }) => <RadioGroupItem key={entry.type} className="flex cursor-pointer items-start
            gap-3 rounded-2xl border border-border p-3 hover:bg-accent/60 has-checked:border-primary has-checked:bg-primary/5
            has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32" value={entry.type}>
            <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
            <span className="grid gap-0.5"><span className="font-medium text-sm">{entryLabel(entry, locale)}</span>
              <span className="text-muted-foreground text-xs">{t[help]}</span></span>
          </RadioGroupItem>)}
        </div>
      </RadioGroup>
    </fieldset>
    <Field>
      <FieldLabel>{t.writingLanguage}</FieldLabel>
      <ChoiceSelect name="language" defaultValue={values.language} required className="sm:max-w-72"
        placeholder={t.chooseWritingLanguage} options={[{ value: 'und', label: t.languageUndetermined },
          ...languages.map(tag => ({ value: tag, label: languageName(tag, locale), lang: tag }))]} />
      <FieldHelper>{t.languageError}</FieldHelper>
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
