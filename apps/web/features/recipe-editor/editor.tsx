'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, CircleCheckIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import type { DetailsValues } from '../studio/details-form.tsx';
import type { MainClient } from '../studio/types.ts';
import { browserMain } from './api.ts';
import { FailureAlert, useSnapshot } from './controls.tsx';
import { DetailsSection } from './details.tsx';
import { IngredientsSection } from './ingredients.tsx';
import { MeasuresSection } from './measures.tsx';
import { messages, type RecipeEditorMessages } from './messages.ts';
import { messages as workPageMessages } from '../work-page/messages.ts';
import { MethodSection } from './method.tsx';
import { ingredients, type RecipeState, steps } from './model.ts';
import { readRecipeDraft as readRecipe } from './api.ts';
import { Preview } from './preview.tsx';
import { missingBeforePublishing, PublishBar } from './publish.tsx';
import { createRecipePublisher } from './publication.ts';
import { publishWhenSettled } from './publish-settled.ts';
import { mainRecipeExportApi, type RecipeExport } from './export-api.ts';
import type { RecipeImportApi } from './import-api.ts';
import { RecipeExchange } from './recipe-exchange.tsx';
import { createDetailsSaver, createNotesWriter, entryOf, type NotesState } from './saves.ts';
import { createRecipeStore } from './store.ts';
import { materializeData } from 'native-i18n';

export interface RecipeEditorProps {
  /** The Work's IRI and its Main Version, the Composition's owner. */
  work: string;
  mainVersion: string;
  /** The recipe's own language: title, description, ingredients and steps are written in it. */
  language: string;
  actingSubject: string;
  /** Where the recipe reads, for the way back and the link after publishing. */
  workHref: string;
  initial: { recipe: RecipeState; /** Set when the first read left a later page unread. */ next?: string | null;
    details: { head: string | null; values: DetailsValues }; notes: NotesState };
  locale: UiLocale;
  messages: RecipeEditorMessages;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: () => MainClient;
  recordingFetch?: typeof fetch;
  /** When set, file import uses this client. Production keeps the browser fetch. */
  importApi?: RecipeImportApi;
  /** A deterministic command-key source for control stories. */
  newImportId?: () => string;
  /** When set, replaces the browser download after the export reader succeeds. */
  saveExport?: (exported: RecipeExport, contentLanguage?: string, recipeName?: string) => void;
}

export function RecipeEditor({ work, mainVersion, language, actingSubject, workHref, initial, locale, messages: catalog, main, recordingFetch,
  importApi, newImportId, saveExport }: RecipeEditorProps) {
  const t = useMemo(() => materializeData(catalog, { locale }), [catalog, locale]);
  const client = main ?? browserMain;
  const [store] = useState(() => createRecipeStore({ work, mainVersion, actingSubject, initial: initial.recipe, main: client,
    loading: Boolean(initial.next) }));
  const exportApi = useMemo(() => mainRecipeExportApi(client), [client]);
  const [importing, setImporting] = useState(false);
  const [loaded, setLoaded] = useState(initial.recipe.nodes.length);
  const [details] = useState(() => createDetailsSaver({ main: client, actingSubject, work, language, initial: initial.details }));
  const [notes] = useState(() => createNotesWriter({ main: client, actingSubject, work, mainVersion, language, initial: initial.notes }));
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    if (!initial.next) return;
    let stop = false;
    store.beginLoad();
    void readRecipe(client(), work, actingSubject, count => { if (!stop) setLoaded(count); }).then(result => {
      if (stop) return;
      if (result.ok) store.finishLoad(result.data);
      else store.failLoad(result.problem === 'stale' ? 'stale' : result.detail === 'too-large' ? 'too-large' : 'failed');
    });
    return () => { stop = true; };
  }, [actingSubject, client, initial.next, store, work]);
  const recipe = useSnapshot(store);
  const saved = useSnapshot(details);
  const written = useSnapshot(notes);
  const notesField = useRef<HTMLTextAreaElement>(null);
  const [typedNotes, setTypedNotes] = useState(initial.notes.body);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [publication] = useState(() => createRecipePublisher({ main: client, work, actingSubject,
    recipe: () => store.snapshot().state }));
  const publicationState = useSnapshot(publication);
  const [published, setPublished] = useState(false);
  const [publishedNotesHead, setPublishedNotesHead] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<{ details: typeof saved.failure; notes: typeof written.failure }>({ details: null, notes: null });
  const state = recipe.state;
  const entry = entryOf(saved.values, language);
  const saving = recipe.busy || saved.busy || written.busy || importing || publicationState.busy;
  const held = recipe.loading || recipe.loadFailure !== null;
  const loadMessage = recipe.loadFailure === 'too-large' ? t.recipeTooLong
    : recipe.loadFailure === 'stale' ? t.recipeChangedWhileLoading
      : recipe.loadFailure ? t.loadingRestFailed
        : t.loadingRestCount({ count: String(loaded) });
  const missing = missingBeforePublishing({ title: entry.title, ingredients: ingredients(state).length, steps: steps(state).length,
    notes: typedNotes });
  const accessRemoved = recipe.revoked || saved.revoked || written.revoked;
  const common = { store, state, language, t, busy: recipe.busy || importing, closed: accessRemoved };
  const detailsFailure = saved.failure && saved.failure !== dismissed.details ? saved.failure : null;
  const notesFailure = written.failure && written.failure !== dismissed.notes ? written.failure : null;
  const denialAlert = recipe.failure?.refusal.kind === 'denied' || detailsFailure === 'denied' || notesFailure === 'denied';
  // What Main holds replaces the typed text once it is saved, as the field does.
  useEffect(() => setTypedNotes(written.notes.body), [written.notes.body]);
  const publish = async () => {
    if (store.snapshot().revoked || details.snapshot().revoked || notes.snapshot().revoked) return;
    setDismissed({ details: null, notes: null });
    let notesAtPublication: string | null = null;
    // A cooking time can be waiting behind preparation. Publication waits for every such write,
    // then reads the notes field, which may not have been left yet.
    const outcome = await publishWhenSettled({
      recipe: store, details, notes,
      body: () => (notesField.current?.value ?? notes.snapshot().notes.body).trim(),
      failure: () => details.snapshot().failure ?? notes.snapshot().failure
        ?? (store.snapshot().failure ? 'unavailable' : null),
      publishRecipe: () => { notesAtPublication = notes.snapshot().notes.head; return publication.publish(); },
    });
    if (outcome.kind === 'published') { setPublished(true); setPublishedNotesHead(notesAtPublication); }
  };

  return <div className="grid gap-6">
    <h1 className="sr-only">{t.pageTitle}</h1>
    <div className="sticky top-0 z-20 -mx-4 grid gap-2 border-border/60 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-b-2xl sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Link href={workHref} aria-disabled={saving || undefined} onClick={event => { if (saving) event.preventDefault(); }}
          className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'pointer-coarse:h-11' })}>
          <ArrowLeftIcon aria-hidden="true" />{t.backToRecipe}</Link>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <RecipeExchange structure={state.structure} revision={state.head} actingSubject={actingSubject} locale={locale}
            messages={catalog} disabled={saving || held || accessRemoved} api={exportApi}
            importApi={importApi} newId={newImportId} save={saveExport}
            prepareImport={async () => {
              const result = await store.submit({ kind: 'ensureRecipe' });
              const current = store.snapshot().state;
              return (result.kind === 'saved' || result.kind === 'unchanged') && current.structure && current.head
                ? { structure: current.structure, revision: current.head } : null;
            }}
            contentLanguage={language} recipeName={entry.title}
            onImportBusyChange={setImporting}
            onStaleRefresh={async () => await store.reload() ? store.snapshot().state.head : null}
            onImported={async () => store.reload()} />
          <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-muted-foreground text-sm">
            {recipe.loading ? <><LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t.loadingRest}</>
              : importing ? <><LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t.importing}</>
                : saving ? <><LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t.saving}</>
              : recipe.loadFailure ? <span>{loadMessage}</span>
              : accessRemoved ? (denialAlert ? null : <span>{t.failDenied}</span>)
              : <><CircleCheckIcon aria-hidden="true" className="size-4" />{t.allSaved}</>}</p>
        </div>
      </div>
      <PublishBar snapshot={{ published: publicationState.revision === state.head && state.head !== null && publishedNotesHead === written.notes.head,
        publishing: publicationState.busy }} missing={missing} pending={saving || held} held={held} closed={accessRemoved}
        onPublish={() => void publish()} workHref={workHref} t={t} />
    </div>
    {published && publicationState.revision === state.head && publishedNotesHead === written.notes.head && !saving ? <Alert variant="success" role="status"><CircleCheckIcon aria-hidden="true" />
      <AlertDescription>{t.publishedNotice}</AlertDescription></Alert> : null}
    {publicationState.failure ? <FailureAlert t={t} refusal={{ kind: publicationState.failure }} detail={publicationState.detail}
      title={publicationState.failure === 'moved' ? t.publicationChanged
        : publicationState.failure === 'denied' ? t.publicationDenied : undefined}
      onRefresh={publicationState.failure === 'moved' ? () => void store.reload().then(loaded => { if (loaded) publication.dismiss(); }) : undefined}
      onRetry={() => void publish()} onDismiss={publication.dismiss} /> : null}
    {recipe.failure ? <FailureAlert t={t} refusal={recipe.failure.refusal}
      detail={'detail' in recipe.failure.refusal ? recipe.failure.refusal.detail : null}
      onRetry={() => void store.retry()} onDismiss={() => store.dismiss()} /> : null}
    {detailsFailure ? <FailureAlert t={t} refusal={{ kind: detailsFailure }} onDismiss={() => setDismissed(current => ({ ...current, details: detailsFailure }))} /> : null}
    {notesFailure ? <FailureAlert t={t} refusal={{ kind: notesFailure }} onDismiss={() => setDismissed(current => ({ ...current, notes: notesFailure }))} /> : null}
    <div role="group" aria-label={t.editorView} className="flex w-fit rounded-full border border-border/60 p-0.5 lg:hidden">
      {(['edit', 'preview'] as const).map(option => <button key={option} type="button" aria-pressed={view === option} onClick={() => setView(option)}
        className={cn('rounded-full px-4 py-2 text-sm font-medium pointer-coarse:min-h-11', view === option
          ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>{option === 'edit' ? t.viewEdit : t.viewPreview}</button>)}
    </div>
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className={cn('grid min-w-0 content-start gap-10', view === 'preview' && 'hidden lg:grid')}>
        <fieldset disabled={importing} className="m-0 grid min-w-0 content-start gap-10 border-0 p-0">
          <DetailsSection details={details} notes={notes} notesField={notesField} onNotesInput={setTypedNotes}
            language={language} t={t} closed={accessRemoved} />
          {held ? <section aria-busy={recipe.loading || undefined} className="grid justify-items-start gap-3 rounded-2xl border border-border/60 p-4">
            <h2 className="font-semibold text-lg">{t.loadingRest}</h2>
            <p role="status">{loadMessage}</p>
            {recipe.loadFailure && recipe.loadFailure !== 'too-large'
              ? <Button type="button" variant="outline" onClick={() => void store.reload()}>{t.retry}</Button> : null}
          </section> : <>
            <MeasuresSection {...common} />
            <IngredientsSection {...common} />
            <MethodSection {...common} />
          </>}
        </fieldset>
      </div>
      <aside className={cn('min-w-0 lg:sticky lg:top-28 lg:self-start', view === 'edit' && 'hidden lg:block')}>
        <Preview state={state} title={entry.title} description={entry.description} notes={typedNotes} language={language} t={t}
          messages={workPageMessages[locale]} recordingFetch={recordingFetch} />
      </aside>
    </div>
  </div>;
}

export { messages };
