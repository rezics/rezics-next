'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { buttonVariants } from '@rezics/ui/button';
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
import { MethodSection } from './method.tsx';
import { ingredients, type RecipeState, steps } from './model.ts';
import { Preview } from './preview.tsx';
import { missingBeforePublishing, PublishBar } from './publish.tsx';
import { publishWhenSettled } from './publish-settled.ts';
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
  initial: { recipe: RecipeState; details: { head: string | null; values: DetailsValues }; notes: NotesState };
  locale: UiLocale;
  messages: RecipeEditorMessages;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: () => MainClient;
}

export function RecipeEditor({ work, mainVersion, language, actingSubject, workHref, initial, locale, messages: catalog, main }: RecipeEditorProps) {
  const t = useMemo(() => materializeData(catalog, { locale }), [catalog, locale]);
  const client = main ?? browserMain;
  const [store] = useState(() => createRecipeStore({ work, mainVersion, actingSubject, initial: initial.recipe, main: client }));
  const [details] = useState(() => createDetailsSaver({ main: client, actingSubject, work, language, initial: initial.details }));
  const [notes] = useState(() => createNotesWriter({ main: client, actingSubject, work, mainVersion, language, initial: initial.notes }));
  useEffect(() => () => store.dispose(), [store]);
  const recipe = useSnapshot(store);
  const saved = useSnapshot(details);
  const written = useSnapshot(notes);
  const notesField = useRef<HTMLTextAreaElement>(null);
  const [typedNotes, setTypedNotes] = useState(initial.notes.body);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [published, setPublished] = useState(false);
  const [dismissed, setDismissed] = useState<{ details: typeof saved.failure; notes: typeof written.failure }>({ details: null, notes: null });
  const state = recipe.state;
  const entry = entryOf(saved.values, language);
  const saving = recipe.busy || saved.busy || written.busy;
  const missing = missingBeforePublishing({ title: entry.title, ingredients: ingredients(state).length, steps: steps(state).length,
    notes: typedNotes });
  const common = { store, state, language, t, busy: recipe.busy };
  const detailsFailure = saved.failure && saved.failure !== dismissed.details ? saved.failure : null;
  const notesFailure = written.failure && written.failure !== dismissed.notes ? written.failure : null;
  // What Main holds replaces the typed text once it is saved, as the field does.
  useEffect(() => setTypedNotes(written.notes.body), [written.notes.body]);
  const publish = async () => {
    // A cooking time can be waiting behind preparation. Publication waits for every such write,
    // then reads the notes field, which may not have been left yet.
    const outcome = await publishWhenSettled({
      recipe: store, details, notes,
      body: () => (notesField.current?.value ?? notes.snapshot().notes.body).trim(),
    });
    if (outcome.kind === 'published') setPublished(true);
  };

  return <div className="grid gap-6">
    <div className="sticky top-0 z-20 -mx-4 grid gap-2 border-border/60 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-b-2xl sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Link href={workHref} aria-disabled={saving || undefined} onClick={event => { if (saving) event.preventDefault(); }}
          className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'pointer-coarse:h-11' })}>
          <ArrowLeftIcon aria-hidden="true" />{t.backToRecipe}</Link>
        <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-muted-foreground text-sm">
          {saving ? <><LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t.saving}</>
            : <><CircleCheckIcon aria-hidden="true" className="size-4" />{t.allSaved}</>}</p>
      </div>
      <PublishBar snapshot={written} missing={missing} pending={saving} onPublish={() => void publish()} workHref={workHref} t={t} />
    </div>
    {published && written.published && !saving ? <Alert variant="success" role="status"><CircleCheckIcon aria-hidden="true" />
      <AlertDescription>{t.publishedNotice}</AlertDescription></Alert> : null}
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
        <DetailsSection details={details} notes={notes} notesField={notesField} onNotesInput={setTypedNotes} language={language} t={t} />
        <MeasuresSection {...common} />
        <IngredientsSection {...common} />
        <MethodSection {...common} />
      </div>
      <aside className={cn('min-w-0 lg:sticky lg:top-28 lg:self-start', view === 'edit' && 'hidden lg:block')}>
        <Preview state={state} title={entry.title} description={entry.description} language={language} t={t} />
      </aside>
    </div>
  </div>;
}

export { messages };
