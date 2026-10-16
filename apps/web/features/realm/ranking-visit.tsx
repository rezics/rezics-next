import { LibraryBigIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { catalogs } from '../../i18n/catalogs.ts';
import { browserMainApi } from '../api/browser.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { sessionReadSubject, type MainSessionAgentState } from '../auth/session.ts';
import { spaceAccessApi } from '../manage/settings-api.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { placedModule, type PresentationModule } from '../zones/presentation.ts';
import { ZoneHome } from '../zones/zone-home.tsx';
import { DiscussionCollection, DiscussionFrame, realmPathOf } from './discussion-page.tsx';
import { discussionListHref, type DiscussionQuery } from './discussion-read.ts';
import { loadRankingsModule, rankingModuleReads } from './modules.ts';
import { loadRealmView, privateJoinPage, RealmFrame, type RealmReplay } from './realm-page.tsx';
import { RealmRankingBody } from './ranking-route.tsx';
import { RealmNotFound, RealmUnavailable } from './states.tsx';
import { realmHref } from './route.ts';

export const rankingChart: PresentationModule = { id: 'realm-ranking', type: 'ranking', title: '',
  source: { kind: 'query-block', block: 'realm-ranking' }, options: { layout: 'rows', metric: 'reads' } };

/** The supplied session is a transport; the shared page resolves its acting Person. */
export function rankingVisitHost(fetcher: typeof fetch, signedIn: boolean): RealmReplay {
  const origin = 'https://recorded.invalid';
  // The shared address reader uses Main paths; browser clients already use the BFF.
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === origin && url.pathname.startsWith('/v1/')) {
      url.pathname = `${BFF_PREFIX}${url.pathname}`;
      return fetcher(url, { ...init, headers: request.headers, method: request.method,
        signal: request.signal, credentials: 'omit' });
    }
    return fetcher(input, init);
  }) as typeof fetch;
  return { origin, signedIn, token: signedIn ? 'recorded' : undefined, fetch: send,
    personal: browserMainApi(origin, { fetcher: send }),
    read: (path, personal = false) => fetcher(new URL(`${BFF_PREFIX}${path}`, origin), {
      credentials: personal ? 'same-origin' : 'omit',
    }),
  };
}

/** A supplied transport reaches the route's real resolver, content and shared frame. */
export async function rankingVisit({ replay, ref, locale, query, module }: {
  replay: RealmReplay; ref: string; locale: UiLocale; query: DiscussionQuery; module?: PresentationModule;
}): Promise<ReactNode> {
  const view = await loadRealmView(ref, locale, {}, 'community', replay);
  if (view.kind === 'missing') return <RealmNotFound messages={await catalogs.realm[locale]()} />;
  if (view.kind === 'unavailable') return <RealmUnavailable messages={await catalogs.realm[locale]()}
    failure={view.failure} reference={view.reference} />;
  if (view.kind === 'join') {
    const state = replay.signedIn ? await replay.read('/v1/me/session-agent', true)
      .then(response => response.json() as Promise<MainSessionAgentState>) : null;
    const actingSubject = sessionReadSubject(state);
    return privateJoinPage(view.page, locale, realmHref(locale, ref, 'discussions'), { actingSubject,
      ...(actingSubject ? { api: spaceAccessApi(() => replay.personal, view.page.space, view.page.id, actingSubject) } : {}),
    });
  }
  const client = { main: browserMainApi(replay.origin, { anonymous: true, fetcher: replay.fetch }),
    personal: replay.personal, signedIn: view.reader.signedIn,
    actingSubject: view.reader.actingSubject ?? undefined, fetch: replay.fetch };
  if (module) {
    const state = await loadRankingsModule(module, view.context, rankingModuleReads(client));
    const body = <ZoneHome modules={[{ module: { ...placedModule(module, null), type: 'ranking' }, state }]}
      zone={view.zone} pkg={null} locale={locale} messages={view.zoneMessages} slotAccess={null}
      empty={<EmptyState icon={LibraryBigIcon} title={view.messages.emptyHomeTitle} description={view.messages.emptyHomeBody} />} />;
    return RealmFrame({ view, tab: 'home', locale, search: {}, children: body, client });
  }
  const feed = await catalogs.feed[locale]();
  const content = await RealmRankingBody({ main: view.reader.actingSubject ? client.personal : client.main, view, query, feed });
  return DiscussionFrame({ view, locale, feed, search: {}, here: discussionListHref(realmPathOf(view), query),
    children: <DiscussionCollection view={view}>{content}</DiscussionCollection>, client });
}
