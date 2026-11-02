import type { KernelClient } from '@rezics/client';
import type { View } from '@rezics/composition';
import {
  AgentReadError,
  agentPath,
  agentTitle,
  continueAgentList,
  formerHandleRedirect,
  loadAgentPage,
  pageProfile,
} from '../../features/pages/agent';
import { viewIsPublic } from '../../features/pages/account-read';
import { subjectTabs } from '../../features/pages/views';
import { readPageAuthors } from '../../identity/read';
import { keepSearch } from '../../subject/subject-href';
import { readPublicRealms } from './read';
import { OPERATOR_READ_MS, publicAccountRead } from './request';

export type AccountView = View | 'realms';

/** A different account view starts a different list; other query selections keep their original bytes. */
function overviewFallback(locale: string, handle: string, search = ''): string {
  const href = agentPath(locale, handle);
  if (!search) return href;
  const fragmentAt = search.indexOf('#');
  const query = fragmentAt < 0 ? search : search.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : search.slice(fragmentAt);
  const parameters = query.replace(/^\?/, '').split('&');
  const retained: string[] = [];
  for (const parameter of parameters) {
    // Decode names as URL query parameters, including escaped names and duplicate cursors.
    // Keep retained parameters verbatim so unrelated selections are not normalized.
    if (!new URLSearchParams(parameter).has('cursor')) retained.push(parameter);
  }
  return keepSearch(href, retained.join('&'), fragment);
}

export { pageProfile };

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
  signal?: AbortSignal,
) {
  const { handle, locale, cursor, search } = input;
  const view = input.view && input.view !== 'overview' ? input.view : undefined;
  const compositionView = view === 'realms' ? undefined : view;
  try {
    const [result, overview] = await publicAccountRead(
      client,
      (client) =>
        Promise.all([
          loadAgentPage(client, handle, compositionView, locale),
          compositionView ? loadAgentPage(client, handle, undefined, locale) : undefined,
        ]),
      signal,
    );
    if (result.kind === 'missing' || overview?.kind === 'missing') {
      const moved = await publicAccountRead(
        client,
        (client) => formerHandleRedirect(client, handle, locale, view, search),
        signal,
      );
      if (moved) return { kind: 'redirect' as const, redirectTo: moved.href };
      if (view && overview?.kind === 'page')
        return {
          kind: 'redirect' as const,
          redirectTo: overviewFallback(locale, overview.page.account.handle, search),
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
        redirectTo: overviewFallback(locale, shown.page.account.handle, search),
      };
    // An absent/malformed public projection cannot opt into membership publication.
    if (view === 'realms' && !profile?.publicViews.realms)
      return {
        kind: 'redirect' as const,
        redirectTo: overviewFallback(locale, shown.page.account.handle, search),
      };
    const operatorId = profile?.operatorId;
    const identities = operatorId
      ? await publicAccountRead(
          client,
          (client) => readPageAuthors(client, [operatorId]),
          signal,
          OPERATOR_READ_MS,
        ).catch(() => null)
      : null;
    const identity = profile?.operatorId ? identities?.[profile.operatorId] : undefined;
    const operator =
      identity && identity.state !== 'deleted'
        ? {
            id: identity.id,
            handle: typeof identity.handle === 'string' && identity.handle ? identity.handle : null,
            displayName: typeof identity.displayName === 'string' && identity.displayName ? identity.displayName : null,
          }
        : undefined;
    const page =
      compositionView && cursor
        ? await publicAccountRead(client, (client) => continueAgentList(client, result.page, cursor), signal)
        : result.page;
    signal?.throwIfAborted();
    return {
      kind: 'page' as const,
      view: (view ?? 'overview') as AccountView,
      handle,
      page,
      overview: shown.page,
      ...(operator ? { operator } : {}),
      ...(cursor ? { cursor } : {}),
      ...(view === 'realms' && profile ? { realms: await readPublicRealms(client, profile, cursor, signal) } : {}),
      publicRealms: profile?.publicViews.realms === true,
      tabs: subjectTabs(shown.page),
      title: agentTitle(shown.page),
    };
  } catch (error) {
    return { kind: 'state' as const, state: error instanceof AgentReadError ? error.state : ('unavailable' as const) };
  }
}
