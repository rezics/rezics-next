import { browserMainApi } from '../api/browser.ts';
import type { InterestKind } from './state.ts';
import { type FeedbackKind, type FeedbackStrength, type FeedHead, type FeedPage, type FeedQuery, type FollowKind,
  type Loaded, type MainClient, settle, type SuggestedFollow, uuidOf, type Vote } from './types.ts';

// The browser side of home: every command acts as the session's Agent and
// carries its own idempotency key; the BFF adds the bearer token. Views take
// a `FeedApi`, so stories run the same flows against an in-memory Main.
// Shelving goes through the catalogue's reader actions, shared with Discover.

export interface VoteReceipt { value: Vote; score: number; revision: string }

export interface FeedApi {
  page(query: FeedQuery): Promise<Loaded<FeedPage>>;
  vote(item: string, input: { value: Vote; expectedRevision: string | null; actingSubject: string },
    key: string): Promise<Loaded<VoteReceipt>>;
  /** Follows or unfollows; reads the relation's revision first, as Main's CAS requires. */
  follow(target: string, kind: FollowKind, following: boolean, actingSubject: string,
    key: string): Promise<Loaded<{ following: boolean }>>;
  /** Follows several at once, in one idempotent command. */
  batchFollow(targets: readonly { target: string; kind: FollowKind }[], actingSubject: string,
    key: string): Promise<Loaded<unknown>>;
  /** Realms and Zones to follow for chosen interests, each with its reason. */
  suggestions(input: { interests: readonly InterestKind[]; languages: readonly string[]; locale: string;
    actingSubject?: string }): Promise<Loaded<SuggestedFollow[]>>;
  feedback(input: { actingSubject: string; kind: FeedbackKind; target: string; strength: FeedbackStrength },
    key: string): Promise<Loaded<unknown>>;
  hideContinue(work: string, hidden: boolean, actingSubject: string, key: string): Promise<Loaded<unknown>>;
  head(input: { after: string; scope: 'following' | 'all'; actingSubject?: string }): Promise<Loaded<FeedHead>>;
  watermark(scope: 'following' | 'all', input: { actingSubject: string; dataEpoch: string; sequence: string },
    key: string): Promise<Loaded<unknown>>;
}

export function mainFeedApi(main: MainClient = browserMainApi()): FeedApi {
  const headers = (key: string) => ({ headers: { 'idempotency-key': key } });
  return {
    page: query => settle(() => main.v1.feed.get({ query })),

    vote: (item, input, key) => settle(() => main.v1.feed({ id: uuidOf(item) }).vote.post({
      profile: 'feed-vote-command-v1', ...input }, headers(key))),

    async follow(target, kind, following, actingSubject, key) {
      const state = await settle(() => main.v1.follows({ id: uuidOf(target) }).get({ query: { kind, actingSubject } }));
      if (!state.ok) return state;
      if (state.data.following === following) return { ok: true, data: { following } };
      const written = await settle(() => main.v1.follows.post({ profile: 'follow-command-v1', target, kind,
        actingSubject, following, expectedRevision: state.data.revision }, headers(key)));
      return written.ok ? { ok: true, data: { following: written.data.following } } : written;
    },

    batchFollow: (targets, actingSubject, key) => settle(() => main.v1.me.follows.batch.post({
      profile: 'follow-batch-v1', actingSubject, targets: [...targets] }, headers(key))),

    async suggestions(input) {
      const read = await settle(() => main.v1.onboarding['suggested-follows'].get({ query: { locale: input.locale,
        ...(input.interests.length ? { interests: input.interests.join(',') } : {}),
        ...(input.languages.length ? { languages: input.languages.join(',') } : {}),
        ...(input.actingSubject ? { actingSubject: input.actingSubject } : {}) } }));
      return read.ok ? { ok: true, data: read.data.items } : read;
    },

    feedback: (input, key) => settle(() => main.v1.me['feed-feedback'].post(input, headers(key))),

    hideContinue: (work, hidden, actingSubject, key) => settle(() => main.v1.me.continue({ work: uuidOf(work) })
      .hidden.put({ actingSubject, hidden }, headers(key))),

    head: input => settle(() => main.v1.feed.head.get({ query: input })),

    watermark: (scope, input, key) => settle(() => main.v1.me['feed-watermarks']({ scope }).put({ ...input, scope },
      headers(key))),
  };
}

/** A fresh idempotency key for one user intent. */
export function commandKey(): string {
  return crypto.randomUUID();
}
