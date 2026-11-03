import type { KernelClient } from '@rezics/client';

type RecoveryClient = KernelClient['libraryArchiveCollectionRecoveries'];
type RecoveryRoot = ReturnType<RecoveryClient>;
type OccurrencesRoute = ReturnType<RecoveryRoot['collections']>['occurrences'];

type DataOf<T> = T extends (...args: infer _Arguments) => infer Result
  ? Awaited<Result> extends { data: infer Data }
    ? NonNullable<Data>
    : never
  : never;

type BodyOf<T> = T extends (...args: infer Arguments) => unknown ? Arguments[0] : never;

/** Bounds copied from the installed native producer contract and its mounted schemas. */
export const RECOVERY_UPLOAD_BYTES = 34 * 1024 * 1024;
export const RECOVERY_UPLOAD_BASE64_CHARS = Math.ceil(RECOVERY_UPLOAD_BYTES / 3) * 4;
export const RECOVERY_PAGE_ROWS = 50;
export const RECOVERY_SELECTED_OCCURRENCES = 1_000;
export const RECOVERY_APPLY_COMMANDS = 25;
export const RECOVERY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const RECOVERY_CURSOR_CHARS = 4_096;
export const RECOVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** These response and request shapes come directly from the generated mounted client. */
export type RecoveryStatus = DataOf<RecoveryRoot['get']>;
export type RecoveryCollectionsPage = DataOf<RecoveryRoot['collections']['get']>;
export type RecoveryOccurrencesPage = DataOf<OccurrencesRoute['get']>;
export type RecoveryReview = DataOf<RecoveryRoot['review']['post']>;
export type RecoveryOutcomesPage = DataOf<RecoveryRoot['outcomes']['get']>;
export type RecoveryUploadBody = BodyOf<RecoveryClient['post']>;
export type RecoveryReviewBody = BodyOf<RecoveryRoot['review']['post']>;
export type RecoveryApplyBody = BodyOf<RecoveryRoot['apply']['post']>;
export type RecoveryCollection = RecoveryCollectionsPage['collections'][number];
export type RecoveryOccurrence = RecoveryOccurrencesPage['occurrences'][number];
export type RecoveryOutcome = RecoveryOutcomesPage['outcomes'][number];

export type RecoveryEffectCommand =
  | { kind: 'upload'; key: string; body: RecoveryUploadBody }
  | { kind: 'review'; uploadId: string; key: string; body: RecoveryReviewBody }
  | { kind: 'apply'; uploadId: string; body: RecoveryApplyBody }
  | { kind: 'cancel'; uploadId: string };

export type RecoveryFailureKind = 'denied' | 'unavailable' | 'not-found' | 'conflict' | 'invalid';
export type RecoveryFailure = { kind: RecoveryFailureKind };
export type RecoveryUnknown = { kind: 'unknown'; command: RecoveryEffectCommand };
export type RecoveryResult<T> = { kind: 'ok'; value: T } | RecoveryFailure | RecoveryUnknown;

export type RecoveryPageQuery = { cursor?: string; limit: typeof RECOVERY_PAGE_ROWS };

export type RecoveryPort = {
  upload(command: Extract<RecoveryEffectCommand, { kind: 'upload' }>): Promise<RecoveryResult<RecoveryStatus>>;
  status(uploadId: string): Promise<RecoveryResult<RecoveryStatus>>;
  collections(uploadId: string, query: RecoveryPageQuery): Promise<RecoveryResult<RecoveryCollectionsPage>>;
  occurrences(
    uploadId: string,
    collectionId: string,
    query: RecoveryPageQuery,
  ): Promise<RecoveryResult<RecoveryOccurrencesPage>>;
  review(command: Extract<RecoveryEffectCommand, { kind: 'review' }>): Promise<RecoveryResult<RecoveryReview>>;
  apply(command: Extract<RecoveryEffectCommand, { kind: 'apply' }>): Promise<RecoveryResult<RecoveryStatus>>;
  outcomes(uploadId: string, query: RecoveryPageQuery): Promise<RecoveryResult<RecoveryOutcomesPage>>;
  cancel(command: Extract<RecoveryEffectCommand, { kind: 'cancel' }>): Promise<RecoveryResult<RecoveryStatus>>;
};

export function newRecoveryCommandKey(): string {
  return crypto.randomUUID();
}
