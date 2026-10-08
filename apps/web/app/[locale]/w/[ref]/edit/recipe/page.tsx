import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { recipeActor } from '../../../../../../features/recipe-editor/acting.ts';
import { RecipeEditPage } from '../../../../../../features/recipe-editor/edit-page.tsx';
import { copyOf } from '../../../../../../features/recipe-editor/messages.ts';
import { recipeEditHref } from '../../../../../../features/recipe-editor/route.ts';
import { readSession } from '../../../../../../features/auth/session.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';
import { WORK_MISSING_HEADER } from '../../../../../../features/work-page/admission.ts';
import { loadWork, reader, resolveWorkRef } from '../../../../../../features/work-page/read.ts';
import { parseWorkRef, workHref } from '../../../../../../features/work-page/route.ts';
import { WorkUnavailable } from '../../../../../../features/work-page/work-states.tsx';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<{ agent?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await params;
  return { title: copyOf(await requestLocale()).pageTitle, robots: { index: false } };
}

const agentOf = (value: string | string[] | undefined) => typeof value === 'string' && value ? value : null;

/** `/w/{ref}/edit/recipe`: a cook's editor for one recipe: details, yield and time, ingredient sections and steps. */
export default async function WorkRecipeEditPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const segment = agentOf(query.agent);
  // The session Agent needs no segment. A segment that is that same Agent is dropped so the address stays the editor's own.
  if (segment) {
    const [viewer, session] = await Promise.all([reader(), readSession()]);
    const actor = recipeActor(segment, session?.agents ?? [], viewer.actingSubject ?? '');
    if (actor.kind === 'named' && viewer.actingSubject && actor.actingSubject === viewer.actingSubject)
      redirect(localizedPath(recipeEditHref(ref), locale));
    if ((await headers()).get(WORK_MISSING_HEADER) === '1') notFound();
    const parsed = parseWorkRef(ref);
    if (!parsed) notFound();
    const resolved = parsed.kind === 'id' ? { kind: 'work' as const, id: parsed.id } : await resolveWorkRef(parsed);
    if (resolved.kind === 'missing') notFound();
    if (resolved.kind === 'moved') permanentRedirect(localizedPath(workHref(resolved.key), locale));
    if (resolved.kind !== 'work') return <WorkUnavailable messages={await getMessages('workPage', locale)} />;
    return <RecipeEditPage workRef={ref} id={resolved.id} locale={locale} agentSegment={segment} />;
  }
  const work = await loadWork(ref, locale);
  if (!work.ok) return <WorkUnavailable messages={await getMessages('workPage', locale)} />;
  return <RecipeEditPage workRef={ref} id={work.id} locale={locale} />;
}
