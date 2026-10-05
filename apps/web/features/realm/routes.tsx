import { buttonVariants } from '@rezics/ui/button';
import { LibraryBigIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isUiLocale, type UiLocale } from '../../i18n/define.ts';
import { getMessages, getTranslation } from '../../i18n/server.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { ZoneBrowse } from '../zones/browse.tsx';
import {
  type BrowseFacet,
  browseFacets,
  mainBrowseQuery,
  parseBrowseState,
} from '../zones/browse-state.ts';
import { browseEntry, browseModel, type FacetCounts } from '../zones/browse-view.ts';
import { ZoneSiteHome } from '../zones/site-home.tsx';
import { cardRenderer, ZoneHome } from '../zones/zone-home.tsx';
import { ReleaseBrowse, ReleaseBrowseHeader } from '../release-filter/browse.tsx';
import { readReleaseBrowse } from '../release-filter/read.ts';
import { resolveReleaseFilter } from '../release-filter/registry.ts';
import {
  noReleaseFilter,
  parseReleaseFilter,
  releaseFilterActive,
} from '../release-filter/state.ts';
import { zoneDecision, zoneText, zoneWork } from './adapt.ts';
import { loadModules } from './modules.ts';
import {
  readAgent,
  readFacets,
  readRealmDecision,
  readRealmDecisions,
  readRealmDirectory,
  readRealmWorks,
  readRoster,
  readZoneBrowse,
  resolveRealm,
} from './read.ts';
import type { ZoneBrowsePage } from './types.ts';
import {
  loadRealmView,
  membersText,
  privateJoinPage,
  RealmFrame,
  type RealmView,
} from './realm-page.tsx';
import { spaceHref, resourceHref } from '../address/path.ts';
import { realmDiscovery } from '../address/space-read.ts';
import { pageUrl, representationPath } from '../seo/address.ts';
import { idOf, parseCursor, parseDecision, type RealmTab, realmHref, siteHref } from './route.ts';
import { RealmDiscussionsRoute } from './discussions-route.tsx';
import { RealmUnavailable } from './states.tsx';
import type { ReadFailure } from './types.ts';
import { type AboutPerson, ListFailure, Pager, RealmAbout, RealmDecisions } from './views.tsx';
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

type CommunityPage = RealmTab | 'rules' | 'members';

export async function realmMetadata(
  { params }: Pick<RealmRouteProps, 'params'>,
  tab: CommunityPage,
): Promise<Metadata> {
  const { locale, realm } = await params;
  if (!isUiLocale(locale)) return {};
  const [resolved, { t }] = await Promise.all([
    resolveRealm(realm, locale),
    getTranslation('realm', [locale]),
  ]);
  if (resolved.kind === 'join')
    return { title: resolved.page.name.value, robots: { index: false }, referrer: 'no-referrer' };
  if (resolved.kind !== 'realm')
    return {
      title: resolved.kind === 'missing' ? t.notFoundTitle : t.unavailableTitle,
      robots: { index: false },
    };
  const name = resolved.header.name.value;
  const discovery = realmDiscovery(resolved.header);
  const page = await pageUrl();
  return {
    title:
      tab === 'home'
        ? name
        : `${tab === 'rules' ? t.rules : tab === 'members' ? t.membersTitle : t[tab]} · ${name}`,
    description: resolved.header.description?.value,
    ...(discovery ? { robots: { index: discovery.indexable } } : {}),
    ...(discovery?.referrerPolicy ? { referrer: discovery.referrerPolicy } : {}),
    ...(page ? { alternates: { canonical: page.origin + representationPath(page) } } : {}),
  };
}

type Content = (view: RealmView, locale: UiLocale, search: Search) => Promise<ReactNode>;

async function realmRoute(
  { params, searchParams }: RealmRouteProps,
  tab: CommunityPage,
  content: Content,
  site = false,
) {
  const [{ locale, realm }, search] = await Promise.all([params, searchParams]);
  if (!isUiLocale(locale)) notFound();
  const view = await loadRealmView(realm, locale, search, site ? 'site' : 'community');
  if (view.kind === 'missing') notFound();
  if (view.kind === 'unavailable')
    return <RealmUnavailable messages={await getMessages('realm', locale)} />;
  if (view.kind === 'join')
    return privateJoinPage(
      view.page,
      locale,
      site ? siteHref(locale, realm, tab === 'home' ? [] : [tab]) : realmHref(locale, realm, tab),
    );
  return (
    <RealmFrame
      view={view}
      tab={site ? null : tab === 'rules' || tab === 'members' ? 'about' : tab}
      locale={locale}
      search={search}
      address={site ? siteHref(locale, view.context.ref, tab === 'home' ? [] : [tab]) : undefined}
    >
      {await content(view, locale, search)}
    </RealmFrame>
  );
}

/** Cursor links for a paged tab: the next page, and the first page once past it. */
function paging(
  view: RealmView,
  tab: CommunityPage,
  cursor: string | undefined,
  next: string | null,
) {
  const { locale, ref } = view.context;
  return {
    next: next ? realmHref(locale, ref, tab, { cursor: next }) : null,
    first: cursor ? realmHref(locale, ref, tab) : null,
  };
}

function failure(view: RealmView, tab: CommunityPage, reason: ReadFailure) {
  return (
    <PageContainer>
      <ListFailure
        failure={reason}
        messages={view.messages}
        firstPage={realmHref(view.context.locale, view.context.ref, tab)}
      />
    </PageContainer>
  );
}

/** Main's value counts per Facet, with Concept names as the SDK's text. */
function facetCounts(page: ZoneBrowsePage): FacetCounts {
  const counts = {} as Record<BrowseFacet, FacetCounts[BrowseFacet]>;
  for (const facet of browseFacets) {
    counts[facet] = page.facets[facet].map((item) => ({
      value: item.value,
      count: item.count,
      name: item.name ? zoneText(item.name) : null,
    }));
  }
  return counts;
}

export function RealmHomeRoute(props: RealmRouteProps) {
  return RealmDiscussionsRoute(props);
}

export function SiteHomeRoute(props: RealmRouteProps) {
  return realmRoute(
    props,
    'home',
    async (view, _locale, search) => {
      // A package that sets out the Zone's home itself (a wiki's lists at the reader's position) replaces the modules.
      if (view.pkg?.slots.home) return <ZoneSiteHome view={view} search={search} />;
      const { locale, realm } = view.context;
      // The home leads with search and the values a browse page filters by; its counts come from one browse read.
      const [modules, window] = await Promise.all([
        loadModules(view.presentation, view.context, view.slideMedia),
        readZoneBrowse(realm, locale, { limit: 1 }),
      ]);
      const browse = browseEntry({
        base: view.zone.links.browse,
        zoneName: view.zone.name.value,
        counts: window.ok ? facetCounts(window.data) : null,
        locale,
        messages: view.zoneMessages,
      });
      return (
        <div className="grid gap-6">
          {view.reader.actingSubject ? (
            <CommunitySetupChecklist
              realm={view.realm.realm}
              actor={view.reader.actingSubject}
              path={spaceHref(view.context.ref, 'community')}
              locale={view.context.locale}
              rules={Boolean(view.realm.header.rules?.length)}
              icon={view.realm.header.icon.kind === 'image'}
              banner={view.realm.header.banner?.kind === 'image'}
            />
          ) : null}
          <ZoneHome
            modules={modules}
            zone={view.zone}
            pkg={view.pkg}
            locale={view.context.locale}
            browse={browse}
            messages={view.zoneMessages}
            avatarQuery={view.reader.avatarQuery}
            empty={
              <EmptyState
                icon={LibraryBigIcon}
                title={view.messages.emptyHomeTitle}
                description={view.messages.emptyHomeBody}
              >
                <LocalizedLink
                  href={view.zone.links.about}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {view.messages.seeAbout}
                </LocalizedLink>
              </EmptyState>
            }
          />
        </div>
      );
    },
    true,
  );
}

/**
 * A Zone's browse page: its newest picks filtered by the Facets Main reads
 * for them and sorted as the reader chose, in a list or a grid. A Zone whose package offers a
 * release filter (`releaseFilter`) leads with it; once a condition is chosen the results are the
 * Works Main finds with one release meeting every condition, each saying which release matched.
 */
export function RealmBrowseRoute(props: RealmRouteProps) {
  return realmRoute(
    props,
    'browse',
    async (view, locale, search) => {
      const base = view.zone.links.browse;
      const card = cardRenderer(
        view.zone,
        view.pkg,
        locale,
        view.zoneMessages,
        view.reader.avatarQuery,
      );
      const spec = view.pkg?.releaseFilter?.(locale) ?? null;
      // The registry names the release facets and the values they admit; a Zone's spec only adds its words.
      const served = spec ? await readFacets() : null;
      const release =
        spec && served?.ok ? resolveReleaseFilter(spec, served.data.facets, locale) : null;
      const releaseState = release ? parseReleaseFilter(search, release) : noReleaseFilter;
      const header =
        spec && release ? (
          <ReleaseBrowseHeader
            zone={view.zone}
            pkg={view.pkg}
            spec={spec}
            filter={release}
            state={releaseState}
            base={base}
          />
        ) : null;
      if (spec && release && releaseFilterActive(releaseState)) {
        const found = await readReleaseBrowse(
          view.context.realm,
          locale,
          releaseState,
          release,
          view.context,
          spec,
        );
        if (!found.ok)
          return (
            <>
              <PageContainer className="py-0 sm:py-0 lg:py-0">{header}</PageContainer>
              {failure(
                view,
                'browse',
                found.failure === 'sign-in' || found.failure === 'identity'
                  ? 'unavailable'
                  : found.failure,
              )}
            </>
          );
        return (
          <ReleaseBrowse
            header={header}
            spec={spec}
            filter={release}
            state={releaseState}
            base={base}
            items={found.data.items}
            next={found.data.next}
            card={card}
            messages={view.zoneMessages}
            locale={locale}
            firstPage={view.messages.firstPage}
          />
        );
      }
      const state = parseBrowseState(search);
      const [page, facets] = await Promise.all([
        readZoneBrowse(view.context.realm, locale, mainBrowseQuery(state)),
        readFacets(),
      ]);
      if (!page.ok) return failure(view, 'browse', page.failure);
      const admitted = new Map(
        (facets.ok ? facets.data.facets : [])
          .filter((facet) => facet.current)
          .map((facet) => [facet.name, facet.labels[locale]] as const),
      );
      const model = browseModel({
        base,
        zoneName: view.zone.name.value,
        state,
        admitted,
        locale,
        messages: view.zoneMessages,
        page: {
          ...page.data,
          facets: facetCounts(page.data),
          sort: page.data.query.sort,
          items: page.data.items.map((item) => zoneWork(item, view.context, item.evidence)),
        },
      });
      return (
        <>
          {header ? <PageContainer className="pb-0 sm:pb-0 lg:pb-0">{header}</PageContainer> : null}
          <ZoneBrowse model={model} messages={view.zoneMessages} card={card} />
        </>
      );
    },
    true,
  );
}

export function RealmDecisionsRoute(props: RealmRouteProps) {
  return realmRoute(props, 'decisions', async (view, locale, search) => {
    const decision = parseDecision(search);
    const works = await readRealmWorks(view.context.realm, locale);
    const titled = new Map(
      (works.ok ? works.data.items : []).map((item) => [
        item.id,
        zoneWork(item, view.context, null),
      ]),
    );
    if (decision) {
      const exact = await readRealmDecision(view.context.realm, decision);
      if (!exact.ok) return failure(view, 'decisions', exact.failure);
      return (
        <RealmDecisions
          locale={locale}
          messages={view.messages}
          zoneMessages={view.zoneMessages}
          first={realmHref(locale, view.context.ref, 'decisions')}
          next={null}
          decisions={[zoneDecision(exact.data, view.context, titled)]}
        />
      );
    }
    const cursor = parseCursor(search);
    const page = await readRealmDecisions(view.context.realm, cursor);
    if (!page.ok) return failure(view, 'decisions', page.failure);
    return (
      <RealmDecisions
        locale={locale}
        messages={view.messages}
        zoneMessages={view.zoneMessages}
        {...paging(view, 'decisions', cursor, page.data.nextCursor)}
        decisions={page.data.items.map((item) => zoneDecision(item, view.context, titled))}
      />
    );
  });
}

export function RealmAboutRoute(props: RealmRouteProps) {
  return realmRoute(props, 'about', async (view, locale) => {
    const header = view.realm.header;
    const [directory, roster, moderators] = await Promise.all([
      readRealmDirectory(locale),
      readRoster(view.context.realm),
      header.moderators.kind === 'known'
        ? Promise.all(
            header.moderators.items.flatMap((agent) => {
              const id = idOf(agent);
              return id ? [readAgent(id)] : [];
            }),
          )
        : null,
    ]);
    const person = (agent: {
      id: string;
      displayName: string;
      handle: string | null;
      kind: AboutPerson['kind'];
      avatarUrl: string | null;
    }): AboutPerson => ({
      id: agent.id,
      name: agent.displayName,
      href: profileHref(agent),
      kind: agent.kind,
      avatarUrl: agent.avatarUrl,
    });
    const others = (directory.ok ? directory.data.items : [])
      .filter((item) => item.id !== header.id)
      .slice(0, 5)
      .flatMap((item) => {
        const id = idOf(item.id);
        return id
          ? [
              {
                href: realmHref(
                  locale,
                  'address' in item
                    ? (item.address as import('../address/path.ts').AddressTarget)
                    : item.space,
                ),
                name: zoneText(item.name),
                members: membersText(item.membership.count, locale, view.messages),
              },
            ]
          : [];
      });
    return (
      <RealmAbout
        realmName={view.zone.name.value}
        locale={locale}
        messages={view.messages}
        description={view.zone.description}
        members={membersText(header.membership.count, locale, view.messages)}
        others={others}
        moderators={moderators?.flatMap((read) => (read.ok ? [person(read.data)] : [])) ?? null}
        listed={
          roster.ok
            ? {
                more: roster.data.nextCursor !== null,
                people: [...roster.data.items]
                  .sort((a, b) => Number(b.featured) - Number(a.featured))
                  .flatMap((item) =>
                    item.displayName
                      ? [
                          {
                            id: item.agent,
                            name: item.displayName,
                            href: null,
                            kind: 'person' as const,
                            avatarUrl: null,
                            featured: item.featured,
                          },
                        ]
                      : [],
                  ),
              }
            : null
        }
        rules={
          header.rules?.map((rule) => ({
            id: rule.id,
            title: rule.title.value,
            body: rule.body.value,
            governed: rule.governanceRule !== null,
            lang: rule.title.language,
          })) ?? null
        }
      />
    );
  });
}

export function RealmRulesRoute(props: RealmRouteProps) {
  return realmRoute(props, 'rules', async (view, locale) => (
    <RealmAbout
      only="rules"
      realmName={view.zone.name.value}
      description={null}
      moderators={null}
      members={null}
      listed={null}
      others={[]}
      locale={locale}
      messages={view.messages}
      rules={
        view.realm.header.rules?.map((rule) => ({
          id: rule.id,
          title: rule.title.value,
          body: rule.body.value,
          governed: rule.governanceRule !== null,
          lang: rule.title.language,
        })) ?? null
      }
    />
  ));
}

export function RealmMembersRoute(props: RealmRouteProps) {
  return realmRoute(props, 'members', async (view, locale, search) => {
    const cursor = parseCursor(search);
    const roster = await readRoster(view.context.realm, cursor);
    if (!roster.ok) return failure(view, 'members', roster.failure);
    const people = roster.data.items.flatMap((item) =>
      item.displayName
        ? [
            {
              id: item.agent,
              name: item.displayName,
              href: resourceHref('/a/', item.agent),
              kind: 'person' as const,
              avatarUrl: null,
              featured: item.featured,
            },
          ]
        : [],
    );
    return (
      <RealmAbout
        only="members"
        realmName={view.zone.name.value}
        description={null}
        moderators={null}
        members={membersText(view.realm.header.membership.count, locale, view.messages)}
        rules={null}
        others={[]}
        listed={{ people, more: roster.data.nextCursor !== null }}
        locale={locale}
        messages={view.messages}
      >
        <Pager
          {...paging(view, 'members', cursor, roster.data.nextCursor)}
          messages={view.messages}
        />
      </RealmAbout>
    );
  });
}
