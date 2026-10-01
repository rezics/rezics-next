'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { LinkIcon } from 'lucide-react';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mayEdit } from './allowed.ts';
import { type KindOption, viaOf } from './kinds.ts';
import { materializeData } from 'native-i18n';
import type { WorkLevelsEditMessages } from './messages.ts';
import { urlPlaceholder } from './placeholders.ts';
import { useWrite } from './use-write.ts';
import { hintFor, WriteStatus } from './write-status.tsx';
import type { WriteState } from './write.ts';
import { WorkPicker, type WorkLoader } from './work-picker.tsx';

/**
 * Records how the Work being edited relates to another, with evidence. The kinds and their words
 * are Main's: the form offers what the lexicon renders for this Work's side and never a label of
 * its own. A derivation pins the Work's Main Version at the head the page showed, so Main refuses it
 * if the Work moved since. Renders nothing for a viewer whose allowed actions do not include editing.
 */
export function RelationEditor({ work, mainVersion, head, kinds, allowed, locale, action, messages, load }: {
  work: string; mainVersion: string; head: string; kinds: readonly KindOption[];
  allowed: readonly string[]; locale: UiLocale; action: (previous: WriteState, form: FormData) => Promise<WriteState>; messages: WorkLevelsEditMessages;
  load?: WorkLoader;
}) {
  const t = materializeData(messages, { locale });
  const { state, run, pending, values, reload, reloading, formKey, root } = useWrite(action);
  const [chosen, setChosen] = useState<string | null>(null);
  if (!mayEdit(allowed)) return null;
  const hint = (field: string) => hintFor(state, field, t);
  if (!kinds.length) return <p role="status" className="text-muted-foreground text-sm">{t.noKindsBody}</p>;
  const current = kinds.find(kind => kind.key === (chosen ?? values.kind)) ?? kinds[0]!;
  return <div ref={root}><form key={formKey} action={run} aria-label={t.recordRelation}
    className="grid gap-4 rounded-2xl border border-border/60 bg-card p-4">
    <h3 className="font-semibold text-base">{t.recordRelation}</h3>
    <p className="text-muted-foreground text-sm">{t.relationsHelp}</p>
    <div aria-live="polite" className="grid gap-3"><WriteStatus state={state} t={t} onReload={reload} reloading={reloading} /></div>
    <input type="hidden" name="work" value={work} />
    <input type="hidden" name="mainVersion" value={mainVersion} /><input type="hidden" name="head" value={head} />
    <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-start">
      <Field invalid={hint('kind') !== null}><FieldLabel>{t.relKind}</FieldLabel>
        <ChoiceSelect name="kind" label={t.relKind} value={current.key} onValueChange={setChosen} className="w-full"
          options={kinds.map(kind => ({ value: kind.key, label: kind.label, lang: kind.language }))} /><FieldHelper>{t.relKindHelp}</FieldHelper><FieldError>{hint('kind')}</FieldError></Field>
      <Field invalid={hint('counterpart') !== null}><FieldLabel>{t.relCounterpart}</FieldLabel>
        <WorkPicker name="counterpart" locale={locale} t={t} load={load} initial={values.counterpart ?? ''}
          invalid={hint('counterpart') !== null} /><FieldHelper>{t.relCounterpartHelp}</FieldHelper><FieldError>{hint('counterpart')}</FieldError></Field>
    </div>
    <Field invalid={hint('evidence') !== null}><FieldLabel>{t.relEvidence}</FieldLabel>
      <Input name="evidence" type="url" inputMode="url" defaultValue={values.evidence ?? ''} required maxLength={2048}
        autoComplete="off" placeholder={urlPlaceholder} /><FieldHelper>{t.relEvidenceHelp}</FieldHelper><FieldError>{hint('evidence')}</FieldError></Field>
    {viaOf(current.key) === 'derivation' ? <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" name="unresolved" defaultChecked={values.unresolved === 'on'} className="mt-1 size-4 accent-primary" />
      <span className="grid gap-0.5"><span>{t.relUnresolved}</span>
        <span className="text-muted-foreground text-xs">{t.relUnresolvedHelp}</span></span></label> : null}
    <Button type="submit" isLoading={pending} disabled={pending} className="w-fit">
      <LinkIcon aria-hidden="true" />{pending ? t.submitting : t.recordButton}</Button>
  </form></div>;
}
