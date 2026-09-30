'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import { Textarea } from '@rezics/ui/textarea';
import { materializeData } from 'native-i18n';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { changed, evidenceOf, type Fields, fieldsOf, headerCandidate, type Source } from './candidate.ts';
import { newKey, type Outcome } from './commands.ts';
import { failureKey } from './labels.ts';
import type { ProposalMessages } from './messages.ts';
import type { Blocker, Evidence, HeaderState } from './types.ts';
import { blockerText } from './parts.tsx';
import { SourcesField } from './sources-field.tsx';

const OTHER = '__other';

/** What a submit sends: the candidate, its evidence and the key that makes a retry replay. */
export type Submit = (candidate: ReturnType<typeof headerCandidate>, evidence: Evidence[], key: string) =>
  Promise<Outcome<unknown>>;

/**
 * Writes a Work's header correction: pick a language, change the title,
 * synopsis or tagline, attach sources. It builds the `component-correction`
 * candidate and hands it to `submit`; Main validates it, so the editor checks
 * only that something changed and never decides who may propose.
 */
export function CorrectionEditor({ state, language: start, languages, initial, rebased, submitLabel, onSubmit,
  onCancel, locale, messages }: {
  state: HeaderState; language: string; languages?: readonly string[];
  initial?: { fields: Fields; sources: Source[] }; rebased?: boolean; submitLabel: string; onSubmit: Submit;
  onCancel?: () => void; locale: UiLocale; messages: ProposalMessages;
}) {
  const t = materializeData(messages, { locale });
  const tags = languages ?? state.localized.map(row => row.language);
  const [selected, setSelected] = useState(tags.includes(start) || !tags.length ? start : tags[0]!);
  const [custom, setCustom] = useState('');
  const [fields, setFields] = useState<Fields>(initial?.fields ?? fieldsOf(state, selected));
  const [sources, setSources] = useState<Source[]>(initial?.sources ?? [{ source: '', locator: '' }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; blocker?: Blocker } | null>(null);
  const key = useRef(newKey());
  const language = selected === OTHER ? custom.trim() : selected;
  // A different body is a different request: a retry of the same one replays, an edit starts a new one.
  const edit = () => { key.current = newKey(); setError(null); };
  const choose = (value: string) => {
    edit();
    setSelected(value);
    if (value !== OTHER) setFields(fieldsOf(state, value));
    else setFields({ title: '', description: '', tagline: '' });
  };
  const submit = async () => {
    if (!language || !changed(state, language, fields)) { setError({ text: t.nothingChanged }); return; }
    setPending(true);
    const outcome = await onSubmit(headerCandidate(state, language, fields),
      evidenceOf(sources, new Date().toISOString().slice(0, 10)), key.current);
    setPending(false);
    if (!outcome.ok) setError({ text: String(t[failureKey[outcome.failure]]), ...outcome.blocker ? { blocker: outcome.blocker } : {} });
  };
  const text = (name: keyof Fields, label: string, multiline = false) => <Field>
    <FieldLabel>{label}</FieldLabel>
    {multiline ? <Textarea value={fields[name]} rows={6} maxLength={4200} dir="auto" lang={language || undefined}
      onChange={event => { edit(); setFields({ ...fields, [name]: event.currentTarget.value }); }} />
      : <Input value={fields[name]} maxLength={600} dir="auto" lang={language || undefined}
        onChange={event => { edit(); setFields({ ...fields, [name]: event.currentTarget.value }); }} />}
  </Field>;
  return <form noValidate className="grid gap-5" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {rebased ? <Alert variant="warning" role="status"><AlertDescription className="text-foreground">{t.rebased}</AlertDescription>
    </Alert> : null}
    <Field>
      <FieldLabel>{t.languageLabel}</FieldLabel>
      <NativeSelect value={selected} onChange={event => choose(event.currentTarget.value)} className="w-full sm:w-64">
        {tags.map(tag => <NativeSelectOption key={tag} value={tag}>{languageLabel(tag, locale)}</NativeSelectOption>)}
        <NativeSelectOption value={OTHER}>{t.languageOther}</NativeSelectOption>
      </NativeSelect>
    </Field>
    {selected === OTHER ? <Field>
      <FieldLabel>{t.languageCustomLabel}</FieldLabel>
      <Input value={custom} maxLength={35} className="w-full sm:w-64"
        onChange={event => { edit(); setCustom(event.currentTarget.value); }} />
      <FieldHelper>{t.languageCustomHelp}</FieldHelper>
    </Field> : null}
    {text('title', t.fieldTitle)}
    {text('description', t.fieldDescription, true)}
    {text('tagline', t.fieldTagline)}
    <p className="-mt-2 text-muted-foreground text-xs">{t.fieldHelp}</p>
    <SourcesField sources={sources} t={t} onChange={next => { edit(); setSources(next); }} />
    {error ? <Field invalid><FieldError role="alert">{error.text}{error.blocker ? ` ${blockerText(error.blocker,
      t)}` : ''}</FieldError></Field> : null}
    <div className="flex flex-wrap justify-end gap-2">
      {onCancel ? <Button type="button" variant="outline" onClick={onCancel}>{t.cancel}</Button> : null}
      <Button type="submit" disabled={pending}>{submitLabel}</Button>
    </div>
  </form>;
}

function languageLabel(tag: string, locale: UiLocale) {
  try { const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag); return name && name !== tag ? `${name} (${tag})` : tag; }
  catch { return tag; }
}
