'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
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
import { hintFor, WriteStatus } from './write-status.tsx';
import type { WriteState } from './write.ts';
import { WorkPicker, type WorkLoader } from './work-picker.tsx';

/** A realization a release can cover, with the exact revision the page read: Main pins coverage to it. */
export interface CoverableRealization { id: string; revision: string; work: string; language: string }
/** Another Work's name and the realizations it offers for coverage. */
export type RealizationLoader = (work: string) => Promise<{ title: string | null; items: CoverableRealization[] }>;

type Action = (previous: WriteState, form: FormData) => Promise<WriteState>;

/** Another Work's realizations, read as the editor's Agent: Main answers a signed-in read only for an acting Agent. */
const browserRealizations = (actingSubject: string | undefined): RealizationLoader => async work => {
  const main = browserMainApi();
  const [{ data, error }, header] = await Promise.all([main.v1.works({ id: work }).realizations.get({ query: { limit: 20, actingSubject } }),
    main.v1.works({ id: work }).get({ query: { actingSubject } })]);
  if (error || !data) throw new Error('unavailable');
  return { title: header.data?.title.value ?? null,
    items: data.items.map(item => ({ id: item.id, revision: item.revision, work: item.work, language: item.language })) };
};

const languageField = (t: Copy, name: string, value: string, hint: string | null) => <Field invalid={hint !== null}>
  <FieldLabel>{name === 'language' ? t.language : t.releaseTitleLanguage}</FieldLabel>
  <Input name="language" defaultValue={value} required maxLength={35} autoComplete="off" spellCheck={false}
    placeholder="ja" /><FieldHelper>{t.languageHelp}</FieldHelper><FieldError>{hint}</FieldError></Field>;

/** The form that adds a realization: one text with its language, translators, source and provenance. */
export function RealizationEditor({ work, mainVersion, mainRevision, existing, allowed, locale, action, messages }: {
  work: string; mainVersion: string; mainRevision: string; existing: readonly CoverableRealization[];
  allowed: readonly string[]; locale: UiLocale; action: Action; messages: WorkLevelsEditMessages;
}) {
  const t = materializeData(messages, { locale });
  const { state, run, pending, values, reload, reloading, formKey, root } = useWrite(action);
  if (!mayEdit(allowed)) return null;
  const hint = (field: string) => hintFor(state, field, t);
  return <div ref={root}><form key={formKey} action={run} aria-label={t.addRealization}
    className="grid gap-4 rounded-2xl border border-border/60 bg-card p-4">
    <h3 className="font-semibold text-base">{t.addRealization}</h3>
    <p className="text-muted-foreground text-sm">{t.realizationHelp}</p>
    <div aria-live="polite" className="grid gap-3"><WriteStatus state={state} t={t} onReload={reload} reloading={reloading} /></div>
    <input type="hidden" name="work" value={work} />
    <input type="hidden" name="mainVersion" value={mainVersion} /><input type="hidden" name="mainRevision" value={mainRevision} />
    <div className="grid gap-4 sm:grid-cols-2">
      {languageField(t, 'language', values.language ?? '', hint('language'))}
      <Field><FieldLabel>{t.realizationKind}</FieldLabel>
        <NativeSelect name="kind" defaultValue={values.kind ?? 'translation'}>
          <option value="translation">{t.kindTranslation}</option><option value="original">{t.kindOriginal}</option></NativeSelect></Field>
    </div>
    <label className="flex items-center gap-3 text-sm">
      <input type="checkbox" name="translatorMe" defaultChecked={values.translatorMe === 'on'} className="size-4 accent-primary" />
      {t.translatorMe}</label>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field invalid={hint('translators') !== null}><FieldLabel>{t.translators}</FieldLabel>
        <Input name="translators" defaultValue={values.translators ?? ''} autoComplete="off" spellCheck={false} />
        <FieldHelper>{t.translatorsHelp}</FieldHelper><FieldError>{hint('translators')}</FieldError></Field>
      <Field invalid={hint('publishers') !== null}><FieldLabel>{t.publishers}</FieldLabel>
        <Input name="publishers" defaultValue={values.publishers ?? ''} autoComplete="off" spellCheck={false} />
        <FieldHelper>{t.publishersHelp}</FieldHelper><FieldError>{hint('publishers')}</FieldError></Field>
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
    <Field invalid={hint('evidence') !== null}><FieldLabel>{t.realizationEvidence}</FieldLabel>
      <Input name="evidence" type="url" inputMode="url" defaultValue={values.evidence ?? ''} maxLength={2048} autoComplete="off"
        placeholder="https://" /><FieldHelper>{t.realizationEvidenceHelp}</FieldHelper><FieldError>{hint('evidence')}</FieldError></Field>
    <Button type="submit" isLoading={pending} disabled={pending} className="w-fit">
      <LanguagesIcon aria-hidden="true" />{pending ? t.submitting : t.addRealizationButton}</Button>
  </form></div>;
}

/** The realizations a release may cover: this Work's, and those of other Works the editor names. */
function CoveragePicker({ work, own, locale, t, load, loadWorks, chosen }: {
  work: string; own: readonly CoverableRealization[]; locale: UiLocale; t: Copy; load: RealizationLoader;
  loadWorks?: WorkLoader; chosen: ReadonlySet<string>;
}) {
  const [others, setOthers] = useState<{ work: string; title: string | null; items: CoverableRealization[] }[]>([]);
  const [failed, setFailed] = useState<'none' | 'error' | null>(null);
  async function add(text: string) {
    const id = workIdFrom(text);
    if (!id || id === work || others.some(group => group.work === id)) return;
    try {
      const { title, items } = await load(id);
      setFailed(items.length ? null : 'none');
      if (items.length) setOthers(groups => [...groups, { work: id, title, items }]);
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
    {others.map(entry => <div key={entry.work}>{group(t.coverageWorkHeading({ work: entry.title ?? entry.work }), entry.items)}</div>)}
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
export function ReleaseEditor({ work, own, allowed, locale, action, messages, actingSubject, load, loadWorks }: {
  work: string; own: readonly CoverableRealization[]; allowed: readonly string[]; locale: UiLocale; action: Action; messages: WorkLevelsEditMessages;
  /** The session Agent other Works' realizations are read as. */
  actingSubject?: string;
  load?: RealizationLoader; loadWorks?: WorkLoader;
}) {
  const t = materializeData(messages, { locale });
  const { state, run, pending, values, reload, reloading, formKey, root } = useWrite(action);
  if (!mayEdit(allowed)) return null;
  const hint = (field: string) => hintFor(state, field, t);
  const chosen = new Set((values.coverage ?? '').split('\n').filter(Boolean));
  return <div ref={root}><form key={formKey} action={run} aria-label={t.addRelease}
    className="grid gap-4 rounded-2xl border border-border/60 bg-card p-4">
    <h3 className="font-semibold text-base">{t.addRelease}</h3>
    <p className="text-muted-foreground text-sm">{t.releaseHelp}</p>
    <div aria-live="polite" className="grid gap-3"><WriteStatus state={state} t={t} onReload={reload} reloading={reloading} /></div>
    <input type="hidden" name="work" value={work} />
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
      <Field invalid={hint('title') !== null}><FieldLabel>{t.releaseTitle}</FieldLabel>
        <Input name="title" defaultValue={values.title ?? ''} required maxLength={500} autoComplete="off" /><FieldError>{hint('title')}</FieldError></Field>
      {languageField(t, 'titleLanguage', values.language ?? '', hint('language'))}
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field invalid={hint('kind') !== null}><FieldLabel>{t.releaseKind}</FieldLabel>
        <NativeSelect name="kind" defaultValue={values.kind ?? 'formal'}>
          <option value="formal">{t.releaseFormal}</option><option value="web">{t.releaseWeb}</option>
          <option value="fixed">{t.releaseFixed}</option><option value="virtual">{t.releaseVirtual}</option></NativeSelect><FieldError>{hint('kind')}</FieldError></Field>
      <Field invalid={hint('status') !== null}><FieldLabel>{t.releaseStatus}</FieldLabel>
        <NativeSelect name="status" defaultValue={values.status ?? 'official'}>
          <option value="official">{t.statusOfficial}</option><option value="unofficial">{t.statusUnofficial}</option>
          <option value="virtual">{t.statusVirtual}</option><option value="withdrawn">{t.statusWithdrawn}</option>
          <option value="cancelled">{t.statusCancelled}</option></NativeSelect><FieldError>{hint('status')}</FieldError></Field>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field><FieldLabel>{t.platform}</FieldLabel>
        <Input name="platform" defaultValue={values.platform ?? ''} maxLength={120} autoComplete="off" />
        <FieldHelper>{t.platformHelp}</FieldHelper></Field>
      <Field invalid={hint('territory') !== null}><FieldLabel>{t.territory}</FieldLabel>
        <Input name="territory" defaultValue={values.territory ?? ''} maxLength={3} autoComplete="off" />
        <FieldHelper>{t.territoryHelp}</FieldHelper><FieldError>{hint('territory')}</FieldError></Field>
      <Field><FieldLabel>{t.publisher}</FieldLabel>
        <Input name="publisher" defaultValue={values.publisher ?? ''} maxLength={300} autoComplete="off" /></Field>
      <Field invalid={hint('year') !== null}><FieldLabel>{t.publicationYear}</FieldLabel>
        <Input name="year" inputMode="numeric" defaultValue={values.year ?? ''} maxLength={4} autoComplete="off" /><FieldError>{hint('year')}</FieldError></Field>
      <Field><FieldLabel>{t.editionStatement}</FieldLabel>
        <Input name="edition" defaultValue={values.edition ?? ''} maxLength={200} autoComplete="off" /></Field>
      <Field invalid={hint('isbn13') !== null}><FieldLabel>{t.isbn13}</FieldLabel>
        <Input name="isbn13" inputMode="numeric" defaultValue={values.isbn13 ?? ''} maxLength={17} autoComplete="off" /><FieldError>{hint('isbn13')}</FieldError></Field>
    </div>
    <Field invalid={hint('identifiers') !== null}><FieldLabel>{t.identifiers}</FieldLabel>
      <Textarea name="identifiers" defaultValue={values.identifiers ?? ''} rows={2} spellCheck={false} />
      <FieldHelper>{t.identifiersHelp}</FieldHelper><FieldError>{hint('identifiers')}</FieldError></Field>
    <fieldset data-field="coverage" className="grid gap-2" aria-describedby={hint('coverage') ? 'coverage-error' : undefined}>
      <legend className="font-medium text-sm">{t.coverage}</legend>
      <p className="text-muted-foreground text-xs">{t.coverageHelp}</p>
      <CoveragePicker work={work} own={own} locale={locale} t={t} load={load ?? browserRealizations(actingSubject)} loadWorks={loadWorks} chosen={chosen} />
      {hint('coverage') ? <p id="coverage-error" className="text-destructive text-sm dark:text-destructive-foreground">{hint('coverage')}</p> : null}
    </fieldset>
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
  </form></div>;
}
