import type { BrowseScope } from './scope.ts';
import { failureOf, type DiscoveryPage, type DiscoveryQuery, type Loaded, type MainClient,
  problemCode, type RealmHeader } from './types.ts';

// Reads shared by the server render and the browser's "Show more": each takes
// the Eden client for its side and returns `Loaded` instead of throwing, so
// one shelf's failure never takes down the page.

type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };

export async function settle<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T>> {
  try {
    const { data, error } = await call();
    if (error) return { ok: false, failure: failureOf(error.status, problemCode(error.value)) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** One page of a discovery shelf. A first page cannot have moved under a cursor, so its 409 is staleness. */
export async function readDiscovery(main: MainClient, query: DiscoveryQuery): Promise<Loaded<DiscoveryPage>> {
  const read = await settle(() => main.v1.works.get({ query }));
  return !read.ok && read.failure === 'moved' && !query.cursor ? { ok: false, failure: 'stale' } : read;
}

/** A public Realm's header, for its name in the scope bar and shelf titles. */
export function readRealm(main: MainClient, realm: string, language: string): Promise<Loaded<RealmHeader>> {
  return settle(() => main.v1.realms({ realm }).get({ query: { language } }));
}

/** The question a standing rating Context asks, for a top-rated shelf's label. */
export async function readContextQuestion(main: MainClient, scope: BrowseScope,
  context: string): Promise<Loaded<{ question: string; max: number }>> {
  if (scope.kind === 'realm') {
    const read = await settle(() => main.v1['rating-contexts']({ id: context }).get());
    return read.ok ? { ok: true, data: { question: read.data.question, max: 10 } } : read;
  }
  const read = await settle(() => main.v1['global-rating-contexts']({ id: context }).get());
  return read.ok ? { ok: true, data: { question: read.data.question, max: read.data.scale.max } } : read;
}
