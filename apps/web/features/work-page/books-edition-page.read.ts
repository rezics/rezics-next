import type { MainClient } from '../discover/types.ts';
import type { EditionPreference, ProgressSummary } from '../tracking/types.ts';
import type { Loaded, WorkHeader } from './types.ts';
import { failureOf } from './failure.ts';

export type Answer<T> = { data: T | null; error: { status: number; value?: unknown } | null };

/**
 * One Main read as a `Loaded` result. Main answers 409 when the graph moved
 * during the read; a read that is not continuing a cursor simply starts
 * again, once, as Main asks. A moved cursor is the reader's to restart.
 */
export async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409 && !cursor) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** These two type pages use JSON null for a visible Work without an owner-specific publication. */
export async function settleNullable<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T | null>> {
  try {
    const { data, error } = await call();
    return error ? { ok: false, failure: failureOf(error.status) } : { ok: true, data };
  } catch { return { ok: false, failure: 'unavailable' }; }
}

/** The four Work reads shared by the server page and its recorded surface. */
export function booksEditionReads({ main, actingSubject }: { main: MainClient; actingSubject?: string }) {
  return {
    readWorkHeader: (id: string): Promise<Loaded<WorkHeader>> =>
      settle(() => main.v1.works({ id }).get({ query: { actingSubject } })),
    readReleases: (id: string) =>
      settle(() => main.v1.works({ id }).releases.get({ query: { limit: 20, actingSubject } })),
    readEditionPreference: (id: string): Promise<Loaded<EditionPreference | null>> => actingSubject
      ? settleNullable(() => main.v1.me['edition-preferences']({ work: id }).get({ query: { actingSubject } }))
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
    readProgressSummary: (id: string, language?: string): Promise<Loaded<ProgressSummary>> => actingSubject
      ? settle(() => main.v1.me['progress-summaries']({ resource: id }).get({
        query: { actingSubject, ...(language ? { language } : {}) } }))
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
  };
}

export type BooksReleasePage = Extract<Awaited<ReturnType<ReturnType<typeof booksEditionReads>['readReleases']>>, { ok: true }>['data'];
