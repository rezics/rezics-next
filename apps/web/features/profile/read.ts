import { cookies } from 'next/headers';
import { cache } from 'react';
import { resolveAddress } from '../address/server.ts';
import { isNativeHandle } from './route.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { type ReaderSeed, readReaderSeed } from '../catalogue/reader-store.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { shelfStatuses } from './route.ts';
import { type AgentProfile, type AgentWorksPage, failureOf, type FollowState, type LibraryView, type Loaded,
  type PublicShelfPage, type ShelfCard, type ShelfStatus, type ShelfSummary } from './types.ts';

// Server reads for `/@{handle}`. Each returns a `Loaded` result instead of
// throwing, so works that cannot load never hide someone's shelves. Reads are
// cached per request: the page, its metadata and its regions share one Main call.

/**
 * Who reads. A signed-in person whose session Agent is eligible reads as that
 * Agent, so Main shows the owner their own non-public shelves and says whether
 * they follow this profile; anyone else reads the public profile.
 */
export const profileReader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject ?? undefined : undefined;
  return { signedIn: Boolean(token), actingSubject, main: mainApiWithToken(actingSubject ? token : undefined),
    anonymous: mainApiWithToken(undefined),
    /** Avatar and cover bytes go through the BFF, which sends the token, so Main needs the Agent too. */
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '' };
});

type Answer<T> = { data: T | null; error: { status: number } | null };

/**
 * One Main read as a `Loaded` result. Main answers 409 when the graph moved
 * during the read; a first page simply starts again, once, as Main asks. A
 * moved cursor is the reader's to restart.
 */
async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409 && !cursor) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

export type ProfileResolution =
  | { kind: 'profile'; profile: AgentProfile }
  /** A retired handle, a native handle behind a vanity one, or another letter case: the page moves. */
  | { kind: 'moved'; handle: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/** The Agent behind a handle, shared by a profile page and its metadata. */
export const resolveProfile = cache(async (handle: string, locale: UiLocale): Promise<ProfileResolution> => {
  const { main, actingSubject } = await profileReader();
  const address = await resolveAddress('agent', isNativeHandle(handle) ? handle.slice(6) : handle, locale);
  if (address.kind !== 'resolved') return { kind: address.kind === 'unavailable' ? 'unavailable' : 'missing' };
  const read = await settle(() => main.v1.agents({ id: address.data.holder.slice(-36) }).get({ query: { actingSubject } }));
  if (!read.ok) return { kind: read.failure === 'missing' || read.failure === 'invalid' ? 'missing' : 'unavailable' };
  const profile = { ...read.data, address: address.data.canonical };
  return { kind: 'profile', profile };
});

/**
 * The first standing Global rating question, whose means the work rows show.
 * Main never averages across questions; without one, rows carry no rating.
 */
const standingContext = cache(async (): Promise<string | undefined> => {
  const { anonymous } = await profileReader();
  const read = await settle(() => anonymous.v1['rating-contexts'].get({ query: { scope: 'global', limit: 1 } }));
  return read.ok ? read.data.items[0]?.context : undefined;
});

/** Works the Agent is credited on, with card fields and Global ratings. */
export const readProfileWorks = cache(async (agent: string, _locale: UiLocale, limit: number, cursor?: string):
  Promise<Loaded<AgentWorksPage>> => {
  const [{ main, actingSubject }, context] = await Promise.all([profileReader(), standingContext()]);
  return settle(() => main.v1.agents({ id: agent.slice(-36) }).works.get({ query: { actingSubject,
    context, limit, cursor } }), cursor);
});

/** Followers, and whether the reader follows, for the follow button. */
export const readFollowState = cache(async (agent: string, _locale: UiLocale): Promise<Loaded<FollowState>> => {
  const { main, actingSubject } = await profileReader();
  return settle(() => main.v1.follows({ id: agent.slice(-36) }).get({ query: { kind: 'agent',
    actingSubject } }));
});

/** Whether the profile lists the owner's shelves through `/v1/me` (theirs, not public) or Main's public read. */
const ownShelves = (profile: AgentProfile) => profile.links.statusShelves?.startsWith('/v1/me/') ?? false;

/** One page of a status shelf: public, or the owner's own. Cards Main could not name are left out. */
export async function readShelfPage(profile: AgentProfile, status: ShelfStatus, limit: number, cursor?: string):
  Promise<Loaded<{ count: number; cards: ShelfCard[]; nextCursor: string | null }>> {
  const { main, actingSubject } = await profileReader();
  if (ownShelves(profile) && actingSubject) {
    const read = await settle(() => main.v1.me.shelves.status({ status }).works.get({ query: { actingSubject, limit,
      cursor } }), cursor);
    const summary = await readOwnCounts(actingSubject);
    return read.ok ? { ok: true, data: { count: summary.find(item => item.status === status)?.count ?? 0,
      cards: read.data.items.flatMap(item => (item.card ? [item.card] : [])), nextCursor: read.data.nextCursor } }
      : read;
  }
  const read = await settle<PublicShelfPage>(() => main.v1.agents({ id: profile.id.slice(-36) }).shelves
    .status({ status }).works.get({ query: { actingSubject, limit, cursor } }), cursor);
  return read.ok ? { ok: true, data: { count: read.data.statusCount, cards: read.data.items.map(item => item.card),
    nextCursor: read.data.nextCursor } } : read;
}

const readOwnCounts = cache(async (actingSubject: string) => {
  const { main } = await profileReader();
  const read = await settle(() => main.v1.me.shelves.get({ query: { actingSubject, limit: 1 } }));
  return read.ok ? read.data.statusShelves : [];
});

/** How many Works each status shelf holds, in the profile's order. */
async function readShelfCounts(profile: AgentProfile): Promise<Loaded<{ status: ShelfStatus; count: number }[]>> {
  const { main, actingSubject } = await profileReader();
  const read = ownShelves(profile) && actingSubject
    ? await settle(() => main.v1.me.shelves.get({ query: { actingSubject, limit: 1 } }))
    : await settle(() => main.v1.agents({ id: profile.id.slice(-36) }).shelves.get({ query: { actingSubject } }));
  if (!read.ok) return read;
  return { ok: true, data: shelfStatuses.map(status => ({ status,
    count: read.data.statusShelves.find(item => item.status === status)?.count ?? 0 })) };
}

/**
 * The profile's library: each status shelf's count and first Works when Main
 * shows them to this reader, otherwise who may see them.
 */
export const readLibrary = cache(async (profile: AgentProfile, perShelf: number): Promise<LibraryView> => {
  if (!profile.library.statusShelvesVisible) {
    return { kind: 'private', visibility: profile.library.visibility === 'followers' ? 'followers' : 'private' };
  }
  const counts = await readShelfCounts(profile);
  if (!counts.ok) return { kind: 'failed', failure: counts.failure };
  const shelves = await Promise.all(counts.data.map(async ({ status, count }): Promise<ShelfSummary> => {
    if (!count) return { status, count, works: { ok: true, data: [] } };
    const page = await readShelfPage(profile, status, perShelf);
    return { status, count, works: page.ok ? { ok: true, data: page.data.cards } : page };
  }));
  return { kind: 'shelves', own: ownShelves(profile), shelves };
});

/** The reader's shelf state for the Works on the page, so shelf buttons render settled. */
export async function readReaderState(works: readonly string[]): Promise<ReaderSeed | null> {
  const { main, actingSubject } = await profileReader();
  if (!actingSubject || !works.length) return actingSubject ? {} : null;
  return readReaderSeed(main, actingSubject, works);
}
