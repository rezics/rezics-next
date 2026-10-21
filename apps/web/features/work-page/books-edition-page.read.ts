import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { releaseChoiceName, languageName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import type { EditionPreference, ProgressSummary } from '../tracking/types.ts';
import type { FacetList } from '../concept/types.ts';
import { iriOf, mainScope, type WorkScope } from './route.ts';
import type { AdoptionPage, AgentCreditPage, AlsoEnjoyedPage, ClassificationPage, CreditPage, Loaded, WorkHeader } from './types.ts';
import { failureOf } from './failure.ts';

export type Answer<T> = { data: T | null; error: { status: number; value?: unknown } | null;
  status?: number; response?: { status: number }; problem?: unknown };
/** Every Work reader retains the complete HTTP refusal alongside its display category. */
export type BooksRead<T> = Loaded<T>;

export const refusedRead = (error: NonNullable<Answer<unknown>['error']>) => ({ ok: false as const,
  failure: failureOf(error.status), status: error.status,
  ...(error.value !== undefined ? { problem: error.value } : {}) });

/** Eden wraps a failed fetch in a synthetic error without an HTTP response. */
const transportFailed = (answer: Answer<unknown>) =>
  (answer.error?.value instanceof Error || answer.error?.value instanceof DOMException) && !answer.response;

function pendingRead<T>(answer: Answer<T>): BooksRead<T> | null {
  return (answer.status ?? answer.response?.status) === 202
    ? { ok: false, failure: 'pending', status: 202, problem: answer.problem ?? answer.data } : null;
}

/** A moved first page restarts once. A cursor's full refusal belongs to the reader to recover. */
export async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<BooksRead<T>> {
  try {
    let answer = await call();
    if (answer.error?.status === 409 && !cursor) answer = await call();
    if (transportFailed(answer)) return { ok: false, failure: 'unavailable' };
    if (answer.error) return refusedRead(answer.error);
    return pendingRead(answer) ?? (answer.data === null
      ? { ok: false, failure: 'unavailable' } : { ok: true, data: answer.data });
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** Owner-specific publications and the reader preference use JSON null for a visible empty state. */
export async function settleNullable<T>(call: () => Promise<Answer<T>>): Promise<BooksRead<T | null>> {
  try {
    const answer = await call();
    if (transportFailed(answer)) return { ok: false, failure: 'unavailable' };
    return answer.error ? refusedRead(answer.error) : pendingRead(answer) ?? { ok: true, data: answer.data };
  } catch { return { ok: false, failure: 'unavailable' }; }
}

/** Work reads shared by the server page and its recorded surface. */
export function booksEditionReads({ main, actingSubject }: { main: Pick<MainClient, 'v1'>; actingSubject?: string }) {
  return {
    readWorkHeader: (id: string): Promise<BooksRead<WorkHeader>> =>
      settle(() => main.v1.works({ id }).get({ query: { actingSubject } })),
    readReleases: (id: string) =>
      settle(() => main.v1.works({ id }).releases.get({ query: { limit: 20, actingSubject } })),
    readEditionRelease: (id: string, release: string) =>
      settle(() => main.v1.works({ id }).releases({ release: release.slice(-36) }).get({
        query: { actingSubject } })),
    readEditionRealization: (id: string, realization: string, revision: string) =>
      settle(() => main.v1.works({ id }).realizations({ realization: realization.slice(-36) }).get({
        query: { actingSubject, revision } })),
    readEditionPreference: (id: string): Promise<BooksRead<EditionPreference | null>> => actingSubject
      ? settleNullable(() => main.v1.me['edition-preferences']({ work: id }).get({ query: { actingSubject } }))
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
    readProgressSummary: (id: string, language?: string | null): Promise<BooksRead<ProgressSummary>> => actingSubject
      ? settle(() => main.v1.me['progress-summaries']({ resource: id }).get({
        query: { actingSubject, ...(language ? { language } : {}) } }))
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
    readAgentCredits: (id: string): Promise<BooksRead<AgentCreditPage>> =>
      settle(() => main.v1.works({ id })['agent-credits'].get({ query: { actingSubject } })),
    readCredits: (id: string): Promise<BooksRead<CreditPage>> => settle(async () => {
      const result = await main.v1.query.post({
        profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
        parameters: { roots: [iriOf(id)] }, presentation: { actingSubject },
      });
      return {
        ...result, problem: result.data,
        error: result.error,
        data: result.data?.result?.profile === 'template-result-v1'
          && result.data.result.query === 'https://rezics.com/query/work-credits'
          ? result.data.result : null,
      };
    }),
    readClassifications: (id: string, scope: WorkScope): Promise<BooksRead<ClassificationPage>> =>
      settle(() => main.v1.works({ id }).classifications.get({
        query: { actingSubject, ...mainScope(scope) } })),
    readFacets: (): Promise<BooksRead<FacetList>> => settle(() => main.v1.facets.get()),
    readAlsoEnjoyed: (id: string): Promise<BooksRead<AlsoEnjoyedPage>> =>
      settle(() => main.v1.works({ id })['also-enjoyed'].get({ query: { actingSubject, limit: 12 } })),
    readAdoptions: (id: string): Promise<BooksRead<AdoptionPage>> => settle(async () => {
      const result = await main.v1.query.post({
        profile: 'template-query-v1', query: 'https://rezics.com/query/work-adoptions', revision: 1,
        parameters: { roots: [iriOf(id)] }, presentation: { actingSubject },
      });
      return {
        ...result, problem: result.data,
        error: result.error,
        data: result.data?.result?.profile === 'template-result-v1'
          && result.data.result.query === 'https://rezics.com/query/work-adoptions'
          ? result.data.result : null,
      };
    }),
  };
}

export type BooksReleasePage = Extract<Awaited<ReturnType<ReturnType<typeof booksEditionReads>['readReleases']>>, { ok: true }>['data'];

type BooksReads = ReturnType<typeof booksEditionReads>;
type StatusReads = Pick<BooksReads, 'readEditionPreference' | 'readEditionRelease'> & Partial<Pick<BooksReads, 'readEditionRealization'>> & {
  readProgressSummary: (id: string, language?: string | null) => Promise<{ ok: true; data: ProgressSummary } | { ok: false }>;
};

/** Resolve the saved identity directly: it need not appear in the first inventory page. */
export async function readBooksEditionStatus(reads: StatusReads,
  id: string, locale: UiLocale, savedPreference?: Loaded<EditionPreference | null>) {
  const preference = savedPreference ?? await reads.readEditionPreference(id);
  const language = preference.ok && preference.data ? preference.data.language : locale;
  const chosen = preference.ok ? preference.data?.edition : null;
  const [progress, release, realization] = await Promise.all([reads.readProgressSummary(id, language),
    chosen?.kind === 'release' ? reads.readEditionRelease(id, chosen.resource) : Promise.resolve(null),
    chosen?.kind === 'realization' && reads.readEditionRealization
      ? reads.readEditionRealization(id, chosen.resource, chosen.revision) : Promise.resolve(null)]);
  const t = copyOf(locale);
  const editionName = release?.ok && release.data.revision === chosen?.revision
    ? releaseChoiceName(release.data, locale, t) : realization?.ok && realization.data.revision === chosen?.revision
      ? realization.data.kind === 'original' ? t.originalText({ language: languageName(realization.data.language, locale) })
        : t.translationText({ language: languageName(realization.data.language, locale) }) : null;
  return { preference, progress, editionName };
}

/** Bounded page reads; the host frame and the recorded frame supply the same readers. */
export async function readBooksEditionPage(reads: BooksReads, id: string, locale: UiLocale) {
  const [header, releases, status] = await Promise.all([
    reads.readWorkHeader(id), reads.readReleases(id), readBooksEditionStatus(reads, id, locale),
  ]);
  return { header, releases, status };
}
