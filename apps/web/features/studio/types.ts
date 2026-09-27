import type { browserMainApi } from '../api/browser.ts';

// Main's responses Studio reads, taken from the typed API client so a
// contract change breaks this build.
type Main = ReturnType<typeof browserMainApi>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Work = ReturnType<Main['v1']['works']>;

export type MainClient = Pick<Main, 'v1'>;
export type ContributionPage = Ok<Main['v1']['me']['contributions']['get']>;
/** One text the Agent authored: a Work's text in one language, with its current draft head. */
export type MyText = ContributionPage['items'][number];
/** One page of the Studio Agent's Works (`GET /v1/me/agents/{agent}/works`). */
export type InventoryPage = Ok<ReturnType<Main['v1']['me']['agents']>['works']['get']>;
export type InventoryWork = InventoryPage['items'][number];
/** Main's state of an inventory Work, from the Agent's own texts: none yet, drafts only, or published. */
export type InventoryState = InventoryWork['state'];
export type SubmissionPage = Ok<Main['v1']['my']['submissions']['get']>;
export type Submission = Omit<SubmissionPage['items'][number], 'state'> & { state: SubmissionState };
// Main builds this union from a mapped array (services/main/src/modules/realm-submission/schema.ts),
// which the typed client cannot see through, so Studio names the states itself.
export const submissionStates = ['pending', 'deciding', 'accepted', 'rejected', 'changes-requested', 'withdrawn',
  'stale'] as const;
export type SubmissionState = (typeof submissionStates)[number];
export type RealmDirectory = Ok<Main['v1']['realms']['get']>;
export type RealmChoice = RealmDirectory['items'][number];
export type RealmHeader = Ok<ReturnType<Main['v1']['realms']>['get']>;
/** Who decides a submission: moderators always, trusted members at once, or anyone at once. */
export type ReviewMode = RealmHeader['reviewMode'];
export type WorkHeader = Ok<Work['get']>;
export type WorkMetadata = Ok<Work['metadata']['get']>;
export type ContentsPage = Ok<Work['contents']['get']>;
export type ContentsItem = ContentsPage['items'][number];
export type ContentVariantPage = Ok<Work['content-variants']['get']>;
export type ContentVariant = ContentVariantPage['items'][number];
export type ContentRevision = Ok<ReturnType<Main['v1']['content-revisions']>['get']>;
export type NativeVariants = Ok<ReturnType<Main['v1']['main-versions']>['native-variants']['get']>;
export type ClassificationPage = Ok<Work['classifications']['get']>;
export type TextDraft = Ok<ReturnType<ReturnType<Main['v1']['contributions']>['drafts']>['get']>;
export type TextHead = Ok<ReturnType<Main['v1']['contributions']>['get']>;

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

/** The Studio kind of a Work from its types. Chapters carry none: they are Works only a Book's contents name. */
export function workKind(types: readonly string[]): WorkType | 'chapter' {
  if (types.includes(workTypes.book)) return 'book';
  if (types.includes(workTypes.recipe)) return 'recipe';
  return types.includes(workTypes.document) ? 'document' : 'chapter';
}

/** Languages Studio offers first; the list is a convenience, not a limit Main imposes. */
export const writingLanguages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar'] as const;

/** A language tag in its canonical case ("zh-hans" → "zh-Hans"); Main's reads lower-case some tags. */
export function canonicalLanguage(tag: string): string {
  try { return Intl.getCanonicalLocales(tag)[0] ?? tag; } catch { return tag; }
}

const rtl = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ug', 'ckb']);
/** The text direction of a content language (not of the interface). */
export const directionOf = (language: string): 'ltr' | 'rtl' => rtl.has(language.split('-')[0]!.toLowerCase())
  ? 'rtl' : 'ltr';

export const iri = (id: string) => `https://rezics.com/id/${id}`;
export const idOf = (value: string) => value.slice(-36);
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
