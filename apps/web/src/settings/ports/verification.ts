import type {
  VerificationApplication,
  VerificationRecovery,
  VerificationSubjectSearch,
} from '../application/verification';
import type {
  VerificationAmbient,
  VerificationEligibleSearchCopy,
  VerificationOperations,
  VerificationRecoveryIO,
  VerificationSearchCopy,
  VerificationSearchResult,
  VerificationSnapshot,
  VerificationSubject,
  VerificationSubjectSearchFn,
} from '../contract/verification';

export type {
  VerificationAmbient,
  VerificationApplication,
  VerificationEligibleSearchCopy,
  VerificationOperations,
  VerificationRecovery,
  VerificationRecoveryIO,
  VerificationSearchCopy,
  VerificationSearchResult,
  VerificationSnapshot,
  VerificationSubject,
  VerificationSubjectSearch,
  VerificationSubjectSearchFn,
};

/** Explicit applicant-verification capability bound at Settings composition. */
export type VerificationCapability = {
  readonly application: VerificationApplication;
  readonly search: VerificationSubjectSearchFn;
  readonly ownerKey: (accountId: string, csrfToken: string | null) => string | null;
};

export type VerificationTitleRead = (
  accountId: string,
  subjectId: string,
  signal?: AbortSignal,
) => Promise<string | null>;
