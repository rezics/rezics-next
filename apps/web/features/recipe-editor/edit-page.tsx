import { ChefHatIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { mainApi } from '../api/main.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { bodyText, editorValue } from '../document-editor/body.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { readStudioText, readWorkTexts } from '../studio/read.ts';
import { idOf, type MainClient, workKind } from '../studio/types.ts';
import { allowedActionsOf, mayEdit } from '../work-levels-edit/allowed.ts';
import { readAllowedActions } from '../work-levels-edit/authority.ts';
import { NoAuthority } from '../work-levels-edit/edit-frame.tsx';
import { copyOf as editCopy } from '../work-levels-edit/messages.ts';
import { globalWorkHref } from '../work-page/route.ts';
import { readWorkHeader, reader, settle, settleNullable } from '../work-page/read.ts';
import { recipeActor } from './acting.ts';
import { labelFromSummary, recipeLanguage } from './authored-language.ts';
import { RecipeEditor } from './editor.tsx';
import { initialDetails } from './initial-details.ts';
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
  const opened = await readStudioText(actingSubject, idOf(own.id), idOf(own.revision));
  if (!opened.draft.ok) return empty;
  const draft = opened.draft.data;
  return { text: draft.contribution, head: opened.head ?? draft.revision, publicationHead: opened.publicationHead,
    body: bodyText(editorValue(draft.body, draft.document)) };
}

/** The Work's allowed actions for one Agent. Main admits or refuses that Agent; the page does not substitute another. */
async function allowedAs(main: MainClient, id: string, actingSubject: string): Promise<readonly string[]> {
  try {
    const { data } = await main.v1.resources({ resource: id }).page.get({ query: { actingSubject } });
    return allowedActionsOf(data);
  } catch { return []; }
}

/** Server composition of `/w/{ref}/edit/recipe`: reads what the editor opens with, and no editor without edit authority. */
export async function RecipeEditPage({ workRef, id, locale, agentSegment = null }: {
  workRef: string; id: string; locale: UiLocale;
  /** Studio's `@handle` or `@sid` when the link names one. Absent, the session Agent edits. */
  agentSegment?: string | null;
}) {
  const t = copyOf(locale);
  const viewer = await reader();
  const actor = agentSegment
    ? recipeActor(agentSegment, (await readSession())?.agents ?? [], viewer.actingSubject ?? '') : null;
  // A segment that is not an Agent address is refused here. It is not read as the session Agent.
  if (actor?.kind === 'unresolved') {
    return <EmptyState icon={ChefHatIcon} role="status" tone="destructive" title={t.unavailableTitle} description={t.unavailableBody} />;
  }
  const named = actor?.kind === 'named' ? actor.actingSubject : null;
  const actingSubject = named ?? viewer.actingSubject;
  const main = named ? await mainApi() : viewer.main;
  const returnTo = localizedPath(agentSegment ? `${recipeEditHref(workRef)}?agent=${encodeURIComponent(agentSegment)}`
    : recipeEditHref(workRef), locale);
  const [allowed, header] = await Promise.all([
    named && actingSubject ? allowedAs(main, id, actingSubject) : readAllowedActions(id),
    named && actingSubject ? settle(() => main.v1.works({ id }).get({ query: { actingSubject } })) : readWorkHeader(id, locale),
  ]);
  if (!mayEdit(allowed)) {
    return <NoAuthority workRef={workRef} signedIn={viewer.signedIn} t={editCopy(locale)} signInHref={signInPath(returnTo)} />;
  }
  if (!header.ok || !actingSubject) {
    return <EmptyState icon={ChefHatIcon} role="status" tone="destructive" title={t.unavailableTitle} description={t.unavailableBody} />;
  }
  const work = header.data;
  if (workKind(work.types) !== 'recipe') {
    return <EmptyState icon={ChefHatIcon} role="status" title={t.notRecipeTitle} description={t.notRecipeBody} />;
  }
  const [summary, metadata] = await Promise.all([
    settle(() => main.v1.resources({ resource: id }).get({ query: { actingSubject } })),
    main.v1.works({ id }).metadata.get({ query: { actingSubject } }),
  ]);
  const recorded = metadata.data ?? null;
  // The label's language is the one the Work was written in. Once metadata has a title, the header title is chosen for display.
  const summaryName = summary.ok ? labelFromSummary(summary.data) : null;
  const language = recipeLanguage({
    labelLanguage: summaryName?.language ?? null,
    metadataTitles: Boolean(recorded?.localized?.some(row => row.title)),
    headerTitleLanguage: work.title.language,
  });
  if (!language) {
    return <EmptyState icon={ChefHatIcon} role="status" tone="destructive" title={t.unavailableTitle} description={t.unavailableBody} />;
  }
  const [recipe, notes] = await Promise.all([
    settleNullable(async () => main.v1.recipes.works({ id }).get({ query: { actingSubject } })),
    readNotes(actingSubject, work.id, language),
  ]);
  if (!recipe.ok) return <EmptyState icon={ChefHatIcon} role="status" tone="destructive" title={t.unavailableTitle} description={t.unavailableBody} />;
  const label = summaryName ?? { value: work.title.value, language: work.title.language };
  return <RecipeEditor work={work.id} mainVersion={work.mainVersion} language={language} actingSubject={actingSubject}
    workHref={globalWorkHref(workRef)} locale={locale} messages={messages[locale]}
    initial={{ recipe: stateOf(recipe.data as RecipePageLike | null), next: (recipe.data as RecipePageLike | null)?.next ?? null, notes,
      details: { head: recorded?.revision ?? null, values: initialDetails(recorded, language, {
        label, description: work.description, tagline: work.tagline, originalTitle: work.originalTitle,
        completionStatus: work.completionStatus, mainVersionLabel: work.mainVersionLabel,
      }) } }} />;
}
