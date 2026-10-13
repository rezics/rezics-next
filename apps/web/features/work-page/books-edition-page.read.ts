import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import type { EditionPreference, ProgressSummary } from '../tracking/types.ts';
import { iriOf } from './route.ts';
import type { AgentCreditPage, CreditPage, Loaded, WorkHeader } from './types.ts';
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

/** Work reads shared by the server page and its recorded surface. */
export function booksEditionReads({ main, actingSubject }: { main: MainClient; actingSubject?: string }) {
  return {
    readWorkHeader: (id: string): Promise<BooksRead<WorkHeader>> =>
      settle(() => main.v1.works({ id }).get({ query: { actingSubject } }), undefined, true),
    readReleases: (id: string) =>
      settle(() => main.v1.works({ id }).releases.get({ query: { limit: 20, actingSubject } }), undefined, true),
    readEditionRelease: (id: string, release: string) =>
      settle(() => main.v1.works({ id }).releases({ release: release.slice(-36) }).get({
        query: { actingSubject } }), undefined, true),
    readEditionPreference: (id: string): Promise<BooksRead<EditionPreference | null>> => actingSubject
      ? settleNullable(() => main.v1.me['edition-preferences']({ work: id }).get({ query: { actingSubject } }), true)
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
    readProgressSummary: (id: string, language?: string): Promise<BooksRead<ProgressSummary>> => actingSubject
      ? settle(() => main.v1.me['progress-summaries']({ resource: id }).get({
        query: { actingSubject, ...(language ? { language } : {}) } }), undefined, true)
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
    readAgentCredits: (id: string): Promise<BooksRead<AgentCreditPage>> =>
      settle(() => main.v1.works({ id })['agent-credits'].get({ query: { actingSubject } })),
    readCredits: (id: string): Promise<BooksRead<CreditPage>> => settle(async () => {
      const result = await main.v1.query.post({
        profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
        parameters: { roots: [iriOf(id)] }, presentation: { actingSubject },
      });
      return {
        error: result.error,
        data: result.data?.result.profile === 'template-result-v1'
          && result.data.result.query === 'https://rezics.com/query/work-credits'
          ? result.data.result : null,
      };
    }),
  };
}

export type BooksReleasePage = Extract<Awaited<ReturnType<ReturnType<typeof booksEditionReads>['readReleases']>>, { ok: true }>['data'];

type BooksReads = ReturnType<typeof booksEditionReads>;
type StatusReads = Pick<BooksReads, 'readEditionPreference' | 'readEditionRelease'> & {
  readProgressSummary: (id: string, language?: string) => Promise<{ ok: true; data: ProgressSummary } | { ok: false }>;
};

/** Resolve the saved identity directly: it need not appear in the first inventory page. */
export async function readBooksEditionStatus(reads: StatusReads,
  id: string, locale: UiLocale, savedPreference?: Loaded<EditionPreference | null>) {
  const preference = savedPreference ?? await reads.readEditionPreference(id);
  const language = preference.ok && preference.data ? preference.data.language : locale;
  const chosen = preference.ok ? preference.data?.edition : null;
  const [progress, release] = await Promise.all([reads.readProgressSummary(id, language),
    chosen?.kind === 'release' ? reads.readEditionRelease(id, chosen.resource) : Promise.resolve(null)]);
  return { preference, progress, editionName: release?.ok ? releaseChoiceName(release.data, locale, copyOf(locale)) : null };
}

/** Bounded page reads; the host frame and the recorded frame supply the same readers. */
export async function readBooksEditionPage(reads: BooksReads, id: string, locale: UiLocale) {
  const [header, releases, status] = await Promise.all([
    reads.readWorkHeader(id), reads.readReleases(id), readBooksEditionStatus(reads, id, locale),
  ]);
  return { header, releases, status };
}
