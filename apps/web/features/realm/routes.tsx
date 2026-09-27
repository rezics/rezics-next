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
import { ZoneHome } from '../zones/zone-home.tsx';
import { zoneDecision, zoneText, zoneWork } from './adapt.ts';
import { loadModules } from './modules.ts';
import { readRealmDecision, readRealmDecisions, readRealmDirectory, readRealmWorks, resolveRealm } from './read.ts';
import { loadRealmView, membersText, RealmFrame, type RealmView } from './realm-page.tsx';
import { idOf, parseCursor, parseDecision, parseRealmRef, type RealmTab, realmHref } from './route.ts';
import { RealmUnavailable } from './states.tsx';
import type { ReadFailure } from './types.ts';
import { ListFailure, RealmAbout, RealmDecisions, RealmDiscussions, RealmWorks } from './views.tsx';

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

export function RealmHomeRoute(props: RealmRouteProps) {
  return realmRoute(props, 'home', async view => {
    const modules = await loadModules(view.presentation, view.context, view.bannerMedia);
    return <ZoneHome modules={modules} zone={view.zone} pkg={view.pkg} locale={view.context.locale}
      messages={view.zoneMessages} avatarQuery={view.reader.avatarQuery} empty={<EmptyState icon={LibraryBigIcon} title={view.messages.emptyHomeTitle}
        description={view.messages.emptyHomeBody}>
        <LocalizedLink href={view.zone.links.about} className={buttonVariants({ variant: 'outline' })}>
          {view.messages.seeAbout}</LocalizedLink>
      </EmptyState>} />;
  });
}

export function RealmWorksRoute(props: RealmRouteProps) {
  return realmRoute(props, 'works', async (view, locale, search) => {
    const cursor = parseCursor(search);
    const page = await readRealmWorks(view.context.realm, locale, cursor);
    if (!page.ok) return failure(view, 'works', page.failure);
    return <RealmWorks realmName={view.zone.name.value} locale={locale} messages={view.messages}
      zoneMessages={view.zoneMessages} avatarQuery={view.reader.avatarQuery} {...paging(view, 'works', cursor, page.data.nextCursor)}
      works={page.data.items.map(item => zoneWork(item, view.context, item.selection))} />;
  });
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

export function RealmDiscussionsRoute(props: RealmRouteProps) {
  return realmRoute(props, 'discussions', async (view, locale) => {
    const page = await readRealmWorks(view.context.realm, locale);
    if (!page.ok) return failure(view, 'discussions', page.failure);
    return <RealmDiscussions locale={locale} messages={view.messages} zoneMessages={view.zoneMessages}
      avatarQuery={view.reader.avatarQuery} works={page.data.items.map(item => zoneWork(item, view.context, item.selection))} />;
  });
}

export function RealmAboutRoute(props: RealmRouteProps) {
  return realmRoute(props, 'about', async (view, locale) => {
    const header = view.realm.header;
    const directory = await readRealmDirectory(locale);
    const others = (directory.ok ? directory.data.items : []).filter(item => item.id !== header.id).slice(0, 5)
      .flatMap(item => {
        const id = idOf(item.id);
        return id ? [{ href: realmHref(locale, id), name: zoneText(item.name),
          members: membersText(item.membership.count, locale, view.messages) }] : [];
      });
    return <RealmAbout realmName={view.zone.name.value} locale={locale} messages={view.messages}
      description={view.zone.description} members={membersText(header.membership.count, locale, view.messages)}
      others={others}
      moderators={header.moderators.kind === 'known' ? header.moderators.items.length : null}
      rules={header.rules?.map(rule => ({ id: rule.id, title: rule.title.value, body: rule.body.value,
        governed: rule.governanceRule !== null, lang: rule.title.language })) ?? null} />;
  });
}
