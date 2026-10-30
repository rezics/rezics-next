import type { KernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import {
  AgentReadError,
  agentPath,
  agentTitle,
  continueAgentList,
  formerHandleRedirect,
  loadAgentPage,
} from '../../features/pages/agent';
import { accountOf, viewIsPublic } from '../../features/pages/account-read';
import { pageContext, type SubjectPageData } from '../../features/pages/subject';
import { subjectTabs } from '../../features/pages/views';
import { readPageAuthors } from '../../identity/read';
import { keepSearch } from '../../subject/subject-href';
import { readPublicRealms } from './read';

export type AccountView = View | 'realms';

export function pageProfile(page: SubjectPageData) {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind !== 'account' || page.reads[key]?.status !== 200) continue;
    const profile = accountOf(page.reads[key]?.body);
    if (profile?.id === page.account?.id) return profile;
  }
}

/** Public reads always use anonymous authority, including continuations and optional operator hydration. */
export async function loadPublicAccountJourney(
  client: KernelClient,
  input: {
    handle: string;
    locale: string;
    view?: AccountView | undefined;
    cursor?: string | undefined;
    search?: string | undefined;
  },
) {
  const { handle, locale, cursor, search } = input;
  const view = input.view && input.view !== 'overview' ? input.view : undefined;
  const compositionView = view === 'realms' ? undefined : view;
  try {
    const [result, overview] = await Promise.all([
      loadAgentPage(client, handle, compositionView, locale),
      compositionView ? loadAgentPage(client, handle, undefined, locale) : undefined,
    ]);
    if (result.kind === 'missing' || overview?.kind === 'missing') {
      const moved = await formerHandleRedirect(client, handle, locale, view, search);
      if (moved) return { kind: 'redirect' as const, redirectTo: moved.href };
      if (view && overview?.kind === 'page')
        return {
          kind: 'redirect' as const,
          redirectTo: keepSearch(agentPath(locale, overview.page.account.handle), search),
        };
      return { kind: 'missing' as const };
    }
    const shown = overview ?? result;
    const profile = pageProfile(shown.page);
    if (profile?.movedTo)
      return {
        kind: 'redirect' as const,
        redirectTo: keepSearch(agentPath(locale, profile.movedTo, view), search),
      };
    if (
      view &&
      (!viewIsPublic(profile, view) || (view !== 'realms' && shown.page.views && !shown.page.views.includes(view)))
    )
      return {
        kind: 'redirect' as const,
        redirectTo: keepSearch(agentPath(locale, shown.page.account.handle), search),
      };
    // An absent/malformed public projection cannot opt into membership publication.
    if (view === 'realms' && !profile?.publicViews.realms)
      return {
        kind: 'redirect' as const,
        redirectTo: agentPath(locale, shown.page.account.handle),
      };
    const identities = profile?.operatorId ? await readPageAuthors(client, [profile.operatorId]) : null;
    const identity = profile?.operatorId ? identities?.[profile.operatorId] : undefined;
    const operator =
      identity && identity.state !== 'deleted'
        ? {
            id: identity.id,
            handle: typeof identity.handle === 'string' && identity.handle ? identity.handle : null,
            displayName: typeof identity.displayName === 'string' && identity.displayName ? identity.displayName : null,
          }
        : undefined;
    const page = compositionView && cursor ? await continueAgentList(client, result.page, cursor) : result.page;
    return {
      kind: 'page' as const,
      view: (view ?? 'overview') as AccountView,
      handle,
      page,
      overview: shown.page,
      ...(operator ? { operator } : {}),
      ...(cursor ? { cursor } : {}),
      ...(view === 'realms' && profile ? { realms: await readPublicRealms(client, profile, cursor) } : {}),
      publicRealms: profile?.publicViews.realms === true,
      tabs: subjectTabs(shown.page),
      title: agentTitle(shown.page),
    };
  } catch (error) {
    return { kind: 'state' as const, state: error instanceof AgentReadError ? error.state : ('unavailable' as const) };
  }
}
