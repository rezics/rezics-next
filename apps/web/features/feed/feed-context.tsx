'use client';

import { materializeData } from 'native-i18n';
import { createContext, type ReactNode, use, useCallback, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type FeedApi, mainFeedApi } from './api.ts';
import type { FeedMessages } from './messages.ts';
import type { FeedTab } from './state.ts';

interface FeedEnvironment {
  locale: UiLocale;
  messages: FeedMessages;
  /** The server render's clock, so relative times print the same on both sides. */
  now: number;
  signedIn: boolean;
  /** The Agent the reader acts as; null signed out or while none is selected. */
  actingSubject: string | null;
  /** Sign-in that returns to this page. */
  signInHref: string;
  avatarQuery: string;
  /** The view the posts belong to: reasons are only worth showing where they are exceptions. */
  tab: FeedTab;
  /**
   * The Realms the reader follows, when the whole list is known; null when it
   * is not (signed out, or more follows than one read returns), so no Join
   * button can claim a Realm is not followed when it may be.
   */
  followedRealms: readonly string[] | null;
  /** Official Zones' route segments by Realm, so a Realm links as `/r/fiction` where it has one. */
  realmSegments?: Readonly<Record<string, string>>;
  /** Stories pass an in-memory Main; the app talks to Main through the BFF. */
  api?: FeedApi;
}

interface FeedValue extends Omit<FeedEnvironment, 'messages' | 'api' | 'followedRealms' | 'realmSegments'> {
  t: ReturnType<typeof materializeData<FeedMessages>>;
  api: () => FeedApi;
  /** A Realm's page, by its Zone's segment when it has one. */
  realmPath: (realm: string) => string;
  /** 'joined', 'join', or 'unknown' when the follow list is incomplete. */
  realmState: (realm: string) => 'joined' | 'join' | 'unknown';
  markJoined: (realm: string, joined: boolean) => void;
}

const FeedContext = createContext<FeedValue | null>(null);

export function useFeed(): FeedValue {
  const value = use(FeedContext);
  if (!value) throw new Error('useFeed must be used inside <FeedProvider>');
  return value;
}

export function FeedProvider({ children, messages, api, followedRealms, realmSegments = {}, ...environment }:
  FeedEnvironment & {
  children: ReactNode;
}) {
  // Created on first use: the browser client needs `window`, which the server render has not.
  const client = useRef<FeedApi | null>(api ?? null);
  const getApi = useCallback(() => client.current ??= mainFeedApi(), []);
  const known = useMemo(() => followedRealms ? new Set(followedRealms) : null, [followedRealms]);
  // Joins and leaves made on this page, over what the server read.
  const [changed, setChanged] = useState<ReadonlyMap<string, boolean>>(new Map());
  const t = useMemo(() => materializeData(messages, { locale: environment.locale }), [messages, environment.locale]);
  const value: FeedValue = {
    ...environment, t,
    api: getApi,
    realmPath: realm => `/r/${realmSegments[realm] ?? realm.slice(-36)}`,
    realmState(realm) {
      const now = changed.get(realm);
      if (now !== undefined) return now ? 'joined' : 'join';
      if (!known) return 'unknown';
      return known.has(realm) ? 'joined' : 'join';
    },
    markJoined: (realm, joined) => setChanged(current => new Map(current).set(realm, joined)),
  };
  return <FeedContext value={value}>{children}</FeedContext>;
}
