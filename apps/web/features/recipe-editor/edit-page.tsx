import { Suspense } from 'react';
import { ChefHatIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { mainApi } from '../api/main.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { globalWorkHref } from '../work-page/route.ts';
import { readWorkHeader, reader } from '../work-page/read.ts';
import { recipeActor } from './acting.ts';
import { copyOf } from './messages.ts';
import { loadRecipeAuthoring } from './authoring-page.ts';
import { RecipeAuthoringBody, RecipeAuthoringPending } from './authoring-page.tsx';
import { recipeEditHref } from './route.ts';

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
  return <Suspense fallback={<RecipeAuthoringPending locale={locale} />}>
    <Authoring main={main} id={id} actingSubject={actingSubject} signedIn={viewer.signedIn} named={Boolean(named)}
      workRef={workRef} locale={locale} returnTo={returnTo} />
  </Suspense>;
}

async function Authoring({ main, id, actingSubject, signedIn, named, workRef, locale, returnTo }: {
  main: import('../studio/types.ts').MainClient; id: string; actingSubject: string | null; signedIn: boolean; named: boolean;
  workRef: string; locale: UiLocale; returnTo: string;
}) {
  const view = await loadRecipeAuthoring(main, {
    id, actingSubject, signedIn,
    // loadWork already read this header for the session. A named Agent is a different subject.
    readHeader: named ? undefined : () => readWorkHeader(id, locale),
  });
  return <RecipeAuthoringBody view={view} locale={locale} workRef={workRef}
    workHref={globalWorkHref(workRef)} signInHref={signInPath(returnTo)} />;
}
