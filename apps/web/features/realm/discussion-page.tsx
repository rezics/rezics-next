import { materializeData } from 'native-i18n';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isUiLocale, type UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { signInPath } from '../auth/paths.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import type { FeedMessages } from '../feed/messages.ts';
import type { ReplyMode } from '../feed/reply-composer.tsx';
import { offerOf } from './membership-state.ts';
import {
  loadRealmView,
  membersText,
  privateJoinPage,
  RealmFrame,
  type RealmView,
} from './realm-page.tsx';
import { spaceHref } from '../address/path.ts';
import { realmHref } from './route.ts';
import { RealmUnavailable } from './states.tsx';
import { DiscussionColumns, ThreadRail } from './thread-rail.tsx';

// What a Realm's Discussions tab and its thread pages share: the Realm frame
// with the Discussions tab current, a community rail beside the posts, and
// the feed's environment so votes, replies and cards act as the reader.

export type Search = Record<string, string | string[] | undefined>;

/**
 * The Realm view for `/r/{ref}/discussions…`, or the response that replaces
 * the page: a Realm UUID with an official Zone moves to the Zone's address.
 */
export async function discussionView(
  locale: string,
  ref: string,
  search: Search,
  rest = '',
): Promise<{ view: RealmView; locale: UiLocale; feed: FeedMessages } | { page: ReactNode }> {
  if (!isUiLocale(locale)) notFound();
  const [view, feed] = await Promise.all([
    loadRealmView(ref, locale, search),
    getMessages('feed', locale),
  ]);
  if (view.kind === 'missing') notFound();
  if (view.kind === 'unavailable')
    return { page: <RealmUnavailable messages={await getMessages('realm', locale)} /> };
  if (view.kind === 'join')
    return {
      page: await privateJoinPage(
        view.page,
        locale,
        `${realmHref(locale, ref, 'discussions')}${rest}`,
      ),
    };
  return { view, locale, feed };
}

/** Main as the reader: their token when they act as an Agent, so their votes and private Realms come back. */
export async function readerMain(view: RealmView) {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return mainApiWithToken(view.reader.actingSubject ? token : undefined);
}

/**
 * Whether the reader can reply here now. Main places a reply at once for
 * members of a Realm that trusts them, or anyone in an open one; a Realm that
 * reviews every reply has no reply queue yet.
 */
export function replyModeOf(view: RealmView): ReplyMode {
  if (!view.reader.signedIn) return 'sign-in';
  if (!view.reader.actingSubject) return 'unavailable';
  const { reviewMode } = view.realm.header;
  if (reviewMode === 'mandatory') return 'reviewed';
  if (
    reviewMode === 'trusted-members' &&
    (!view.membership || offerOf(view.membership) !== 'joined')
  )
    return 'join';
  return 'open';
}

/** The unlocalized `/r/{ref}` the feed's links build on. */
export const realmPathOf = (view: RealmView) => spaceHref(view.realm.ref, 'community');

/** The Realm frame around a discussion page: the posts, and the community rail beside them. */
export async function DiscussionFrame({
  view,
  locale,
  feed,
  search,
  here,
  children,
}: {
  view: RealmView;
  locale: UiLocale;
  feed: FeedMessages;
  search: Search;
  /** This page's own address, where signing in returns. */
  here: string;
  children: ReactNode;
}) {
  const t = materializeData(feed, { locale });
  const { header } = view.realm;
  const segments = view.realm.zone?.segment ? { [header.id]: view.realm.zone.segment } : {};
  return (
    <RealmFrame view={view} tab="discussions" locale={locale} search={search}>
      <FeedProvider
        locale={locale}
        messages={feed}
        now={Date.now()}
        signedIn={view.reader.signedIn}
        actingSubject={view.reader.actingSubject}
        signInHref={signInPath(localizedPath(here, locale))}
        avatarQuery={view.reader.avatarQuery}
        tab="all"
        followedRealms={null}
        realmSegments={segments}
      >
        <DiscussionColumns
          rail={
            <ThreadRail
              name={{ value: view.zone.name.value, lang: view.zone.name.lang }}
              description={
                view.zone.description
                  ? { value: view.zone.description.value, lang: view.zone.description.lang }
                  : null
              }
              members={membersText(header.membership.count, locale, view.messages)}
              aboutHref={realmHref(locale, view.realm.ref, 'about')}
              rules={
                header.rules?.map((rule) => ({
                  id: rule.id,
                  title: rule.title.value,
                  body: rule.body.value,
                  lang: rule.title.language,
                })) ?? []
              }
              labels={{
                about: t.aboutCommunity,
                rules: t.communityRules,
                more: t.moreAboutCommunity,
              }}
            />
          }
        >
          {children}
        </DiscussionColumns>
      </FeedProvider>
    </RealmFrame>
  );
}
