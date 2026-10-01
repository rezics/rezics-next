'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect } from '@rezics/ui/native-select';
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { mayEdit } from './allowed.ts';
import { materializeData } from 'native-i18n';
import type { Copy, WorkLevelsEditMessages } from './messages.ts';
import { useWrite } from './use-write.ts';
import { hintFor, WriteStatus } from './write-status.tsx';
import type { Values, WriteState } from './write.ts';
import { WorkPicker, type WorkLoader } from './work-picker.tsx';

export interface EditablePart {
  occurrence: string;
  /** The part's local label in this Work's numbering. */
  label: string;
  /** The Work the part places, by the name Main gave it; absent for a group. */
  name: string | null;
  inclusion: 'required' | 'optional' | 'extra';
  role: 'group' | 'part';
}

const inclusionOptions = (t: Copy) => [['required', t.inclusionRequired], ['optional', t.inclusionOptional],
  ['extra', t.inclusionExtra]] as const;

/** The hidden fields every control on the list sends: which Work, which list, and the head the page showed. */
function Context({ work, structure, head, intent, children }: { work: string; structure: string | null; head: string | null;
  intent: string; children?: ReactNode }) {
  return <>
    <input type="hidden" name="work" value={work} /><input type="hidden" name="structure" value={structure ?? ''} />
    <input type="hidden" name="head" value={head ?? ''} /><input type="hidden" name="intent" value={intent} />{children}
  </>;
}

/**
 * A Work's parts in publication order with the controls to add, reorder, relabel and remove them.
 * Every control sends the head the page showed, so a list someone else changed is refused by Main
 * and the editor reloads it without losing what they typed. Renders nothing for a viewer whose
 * allowed actions do not include editing.
 */
export function PartsEditor({ work, structure, head, parts, allowed, locale, action, messages, load, links }: {
  work: string; structure: string | null; head: string | null; parts: readonly EditablePart[];
  allowed: readonly string[]; locale: UiLocale; action: (previous: WriteState, form: FormData) => Promise<WriteState>; messages: WorkLevelsEditMessages;
  load?: WorkLoader; links?: { first: string | null; next: string | null };
}) {
  const t = materializeData(messages, { locale });
  const { state, run, pending, values, reload, reloading, formKey, root } = useWrite(action);
  if (!mayEdit(allowed)) return null;
  /** The hint for a field of the form whose last submit was refused, so one form's refusal never marks another's field. */
  const refused = values.intent === 'update' ? `update:${values.occurrence}` : values.intent ?? '';
  const hintIn = (form: string, field: string) => (refused === form ? hintFor(state, field, t) : null);
  /** What was typed into this row's own form when its last submit was refused, so a refusal never loses it. */
  const typed = (part: EditablePart) => values.intent === 'update' && values.occurrence === part.occurrence ? values : null;
  /** What was typed into the add form, when that is the form whose last submit was refused. */
  const added: Values = values.intent === 'add' ? values : {};
  return <div ref={root} className="grid gap-6">
    <div aria-live="polite" className="grid gap-3"><WriteStatus state={state} t={t} onReload={reload} reloading={reloading} /></div>
    {parts.length ? <ol aria-label={t.partsList} className="grid divide-y divide-border/60 border-border/60 border-y">
      {parts.map((part, index) => <li key={part.occurrence} className="grid gap-2 py-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span data-part-label className="w-28 shrink-0 break-words font-semibold tabular-nums">{part.label || t.unlabelled}</span>
          <span data-part-name className="min-w-0 flex-1 break-words">{part.name}</span>
          {part.inclusion !== 'required' ? <Badge variant="outline">{part.inclusion === 'optional' ? t.inclusionOptional
            : t.inclusionExtra}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {index > 0 ? <form action={run}><Context work={work} structure={structure} head={head} intent="move">
            <input type="hidden" name="occurrence" value={part.occurrence} />
            <input type="hidden" name="after" value={index >= 2 ? parts[index - 2]!.occurrence : 'first'} />
            <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={t.moveUp({ label: part.label })}>
              <ArrowUpIcon aria-hidden="true" /></Button></Context></form> : null}
          {index < parts.length - 1 ? <form action={run}><Context work={work} structure={structure} head={head} intent="move">
            <input type="hidden" name="occurrence" value={part.occurrence} />
            <input type="hidden" name="after" value={parts[index + 1]!.occurrence} />
            <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={t.moveDown({ label: part.label })}>
              <ArrowDownIcon aria-hidden="true" /></Button></Context></form> : null}
          {part.role === 'part' ? <details open={typed(part) ? true : undefined}
            className="rounded-xl border border-border/60 px-2 py-1 text-sm open:basis-full">
            <summary className="flex cursor-pointer items-center gap-1 py-1" aria-label={t.editPart({ label: part.label })}>
              <PencilIcon aria-hidden="true" className="size-4" />{t.edit}</summary>
            <form action={run} data-form={`update:${part.occurrence}`} className="grid gap-3 py-2"><Context work={work} structure={structure} head={head} intent="update">
              <input type="hidden" name="occurrence" value={part.occurrence} />
              <Field invalid={hintIn(`update:${part.occurrence}`, 'label') !== null}><FieldLabel>{t.partLabel}</FieldLabel>
                <Input name="label" defaultValue={typed(part)?.label ?? part.label} maxLength={500} required autoComplete="off" />
                <FieldError>{hintIn(`update:${part.occurrence}`, 'label')}</FieldError></Field>
              <Field><FieldLabel>{t.partInclusion}</FieldLabel>
                <NativeSelect name="inclusion" defaultValue={typed(part)?.inclusion ?? part.inclusion}>
                  {inclusionOptions(t).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </NativeSelect></Field>
              <Button type="submit" size="sm" disabled={pending} className="w-fit">{t.savePart}</Button></Context></form>
          </details> : null}
          <details className="rounded-xl border border-border/60 px-2 py-1 text-sm open:basis-full">
            <summary className="flex cursor-pointer items-center gap-1 py-1" aria-label={t.removePart({ label: part.label })}>
              <Trash2Icon aria-hidden="true" className="size-4" />{t.removeButton}</summary>
            <form action={run} className="grid gap-2 py-2"><Context work={work} structure={structure} head={head} intent="remove">
              <input type="hidden" name="occurrence" value={part.occurrence} />
              <p className="text-muted-foreground">{t.removeConfirm}</p>
              <Button type="submit" variant="destructive" size="sm" disabled={pending} className="w-fit">{t.removeButton}</Button></Context></form>
          </details>
        </div>
      </li>)}
    </ol> : null}
    {links && (links.first || links.next) ? <nav className="flex flex-wrap justify-between gap-2">
      {links.first ? <Link href={links.first} className="text-primary text-sm underline-offset-4 hover:underline">{t.firstParts}</Link> : <span />}
      {links.next ? <Link href={links.next} className="text-primary text-sm underline-offset-4 hover:underline">{t.moreParts}</Link> : null}
    </nav> : null}
    <form key={formKey} action={run} data-form="add" className="grid gap-4 rounded-2xl border border-border/60 bg-card p-4" aria-label={t.addPart}>
      <h3 className="font-semibold text-base">{t.addPart}</h3>
      <Context work={work} structure={structure} head={head} intent="add" />
      <Field invalid={hintIn('add', 'target') !== null}><FieldLabel>{t.partTarget}</FieldLabel>
        <WorkPicker name="target" locale={locale} t={t} load={load} initial={added.target ?? ''} invalid={hintIn('add', 'target') !== null} />
        <FieldHelper>{t.partTargetHelp}</FieldHelper><FieldError>{hintIn('add', 'target')}</FieldError></Field>
      <Field invalid={hintIn('add', 'label') !== null}><FieldLabel>{t.partLabel}</FieldLabel>
        <Input name="label" defaultValue={added.label ?? ''} maxLength={500} required autoComplete="off" />
        <FieldHelper>{t.partLabelHelp}</FieldHelper><FieldError>{hintIn('add', 'label')}</FieldError></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field><FieldLabel>{t.partInclusion}</FieldLabel>
          <NativeSelect name="inclusion" defaultValue={added.inclusion ?? 'required'}>
            {inclusionOptions(t).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></Field>
        <Field invalid={hintIn('add', 'after') !== null}><FieldLabel>{t.partPlace}</FieldLabel>
          <NativeSelect name="after" defaultValue={added.after ?? 'last'}>
            <option value="last">{t.placeLast}</option><option value="first">{t.placeFirst}</option>
            {parts.map(part => <option key={part.occurrence} value={part.occurrence}>{t.placeAfter({ label: part.label })}</option>)}
          </NativeSelect><FieldError>{hintIn('add', 'after')}</FieldError></Field>
      </div>
      <Button type="submit" isLoading={pending} disabled={pending} className="w-fit">
        <PlusIcon aria-hidden="true" />{pending ? t.submitting : t.addPartButton}</Button>
    </form>
  </div>;
}
