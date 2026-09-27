import type { browserMainApi } from '../api/browser.ts';

// Main's responses Studio reads, taken from the typed API client so a
// contract change breaks this build.
type Main = ReturnType<typeof browserMainApi>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;

export type MainClient = Pick<Main, 'v1'>;
export type ContributionPage = Ok<Main['v1']['me']['contributions']['get']>;
/** One text the Agent authored: a Work's text in one language, with its current draft head. */
export type MyText = ContributionPage['items'][number];
export type SubmissionPage = Ok<Main['v1']['my']['submissions']['get']>;
export type Submission = Omit<SubmissionPage['items'][number], 'state'> & { state: SubmissionState };
// Main builds this union from a mapped array (services/main/src/modules/realm-submission/schema.ts),
// which the typed client cannot see through, so Studio names the states itself.
const submissionStates = ['pending', 'deciding', 'accepted', 'rejected', 'changes-requested', 'withdrawn',
  'stale'] as const;
export type SubmissionState = (typeof submissionStates)[number];
export type RealmDirectory = Ok<Main['v1']['realms']['get']>;
export type RealmChoice = RealmDirectory['items'][number];
export type WorkHeader = Ok<ReturnType<Main['v1']['works']>['get']>;
export type WorkMetadata = Ok<ReturnType<Main['v1']['works']>['metadata']['get']>;
export type TextDraft = Ok<ReturnType<ReturnType<Main['v1']['contributions']>['drafts']>['get']>;

/** Why a read gave nothing: Main refused this Agent, the thing is gone, or Main could not answer. */
export type ReadFailure = 'denied' | 'missing' | 'unavailable';
export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number): ReadFailure {
  if (status === 401 || status === 403) return 'denied';
  if (status === 404 || status === 410) return 'missing';
  return 'unavailable';
}

/** Main's Work types Studio offers (`WORK_SEMANTIC_TYPES` in services/main/src/modules/work/activate.ts). */
export const workTypes = {
  book: 'https://schema.org/Book',
  document: 'https://schema.org/DigitalDocument',
  recipe: 'https://schema.org/Recipe',
} as const;
export type WorkType = keyof typeof workTypes;

/** Languages Studio offers first; the list is a convenience, not a limit Main imposes. */
export const writingLanguages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar'] as const;

export const iri = (id: string) => `https://rezics.com/id/${id}`;
export const idOf = (value: string) => value.slice(-36);
