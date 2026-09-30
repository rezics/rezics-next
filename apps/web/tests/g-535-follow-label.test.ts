import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FollowRealmButton } from '../features/feed/actions.tsx';
import { FeedProvider } from '../features/feed/feed-context.tsx';
import { memoryFeed, realms } from '../features/feed/fixtures.ts';
import { type FeedMessages, messages as feedEn } from '../features/feed/messages.ts';
import feedDe from '../features/feed/messages/de.ts';
import feedEs from '../features/feed/messages/es.ts';
import feedFr from '../features/feed/messages/fr.ts';
import feedJa from '../features/feed/messages/ja.ts';
import feedKo from '../features/feed/messages/ko.ts';
import feedZhHans from '../features/feed/messages/zh-Hans.ts';
import feedZhHant from '../features/feed/messages/zh-Hant.ts';
import { FollowButton } from '../features/home/follow-button.tsx';
import { messages as realmEn } from '../features/realm/messages.ts';
import realmDe from '../features/realm/messages/de.ts';
import realmEs from '../features/realm/messages/es.ts';
import realmFr from '../features/realm/messages/fr.ts';
import realmJa from '../features/realm/messages/ja.ts';
import realmKo from '../features/realm/messages/ko.ts';
import realmZhHans from '../features/realm/messages/zh-Hans.ts';
import realmZhHant from '../features/realm/messages/zh-Hant.ts';
import { type UiLocale, uiLocales } from '../i18n/define.ts';

const feed: Record<UiLocale, FeedMessages> = {
  en: feedEn,
  de: { ...feedEn, ...feedDe },
  es: { ...feedEn, ...feedEs },
  fr: { ...feedEn, ...feedFr },
  ja: { ...feedEn, ...feedJa },
  ko: { ...feedEn, ...feedKo },
  'zh-Hans': { ...feedEn, ...feedZhHans },
  'zh-Hant': { ...feedEn, ...feedZhHant },
};

/** The words a Realm's own membership control uses. Following must not reuse them. */
const membership: Record<UiLocale, { join: string; joined: string }> = {
  en: { join: realmEn.join, joined: realmEn.joined },
  de: { join: realmDe.join, joined: realmDe.joined },
  es: { join: realmEs.join, joined: realmEs.joined },
  fr: { join: realmFr.join, joined: realmFr.joined },
  ja: { join: realmJa.join, joined: realmJa.joined },
  ko: { join: realmKo.join, joined: realmKo.joined },
  'zh-Hans': { join: realmZhHans.join, joined: realmZhHans.joined },
  'zh-Hant': { join: realmZhHant.join, joined: realmZhHant.joined },
};

const realm = realms.kitchen;
const actingSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

function renderFollow(locale: UiLocale, signedIn: boolean, child: ReactNode = createElement(FollowRealmButton, { realm })) {
  return renderToStaticMarkup(createElement(FeedProvider, {
    locale, messages: feed[locale], now: 0, signedIn,
    actingSubject: signedIn ? actingSubject : null, signInHref: '/auth/start', avatarQuery: '', tab: 'all',
    followedRealms: signedIn ? [] : null, api: memoryFeed(), children: child,
  }));
}

test('G-535: the feed button that calls follow does not render membership', () => {
  for (const locale of uiLocales) {
    const t = materializeData(feed[locale], { locale });
    const words = membership[locale];
    for (const signedIn of [true, false]) {
      const html = renderFollow(locale, signedIn);
      expect(html, locale).toContain(t.follow);
      expect(html, locale).toContain(t.followRealm({ realm: realm.name.value }));
      expect(html.includes(words.join), `${locale} rendered “${words.join}”`).toBe(false);
      expect(html.includes(words.joined), `${locale} rendered “${words.joined}”`).toBe(false);
    }
  }
});

test('G-535: Home shows Following for a followed Realm, not membership', () => {
  const html = renderToStaticMarkup(createElement(FeedProvider, {
    locale: 'en', messages: feed.en, now: 0, signedIn: true, actingSubject, signInHref: '/auth/start',
    avatarQuery: '', tab: 'all', followedRealms: [realms.mods.id], api: memoryFeed(),
    children: createElement(FollowButton, {
      target: realms.mods.id, kind: 'realm', realm: realms.mods.id, label: 'Follow Stardew Mods',
      followLabel: 'Follow', followedLabel: 'Following', failedLabel: 'Couldn’t follow. Try again.',
    }),
  }));
  expect(html).toContain('Following');
  expect(html.includes('Joined')).toBe(false);
  expect(html.includes('Join')).toBe(false);
});
