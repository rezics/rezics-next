/** Applicant verification vocabulary. Native envelopes stay closed; extra producer fields are ignored. */

export const VERIFICATION_REQUEST_TIMEOUT_MS = 10_000;
export const VERIFICATION_QUERY_LIMIT = 100;
export const VERIFICATION_SUGGESTION_LIMIT = 8;
export const VERIFICATION_SEARCH_DEBOUNCE_MS = 250;
export const VERIFICATION_PERSON_TYPE = 'schema:Person';
export const VERIFICATION_ORGANIZATION_TYPE = 'schema:Organization';
export const VERIFICATION_REQUEST_OPERATION = 'account.request_verification';
export const VERIFICATION_WITHDRAW_OPERATION = 'account.withdraw_verification';
export const VERIFICATION_PLATFORM_CLOSED_MESSAGE = 'rezics-platform-closed';

export type VerificationInput = {
  subject: string;
  statement: string;
  links: { label: string; url: string }[];
  idempotencyKey: string;
};

export type VerificationDraftFields = {
  subject: string;
  statement: string;
  links: { label: string; url: string }[];
};

export type VerificationIssue = {
  field: 'subject' | 'statement' | 'links' | 'label' | 'url';
  index?: number;
  code:
    | 'subject-required'
    | 'statement-required'
    | 'statement-limit'
    | 'links-limit'
    | 'label-required'
    | 'label-limit'
    | 'url-required'
    | 'url-limit'
    | 'url-https';
};

export type AgentVerificationProblem = { type: string; detail: string };
export type AgentVerificationRequest = {
  id: string;
  accountId: string;
  accountKind: 'actor' | 'organization';
  requestedBy: string | null;
  catalogueSubjectId: string;
  statement: string;
  links: { label: string; url: string }[];
  state: 'pending' | 'approving' | 'approved' | 'rejected' | 'withdrawn' | 'failed';
  reason: string | null;
  problem: AgentVerificationProblem | null;
  decisionReceiptId: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentVerificationViewerAction = { action: string; operations: string[] };
export type VerificationStatus = {
  verificationRequest: AgentVerificationRequest | null;
  viewerActions: AgentVerificationViewerAction[];
};

export type VerificationFailure = {
  status: number;
  message: string;
  code?: string;
  retryable?: boolean;
  requestId?: string;
  retryAfter?: string;
};

export type VerificationCommandResult =
  | { ok: true; verificationRequest: AgentVerificationRequest }
  | ({ ok: false; outcome?: 'refused' } & VerificationFailure);

/** Explicit private transport envelope: server-function Error serialization drops custom properties. */
export type VerificationReadResult<T> = { ok: true; value: T } | { ok: false; failure: VerificationFailure };

export type VerificationSearchFailure = Omit<VerificationFailure, 'requestId'> & {
  kind: 'refused' | 'closed' | 'unavailable';
};
export type VerificationSearchResult<T> = { ok: true; value: T } | { ok: false; failure: VerificationSearchFailure };

export type VerificationSubject = { id: string; title: string; type: string };
export type VerificationSuggestionHit = {
  id: string;
  type: string;
  labels: Record<string, string>;
  summary: { label?: { value: string; language?: string } | null } | null;
};

export type VerificationReleaseType = { bases?: readonly string[] };
export type VerificationRelease = { types: Record<string, VerificationReleaseType> };

export type VerificationSnapshot = {
  accountId: string;
  verificationRequest: AgentVerificationRequest | null;
  viewerActions: AgentVerificationViewerAction[];
  subjectTitle: string | null;
};

export type VerificationAttempt = Readonly<
  {
    requestId: string | null;
    receipt: AgentVerificationRequest | null;
  } & ({ kind: 'request'; input: VerificationInput } | { kind: 'withdraw'; input: { idempotencyKey: string } })
>;

export type VerificationRecoveryState = {
  current: VerificationSnapshot | null;
  attempt: VerificationAttempt | null;
  phase: 'loading' | 'idle' | 'sending' | 'reading' | 'uncertain' | 'refused' | 'review' | 'unavailable';
  readStatus: 'idle' | 'reading' | 'success' | 'error';
  failure?: VerificationFailure | undefined;
  /** Captured once per response and scoped to the operation that received it. */
  readRetryAt: number;
  commandRetryAt: number;
};

export type VerificationRecoveryIO = {
  read: (accountId: string, signal?: AbortSignal) => Promise<VerificationSnapshot>;
  request: (accountId: string, input: VerificationInput, signal?: AbortSignal) => Promise<VerificationCommandResult>;
  withdraw: (
    accountId: string,
    input: { idempotencyKey: string },
    signal?: AbortSignal,
  ) => Promise<VerificationCommandResult>;
};

export type VerificationSubjectSearchFn = (
  query: string,
  signal: AbortSignal,
) => Promise<VerificationSearchResult<VerificationSubject[]>>;

export type VerificationTimerHandle = Readonly<{ cancel: () => void }>;

/** Presentation and request timers. Expiry never starts IO. */
export type VerificationTimer = Readonly<{
  schedule(callback: () => void, delayMs: number): VerificationTimerHandle;
}>;

/** Clock, identifier and timer. Settings composition supplies SettingsAmbient, which matches this shape. */
export type VerificationAmbient = Readonly<{
  now: () => number;
  id: () => string;
  timer: VerificationTimer;
}>;

export type VerificationSearchCopy = {
  unavailable(): string;
};

export type VerificationOperations = {
  status: (accountId: string, signal?: AbortSignal) => Promise<VerificationStatus>;
  request: (accountId: string, input: VerificationInput, signal?: AbortSignal) => Promise<VerificationCommandResult>;
  withdraw: (accountId: string, idempotencyKey: string, signal?: AbortSignal) => Promise<VerificationCommandResult>;
  eligibility: (signal?: AbortSignal) => Promise<VerificationRelease>;
  title: (subjectId: string, languages: string[], signal?: AbortSignal) => Promise<string | null>;
  suggest: (query: string, languages: string[], signal?: AbortSignal) => Promise<VerificationSuggestionHit[]>;
};

export type VerificationEligibleSearchCopy = {
  person: string;
  organization: string;
};

export class VerificationReadError extends Error {
  constructor(readonly failure: VerificationFailure) {
    super(failure.message);
    this.name = 'VerificationReadError';
  }
}

/** Keep the existing snapshot-or-thrown-error read contract at the caller boundary. */
export function unwrapVerificationRead<T>(result: VerificationReadResult<T>): T {
  if (!result.ok) throw new VerificationReadError(result.failure);
  return result.value;
}

export function verificationQueryKey(accountId: string | null | undefined) {
  return ['settings', 'verification', accountId ?? null] as const;
}
