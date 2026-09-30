import { buttonVariants } from '@rezics/ui/button';
import { LibraryBigIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { isUiLocale, type UiLocale } from '../../i18n/define.ts';
import { getMessages, getTranslation } from '../../i18n/server.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { ZoneBrowse } from '../zones/browse.tsx';
import { type BrowseFacet, browseFacets, mainBrowseQuery, parseBrowseState } from '../zones/browse-state.ts';
import { browseEntry, browseModel, type FacetCounts } from '../zones/browse-view.ts';
import { cardRenderer, ZoneHome } from '../zones/zone-home.tsx';
import { zoneDecision, zoneText, zoneWork } from './adapt.ts';
import { loadModules } from './modules.ts';
import { readAgent, readFacets, readRealmDecision, readRealmDecisions, readRealmDirectory, readRealmWorks, readRoster,
  readZoneBrowse, resolveRealm } from './read.ts';
import type { ZoneBrowsePage } from './types.ts';
import { loadRealmView, membersText, RealmFrame, type RealmView } from './realm-page.tsx';
import { idOf, parseCursor, parseDecision, parseRealmRef, type RealmTab, realmHref } from './route.ts';
import { RealmUnavailable } from './states.tsx';
import type { ReadFailure } from './types.ts';
import { type AboutPerson, ListFailure, RealmAbout, RealmDecisions } from './views.tsx';
import { profileHref } from '../profile/route.ts';
import { CommunitySetupChecklist } from '../communities/setup-checklist.tsx';

// The `/r/{realm}` routes are thin: each resolves the Realm view, renders the
// Zone frame and its tab's content. Tabs render the frame themselves (not a
// layout) because safe mode comes from the query, which layouts do not receive.

type Search = Record<string, string | string[] | undefined>;
export interface RealmRouteProps {
  params: Promise<{ locale: string; realm: string }>;
  searchParams: Promise<Search>;
}

export async function realmMetadata({ params }: Pick<RealmRouteProps, 'params'>, tab: RealmTab): Promise<Metadata> {
  const { locale, realm } = await params;
  if (!isUiLocale(locale)) return {};
  const [resolved, { t }] = await Promise.all([resolveRealm(realm, locale), getTranslation('realm', [locale])]);
  if (resolved.kind !== 'realm') return { title: resolved.kind === 'missing' ? t.notFoundTitle : t.unavailableTitle };
  const name = resolved.header.name.value;
  return { title: tab === 'home' ? name : `${t[tab]} · ${name}`,
    description: resolved.header.description?.value };
}

type Content = (view: RealmView, locale: UiLocale, search: Search) => Promise<ReactNode>;

async function realmRoute({ params, searchParams }: RealmRouteProps, tab: RealmTab, content: Content) {
  const [{ locale, realm }, search] = await Promise.all([params, searchParams]);
  if (!isUiLocale(locale)) notFound();
  if (parseRealmRef(realm)?.kind === 'id') {
    const resolved = await resolveRealm(realm, locale);
    if (resolved.kind === 'realm' && resolved.zone?.segment) {
      const query = Object.fromEntries(Object.entries(search).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'));
      redirect(realmHref(locale, resolved.zone.segment, tab, query));
    }
  }
  const view = await loadRealmView(realm, locale, search);
  if (view.kind === 'missing') notFound();
  if (view.kind === 'unavailable') return <RealmUnavailable messages={await getMessages('realm', locale)} />;
  return <RealmFrame view={view} tab={tab} locale={locale} search={search}>{await content(view, locale, search)}
  </RealmFrame>;
}

/** Cursor links for a paged tab: the next page, and the first page once past it. */
function paging(view: RealmView, tab: RealmTab, cursor: string | undefined, next: string | null) {
  const { locale, ref } = view.context;
  return { next: next ? realmHref(locale, ref, tab, { cursor: next }) : null,
    first: cursor ? realmHref(locale, ref, tab) : null };
}

function failure(view: RealmView, tab: RealmTab, reason: ReadFailure) {
  return <PageContainer><ListFailure failure={reason} messages={view.messages}
    firstPage={realmHref(view.context.locale, view.context.ref, tab)} /></PageContainer>;
}

/** Main's value counts per Facet, with Concept names as the SDK's text. */
function facetCounts(page: ZoneBrowsePage): FacetCounts {
  const counts = {} as Record<BrowseFacet, FacetCounts[BrowseFacet]>;
  for (const facet of browseFacets) {
    counts[facet] = page.facets[facet].map(item => ({ value: item.value, count: item.count,
      name: item.name ? zoneText(item.name) : null }));
  }
  return counts;
}

export function RealmHomeRoute(props: RealmRouteProps) {
  return realmRoute(props, 'home', async view => {
    const { locale, realm } = view.context;
    // The home leads with search and the values a browse page filters by; its counts come from one browse read.
    const [modules, window] = await Promise.all([loadModules(view.presentation, view.context, view.bannerMedia),
      readZoneBrowse(realm, locale, { limit: 1 })]);
    const browse = browseEntry({ base: view.zone.links.browse, zoneName: view.zone.name.value,
      counts: window.ok ? facetCounts(window.data) : null, locale, messages: view.zoneMessages });
    return <div className="grid gap-6">
      {view.reader.actingSubject ? <CommunitySetupChecklist realm={view.realm.realm}
        actor={view.reader.actingSubject} path={`/r/${view.context.ref}`} locale={view.context.locale}
        rules={Boolean(view.realm.header.rules?.length)} icon={view.realm.header.icon.kind === 'image'}
        banner={view.realm.header.banner?.kind === 'image'} /> : null}
      <ZoneHome modules={modules} zone={view.zone} pkg={view.pkg} locale={view.context.locale} browse={browse}
      messages={view.zoneMessages} avatarQuery={view.reader.avatarQuery} empty={<EmptyState icon={LibraryBigIcon} title={view.messages.emptyHomeTitle}
        description={view.messages.emptyHomeBody}>
        <LocalizedLink href={view.zone.links.about} className={buttonVariants({ variant: 'outline' })}>
          {view.messages.seeAbout}</LocalizedLink>
      </EmptyState>} /></div>;
  });
}

/**
 * A Zone's browse page: its newest picks filtered by the Facets Main reads
 * for them and sorted as the reader chose, in a list or a grid.
 */
export function RealmBrowseRoute(props: RealmRouteProps) {
  return realmRoute(props, 'browse', async (view, locale, search) => {
    const state = parseBrowseState(search);
    const [page, facets] = await Promise.all([readZoneBrowse(view.context.realm, locale, mainBrowseQuery(state)),
      readFacets()]);
    if (!page.ok) return failure(view, 'browse', page.failure);
    const admitted = new Map((facets.ok ? facets.data.facets : []).filter(facet => facet.current)
      .map(facet => [facet.name, facet.labels[locale]] as const));
    const model = browseModel({ base: view.zone.links.browse, zoneName: view.zone.name.value, state, admitted, locale,
      messages: view.zoneMessages, page: { ...page.data, facets: facetCounts(page.data), sort: page.data.query.sort,
        items: page.data.items.map(item => zoneWork(item, view.context, item.evidence)) } });
    return <ZoneBrowse model={model} messages={view.zoneMessages}
      card={cardRenderer(view.zone, view.pkg, locale, view.zoneMessages, view.reader.avatarQuery)} />;
  });
}

/** The former Works tab: every adopted Work, newest first, is Browse's grid. */
export async function RealmWorksRoute({ params }: RealmRouteProps) {
  const { locale, realm } = await params;
  if (!isUiLocale(locale)) notFound();
  redirect(realmHref(locale, realm, 'browse', { view: 'grid' }));
}

export function RealmDecisionsRoute(props: RealmRouteProps) {
  return realmRoute(props, 'decisions', async (view, locale, search) => {
    const decision = parseDecision(search);
    const works = await readRealmWorks(view.context.realm, locale);
    const titled = new Map((works.ok ? works.data.items : []).map(item => [item.id,
      zoneWork(item, view.context, null)]));
    if (decision) {
      const exact = await readRealmDecision(view.context.realm, decision);
      if (!exact.ok) return failure(view, 'decisions', exact.failure);
      return <RealmDecisions locale={locale} messages={view.messages} zoneMessages={view.zoneMessages}
        first={realmHref(locale, view.context.ref, 'decisions')} next={null}
        decisions={[zoneDecision(exact.data, view.context, titled)]} />;
    }
    const cursor = parseCursor(search);
    const page = await readRealmDecisions(view.context.realm, cursor);
    if (!page.ok) return failure(view, 'decisions', page.failure);
    return <RealmDecisions locale={locale} messages={view.messages} zoneMessages={view.zoneMessages}
      {...paging(view, 'decisions', cursor, page.data.nextCursor)}
      decisions={page.data.items.map(item => zoneDecision(item, view.context, titled))} />;
  });
}

export function RealmAboutRoute(props: RealmRouteProps) {
  return realmRoute(props, 'about', async (view, locale) => {
    const header = view.realm.header;
    const [directory, roster, moderators] = await Promise.all([readRealmDirectory(locale), readRoster(view.context.realm),
      header.moderators.kind === 'known' ? Promise.all(header.moderators.items.flatMap(agent => {
        const id = idOf(agent);
        return id ? [readAgent(id)] : [];
      })) : null]);
    const person = (agent: { id: string; displayName: string; handle: string; kind: AboutPerson['kind'];
      avatarUrl: string | null }): AboutPerson => ({ id: agent.id, name: agent.displayName,
      href: profileHref(agent.handle), kind: agent.kind, avatarUrl: agent.avatarUrl });
    const others = (directory.ok ? directory.data.items : []).filter(item => item.id !== header.id).slice(0, 5)
      .flatMap(item => {
        const id = idOf(item.id);
        return id ? [{ href: realmHref(locale, id), name: zoneText(item.name),
          members: membersText(item.membership.count, locale, view.messages) }] : [];
      });
    return <RealmAbout realmName={view.zone.name.value} locale={locale} messages={view.messages}
      description={view.zone.description} members={membersText(header.membership.count, locale, view.messages)}
      others={others}
      moderators={moderators?.flatMap(read => read.ok ? [person(read.data)] : []) ?? null}
      listed={roster.ok ? { more: roster.data.nextCursor !== null, people: [...roster.data.items]
        .sort((a, b) => Number(b.featured) - Number(a.featured)).flatMap(item => item.displayName
          ? [{ id: item.agent, name: item.displayName, href: null, kind: 'person' as const, avatarUrl: null,
            featured: item.featured }] : []) } : null}
      rules={header.rules?.map(rule => ({ id: rule.id, title: rule.title.value, body: rule.body.value,
        governed: rule.governanceRule !== null, lang: rule.title.language })) ?? null} />;
  });
}
