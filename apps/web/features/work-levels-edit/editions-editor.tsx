'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect } from '@rezics/ui/native-select';
import { Textarea } from '@rezics/ui/textarea';
import { BookPlusIcon, LanguagesIcon } from 'lucide-react';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { mayEdit } from './allowed.ts';
import { materializeData } from 'native-i18n';
import type { Copy, WorkLevelsEditMessages } from './messages.ts';
import { workIdFrom } from './route.ts';
import { useWrite } from './use-write.ts';
import { invalidField, WriteStatus } from './write-status.tsx';
import type { WriteState } from './write.ts';
import { WorkPicker, type WorkLoader } from './work-picker.tsx';

/** A realization a release can cover, with the exact revision the page read: Main pins coverage to it. */
export interface CoverableRealization { id: string; revision: string; work: string; language: string }
export type RealizationLoader = (work: string) => Promise<CoverableRealization[]>;

type Action = (previous: WriteState, form: FormData) => Promise<WriteState>;

const browserRealizations: RealizationLoader = async work => {
  const { data, error } = await browserMainApi().v1.works({ id: work }).realizations.get({ query: { limit: 20 } });
  if (error || !data) throw new Error('unavailable');
  return data.items.map(item => ({ id: item.id, revision: item.revision, work: item.work, language: item.language }));
};

const languageField = (t: Copy, name: string, value: string, invalid: boolean) => <Field invalid={invalid}>
  <FieldLabel>{name === 'language' ? t.language : t.releaseTitleLanguage}</FieldLabel>
  <Input name="language" defaultValue={value} required maxLength={35} autoComplete="off" spellCheck={false}
    placeholder="ja" /><FieldHelper>{t.languageHelp}</FieldHelper></Field>;

/** The form that adds a realization: one text with its language, translators, source and provenance. */
export function RealizationEditor({ work, mainVersion, mainRevision, existing, allowed, locale, action, messages }: {
  work: string; mainVersion: string; mainRevision: string; existing: readonly CoverableRealization[];
  allowed: readonly string[]; locale: UiLocale; action: Action; messages: WorkLevelsEditMessages;
}) {
  const t = materializeData(messages, { locale });
  const { state, run, pending, values, reload, reloading, formKey } = useWrite(action);
  if (!mayEdit(allowed)) return null;
  const invalid = invalidField(state);
  return <form key={formKey} action={run} aria-label={t.addRealization}
    className="grid gap-4 rounded-2xl border border-border/60 bg-card p-4">
    <h3 className="font-semibold text-base">{t.addRealization}</h3>
    <p className="text-muted-foreground text-sm">{t.realizationHelp}</p>
    <div aria-live="polite" className="grid gap-3"><WriteStatus state={state} t={t} onReload={reload} reloading={reloading} /></div>
    <input type="hidden" name="work" value={work} />
    <input type="hidden" name="mainVersion" value={mainVersion} /><input type="hidden" name="mainRevision" value={mainRevision} />
    <div className="grid gap-4 sm:grid-cols-2">
      {languageField(t, 'language', values.language ?? '', invalid === 'language')}
      <Field><FieldLabel>{t.realizationKind}</FieldLabel>
        <NativeSelect name="kind" defaultValue={values.kind ?? 'translation'}>
          <option value="translation">{t.kindTranslation}</option><option value="original">{t.kindOriginal}</option></NativeSelect></Field>
    </div>
    <label className="flex items-center gap-3 text-sm">
      <input type="checkbox" name="translatorMe" defaultChecked={values.translatorMe === 'on'} className="size-4 accent-primary" />
      {t.translatorMe}</label>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field invalid={invalid === 'translators'}><FieldLabel>{t.translators}</FieldLabel>
        <Input name="translators" defaultValue={values.translators ?? ''} autoComplete="off" spellCheck={false} />
        <FieldHelper>{t.translatorsHelp}</FieldHelper></Field>
      <Field invalid={invalid === 'publishers'}><FieldLabel>{t.publishers}</FieldLabel>
        <Input name="publishers" defaultValue={values.publishers ?? ''} autoComplete="off" spellCheck={false} />
        <FieldHelper>{t.publishersHelp}</FieldHelper></Field>
    </div>
    <Field><FieldLabel>{t.realizationSource}</FieldLabel>
      <NativeSelect name="source" defaultValue={values.source ?? 'unresolved'}>
        <option value="unresolved">{t.sourceUnresolved}</option><option value="main-version">{t.sourceMainVersion}</option>
        {existing.map(item => <option key={item.id} value={`realization:${item.id.slice(-36)}:${item.revision.slice(-36)}`}
          lang={item.language}>{t.sourceRealization({ language: item.language })}</option>)}
      </NativeSelect></Field>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field><FieldLabel>{t.realizationStatus}</FieldLabel>
        <NativeSelect name="status" defaultValue={values.status ?? 'unofficial'}>
          <option value="official">{t.statusOfficial}</option><option value="unofficial">{t.statusUnofficial}</option></NativeSelect></Field>
      <Field><FieldLabel>{t.verification}</FieldLabel>
        <NativeSelect name="verification" defaultValue={values.verification ?? 'unverified'}>
          <option value="verified">{t.verified}</option><option value="unverified">{t.unverified}</option></NativeSelect></Field>
    </div>
    <Field invalid={invalid === 'evidence'}><FieldLabel>{t.realizationEvidence}</FieldLabel>
      <Input name="evidence" type="url" inputMode="url" defaultValue={values.evidence ?? ''} maxLength={2048} autoComplete="off"
        placeholder="https://" /><FieldHelper>{t.realizationEvidenceHelp}</FieldHelper></Field>
    <Button type="submit" isLoading={pending} disabled={pending} className="w-fit">
      <LanguagesIcon aria-hidden="true" />{pending ? t.submitting : t.addRealizationButton}</Button>
  </form>;
}

/** The realizations a release may cover: this Work's, and those of other Works the editor names. */
function CoveragePicker({ work, own, locale, t, load, loadWorks, chosen }: {
  work: string; own: readonly CoverableRealization[]; locale: UiLocale; t: Copy; load: RealizationLoader;
  loadWorks?: WorkLoader; chosen: ReadonlySet<string>;
}) {
  const [others, setOthers] = useState<{ work: string; items: CoverableRealization[] }[]>([]);
  const [failed, setFailed] = useState<'none' | 'error' | null>(null);
  async function add(text: string) {
    const id = workIdFrom(text);
    if (!id || id === work || others.some(group => group.work === id)) return;
    try {
      const items = await load(id);
      setFailed(items.length ? null : 'none');
      if (items.length) setOthers(groups => [...groups, { work: id, items }]);
    } catch { setFailed('error'); }
  }
  const group = (heading: string, items: readonly CoverableRealization[]) => <fieldset className="grid gap-2">
    <legend className="font-medium text-sm">{heading}</legend>
    {items.map(item => <label key={item.id} className="flex items-center gap-3 text-sm">
      <input type="checkbox" name="coverage" value={`${item.id} ${item.revision}`}
        defaultChecked={chosen.has(`${item.id} ${item.revision}`)} className="size-4 accent-primary" />
      <span lang={item.language}>{item.language}</span><span className="text-muted-foreground text-xs">{item.id.slice(-8)}</span></label>)}
  </fieldset>;
  return <div className="grid gap-3">
    {own.length ? group(t.coverageThisWork, own) : <p className="text-muted-foreground text-sm">{t.noRealizationsYet}</p>}
    {others.map(entry => <div key={entry.work}>{group(t.coverageWorkHeading({ work: entry.work.slice(0, 8) }), entry.items)}</div>)}
    <div className="grid gap-2 rounded-xl border border-border/60 p-3">
      <span className="font-medium text-sm">{t.coverageMore}</span>
      <WorkPicker name="coverageWork" locale={locale} t={t} load={loadWorks} initial="" label={t.coverageMore} />
      <CoverageLoad t={t} onLoad={text => { void add(text); }} />
      {failed === 'none' ? <p role="status" className="text-muted-foreground text-sm">{t.coverageNone}</p> : null}
      {failed === 'error' ? <p role="alert" className="text-destructive text-sm">{t.coverageFailed}</p> : null}
    </div>
  </div>;
}

/** Reads the picker's chosen Work ID from its hidden field when the button is pressed. */
function CoverageLoad({ t, onLoad }: { t: Copy; onLoad: (text: string) => void }) {
  return <Button type="button" variant="outline" size="sm" className="w-fit" onClick={event => {
    const field = event.currentTarget.form?.elements.namedItem('coverageWork');
    if (field instanceof HTMLInputElement) onLoad(field.value);
  }}>{t.coverageLoad}</Button>;
}

/** The form that adds a release: identifiers, format, platform, territory and what it covers. */
export function ReleaseEditor({ work, own, allowed, locale, action, messages, load = browserRealizations, loadWorks }: {
  work: string; own: readonly CoverableRealization[]; allowed: readonly string[]; locale: UiLocale; action: Action; messages: WorkLevelsEditMessages;
  load?: RealizationLoader; loadWorks?: WorkLoader;
}) {
  const t = materializeData(messages, { locale });
  const { state, run, pending, values, reload, reloading, formKey } = useWrite(action);
  if (!mayEdit(allowed)) return null;
  const invalid = invalidField(state);
  const chosen = new Set((values.coverage ?? '').split('\n').filter(Boolean));
  return <form key={formKey} action={run} aria-label={t.addRelease}
    className="grid gap-4 rounded-2xl border border-border/60 bg-card p-4">
    <h3 className="font-semibold text-base">{t.addRelease}</h3>
    <p className="text-muted-foreground text-sm">{t.releaseHelp}</p>
    <div aria-live="polite" className="grid gap-3"><WriteStatus state={state} t={t} onReload={reload} reloading={reloading} /></div>
    <input type="hidden" name="work" value={work} />
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
      <Field invalid={invalid === 'title'}><FieldLabel>{t.releaseTitle}</FieldLabel>
        <Input name="title" defaultValue={values.title ?? ''} required maxLength={500} autoComplete="off" /></Field>
      {languageField(t, 'titleLanguage', values.language ?? '', invalid === 'language')}
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field invalid={invalid === 'kind'}><FieldLabel>{t.releaseKind}</FieldLabel>
        <NativeSelect name="kind" defaultValue={values.kind ?? 'formal'}>
          <option value="formal">{t.releaseFormal}</option><option value="web">{t.releaseWeb}</option>
          <option value="fixed">{t.releaseFixed}</option><option value="virtual">{t.releaseVirtual}</option></NativeSelect></Field>
      <Field invalid={invalid === 'status'}><FieldLabel>{t.releaseStatus}</FieldLabel>
        <NativeSelect name="status" defaultValue={values.status ?? 'official'}>
          <option value="official">{t.statusOfficial}</option><option value="unofficial">{t.statusUnofficial}</option>
          <option value="virtual">{t.statusVirtual}</option><option value="withdrawn">{t.statusWithdrawn}</option>
          <option value="cancelled">{t.statusCancelled}</option></NativeSelect></Field>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field><FieldLabel>{t.platform}</FieldLabel>
        <Input name="platform" defaultValue={values.platform ?? ''} maxLength={120} autoComplete="off" />
        <FieldHelper>{t.platformHelp}</FieldHelper></Field>
      <Field invalid={invalid === 'territory'}><FieldLabel>{t.territory}</FieldLabel>
        <Input name="territory" defaultValue={values.territory ?? ''} maxLength={3} autoComplete="off" />
        <FieldHelper>{t.territoryHelp}</FieldHelper></Field>
      <Field><FieldLabel>{t.publisher}</FieldLabel>
        <Input name="publisher" defaultValue={values.publisher ?? ''} maxLength={300} autoComplete="off" /></Field>
      <Field invalid={invalid === 'year'}><FieldLabel>{t.publicationYear}</FieldLabel>
        <Input name="year" inputMode="numeric" defaultValue={values.year ?? ''} maxLength={4} autoComplete="off" /></Field>
      <Field><FieldLabel>{t.editionStatement}</FieldLabel>
        <Input name="edition" defaultValue={values.edition ?? ''} maxLength={200} autoComplete="off" /></Field>
      <Field invalid={invalid === 'isbn13'}><FieldLabel>{t.isbn13}</FieldLabel>
        <Input name="isbn13" inputMode="numeric" defaultValue={values.isbn13 ?? ''} maxLength={17} autoComplete="off" /></Field>
    </div>
    <Field invalid={invalid === 'identifiers'}><FieldLabel>{t.identifiers}</FieldLabel>
      <Textarea name="identifiers" defaultValue={values.identifiers ?? ''} rows={2} spellCheck={false} />
      <FieldHelper>{t.identifiersHelp}</FieldHelper></Field>
    <div className="grid gap-2" aria-invalid={invalid === 'coverage' || undefined}>
      <span className="font-medium text-sm">{t.coverage}</span>
      <p className="text-muted-foreground text-xs">{t.coverageHelp}</p>
      <CoveragePicker work={work} own={own} locale={locale} t={t} load={load} loadWorks={loadWorks} chosen={chosen} />
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field><FieldLabel>{t.coverageCompleteness}</FieldLabel>
        <NativeSelect name="completeness" defaultValue={values.completeness ?? 'complete'}>
          <option value="complete">{t.coverageComplete}</option><option value="partial">{t.coveragePartial}</option>
          <option value="trial">{t.coverageTrial}</option><option value="unknown">{t.coverageUnknown}</option></NativeSelect></Field>
      <Field><FieldLabel>{t.coveragePortion}</FieldLabel>
        <Input name="portion" defaultValue={values.portion ?? ''} maxLength={120} autoComplete="off" />
        <FieldHelper>{t.coveragePortionHelp}</FieldHelper></Field>
    </div>
    <Button type="submit" isLoading={pending} disabled={pending || !own.length} className="w-fit">
      <BookPlusIcon aria-hidden="true" />{pending ? t.submitting : t.addReleaseButton}</Button>
  </form>;
}
