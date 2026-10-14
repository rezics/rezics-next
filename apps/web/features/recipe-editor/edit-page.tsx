import { ChefHatIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { mainApi } from '../api/main.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { bodyText, editorValue } from '../document-editor/body.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { readStudioText, readWorkTexts } from '../studio/read.ts';
import { idOf } from '../studio/types.ts';
import { globalWorkHref } from '../work-page/route.ts';
import { readWorkHeader, reader } from '../work-page/read.ts';
import { recipeActor } from './acting.ts';
import { copyOf } from './messages.ts';
import { loadRecipeAuthoring } from './recipe-authoring-recorded-page.ts';
import { RecipeAuthoringBody } from './recipe-authoring-recorded-page.tsx';
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

/** Server composition of `/w/{ref}/edit/recipe`: the same mapping a recorded story runs, on the host client. */
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
  const actingSubject = named ?? viewer.actingSubject ?? null;
  const main = named ? await mainApi() : viewer.main;
  const returnTo = localizedPath(agentSegment ? `${recipeEditHref(workRef)}?agent=${encodeURIComponent(agentSegment)}`
    : recipeEditHref(workRef), locale);
  const view = await loadRecipeAuthoring(main, {
    id, actingSubject, signedIn: viewer.signedIn, readNotes,
    // loadWork already read this header for the session. A named Agent is a different subject.
    readHeader: named ? undefined : () => readWorkHeader(id, locale),
  });
  // A notes continuation the production scan does not return stays the existing unavailable state.
  if (view.kind === 'discrepancy') {
    return <EmptyState icon={ChefHatIcon} role="status" tone="destructive" title={t.unavailableTitle} description={t.unavailableBody} />;
  }
  return <RecipeAuthoringBody view={view} locale={locale} workRef={workRef}
    workHref={globalWorkHref(workRef)} signInHref={signInPath(returnTo)} />;
}
