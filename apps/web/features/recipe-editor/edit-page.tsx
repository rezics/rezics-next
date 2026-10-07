import { ChefHatIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { bodyText, editorValue } from '../document-editor/body.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { detailsValues } from '../studio/details-api.ts';
import { readStudioText, readWorkTexts } from '../studio/read.ts';
import { canonicalLanguage, workKind } from '../studio/types.ts';
import { mayEdit } from '../work-levels-edit/allowed.ts';
import { readAllowedActions } from '../work-levels-edit/authority.ts';
import { NoAuthority } from '../work-levels-edit/edit-frame.tsx';
import { copyOf as editCopy } from '../work-levels-edit/messages.ts';
import { globalWorkHref } from '../work-page/route.ts';
import { readWorkHeader, reader, settle } from '../work-page/read.ts';
import { RecipeEditor } from './editor.tsx';
import { copyOf, messages } from './messages.ts';
import { type RecipePageLike, stateOf } from './model.ts';
import { recipeEditHref } from './route.ts';
import type { NotesState } from './saves.ts';

/** The notes the cook wrote for the recipe's language, at the draft head Main holds. */
async function readNotes(actingSubject: string, work: string, language: string): Promise<NotesState> {
  const empty: NotesState = { text: null, head: null, body: '', publicationHead: null };
  const texts = await readWorkTexts(actingSubject, work);
  const own = texts.ok ? texts.data.find(text => text.language.toLowerCase() === language.toLowerCase()) : undefined;
  if (!own) return empty;
  const opened = await readStudioText(actingSubject, own.id, own.revision);
  if (!opened.draft.ok) return empty;
  const draft = opened.draft.data;
  return { text: draft.contribution, head: opened.head ?? draft.revision, publicationHead: opened.publicationHead,
    body: bodyText(editorValue(draft.body, draft.document)) };
}

/** Server composition of `/w/{ref}/edit/recipe`: reads what the editor opens with, and no editor without edit authority. */
export async function RecipeEditPage({ workRef, id, locale }: { workRef: string; id: string; locale: UiLocale }) {
  const t = copyOf(locale);
  const [allowed, header, { signedIn, actingSubject, main }] = await Promise.all([readAllowedActions(id),
    readWorkHeader(id, locale), reader()]);
  if (!mayEdit(allowed)) {
    return <NoAuthority workRef={workRef} signedIn={signedIn} t={editCopy(locale)}
      signInHref={signInPath(localizedPath(recipeEditHref(workRef), locale))} />;
  }
  if (!header.ok || !actingSubject) {
    return <EmptyState icon={ChefHatIcon} role="status" tone="destructive" title={t.unavailableTitle} description={t.unavailableBody} />;
  }
  const work = header.data;
  if (workKind(work.types) !== 'recipe') {
    return <EmptyState icon={ChefHatIcon} role="status" title={t.notRecipeTitle} description={t.notRecipeBody} />;
  }
  const language = canonicalLanguage(work.title.language);
  const [recipe, metadata, notes] = await Promise.all([
    settle(async () => main.v1.recipes.works({ id }).get({ query: { actingSubject } })),
    main.v1.works({ id }).metadata.get({ query: { actingSubject } }),
    readNotes(actingSubject, work.id, language),
  ]);
  if (!recipe.ok) return <EmptyState icon={ChefHatIcon} role="status" tone="destructive" title={t.unavailableTitle} description={t.unavailableBody} />;
  return <RecipeEditor work={work.id} mainVersion={work.mainVersion} language={language} actingSubject={actingSubject}
    workHref={globalWorkHref(workRef)} locale={locale} messages={messages[locale]}
    initial={{ recipe: stateOf(recipe.data as RecipePageLike | null), notes,
      details: { head: metadata.data?.revision ?? null, values: detailsValues(metadata.data ?? null, language) } }} />;
}
