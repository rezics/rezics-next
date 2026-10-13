import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import type { EditionPreference, ProgressSummary } from '../tracking/types.ts';
import type { Loaded, WorkHeader } from './types.ts';
import { failureOf } from './failure.ts';

export type Answer<T> = { data: T | null; error: { status: number; value?: unknown } | null };
/** The display category accompanies the unchanged HTTP problem; it never replaces it. */
export type BooksRead<T> = Loaded<T> & { status?: number; problem?: unknown };

const refused = (error: NonNullable<Answer<unknown>['error']>, keepProblem: boolean) => ({ ok: false as const,
  failure: failureOf(error.status), ...(keepProblem && error.value !== undefined
    ? { status: error.status, problem: error.value } : {}) });

/**
 * One Main read as a `Loaded` result. Main answers 409 when the graph moved
 * during the read; a read that is not continuing a cursor simply starts
 * again, once, as Main asks. A moved cursor is the reader's to restart.
 * Books retain the HTTP problem; legacy consumers keep their existing result shape.
 */
export async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string, keepProblem = false): Promise<BooksRead<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409 && !cursor) ({ data, error } = await call());
    if (error) return refused(error, keepProblem);
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** These two type pages use JSON null for a visible Work without an owner-specific publication. */
export async function settleNullable<T>(call: () => Promise<Answer<T>>, keepProblem = false): Promise<BooksRead<T | null>> {
  try {
    const { data, error } = await call();
    return error ? refused(error, keepProblem) : { ok: true, data };
  } catch { return { ok: false, failure: 'unavailable' }; }
}

/** The four Work reads shared by the server page and its recorded surface. */
export function booksEditionReads({ main, actingSubject }: { main: MainClient; actingSubject?: string }) {
  return {
    readWorkHeader: (id: string): Promise<BooksRead<WorkHeader>> =>
      settle(() => main.v1.works({ id }).get({ query: { actingSubject } }), undefined, true),
    readReleases: (id: string) =>
      settle(() => main.v1.works({ id }).releases.get({ query: { limit: 20, actingSubject } }), undefined, true),
    readEditionPreference: (id: string): Promise<BooksRead<EditionPreference | null>> => actingSubject
      ? settleNullable(() => main.v1.me['edition-preferences']({ work: id }).get({ query: { actingSubject } }), true)
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
    readProgressSummary: (id: string, language?: string): Promise<BooksRead<ProgressSummary>> => actingSubject
      ? settle(() => main.v1.me['progress-summaries']({ resource: id }).get({
        query: { actingSubject, ...(language ? { language } : {}) } }), undefined, true)
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
  };
}

export type BooksReleasePage = Extract<Awaited<ReturnType<ReturnType<typeof booksEditionReads>['readReleases']>>, { ok: true }>['data'];

type BooksReads = ReturnType<typeof booksEditionReads>;
type StatusReads = Pick<BooksReads, 'readEditionPreference' | 'readReleases'> & {
  readProgressSummary: (id: string, language?: string) => Promise<{ ok: true; data: ProgressSummary } | { ok: false }>;
};

/** The server status and recorded surface resolve the saved exact identity in the same release page. */
export async function readBooksEditionStatus(reads: StatusReads,
  id: string, locale: UiLocale, savedPreference?: Loaded<EditionPreference | null>) {
  const preference = savedPreference ?? await reads.readEditionPreference(id);
  const language = preference.ok && preference.data ? preference.data.language : locale;
  const [progress, releases] = await Promise.all([reads.readProgressSummary(id, language), reads.readReleases(id)]);
  const chosen = preference.ok ? preference.data?.edition : null;
  const release = chosen?.kind === 'release' && releases.ok
    ? releases.data.items.find(item => item.id === chosen.resource) : undefined;
  return { preference, progress, editionName: release ? releaseChoiceName(release, locale, copyOf(locale)) : null };
}

/** Bounded page reads; the host frame and the recorded frame supply the same readers. */
export async function readBooksEditionPage(reads: BooksReads, id: string, locale: UiLocale) {
  const [header, releases, status] = await Promise.all([
    reads.readWorkHeader(id), reads.readReleases(id), readBooksEditionStatus(reads, id, locale),
  ]);
  return { header, releases, status };
}
