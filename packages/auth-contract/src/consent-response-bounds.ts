/** Fixed public consent-review projection; independent of the Security catalogue. */
export const CONSENT_PAGE_MAX_SCOPES = 1000;
export const CONSENT_PAGE_MAX_SCOPE_LENGTH = 128;
export const CONSENT_PAGE_MAX_SCOPE_QUERY_BYTES = 8192;
export const CONSENT_PAGE_MAX_ID_LENGTH = 1024;
export const CONSENT_PAGE_MAX_DISPLAY_NAME_LENGTH = 100;
export const CONSENT_PAGE_MAX_EMAIL_LENGTH = 254;

export type ConsentPageResponse = {
  client_id: string;
  display_name: string | null;
  scopes: string[];
  requested: string[];
  granted: string[];
  pending_reduction: boolean;
  acting_account: { account_id: string; email: string | null };
  decisions: { allow: boolean; decline: boolean; switch_account: boolean };
};

/** Closed acknowledgement returned only to reviewed browser Allow submissions. */
export type ReviewedConsentDecisionResponse = Readonly<{
  account_id: string;
  client_id: string;
  requested: string[];
  /** Exact submitted union of current grants and requested registered scopes. */
  scope: string[];
}>;

/** Closed native refusal bodies consumed by the reviewed Allow transport. */
export type ConsentDecisionErrorResponse =
  | Readonly<{ error: 'authentication_denied' }>
  | Readonly<{ error: 'authentication_denied'; code: 'stale_review' }>
  | Readonly<{ error: 'step_up_required'; effect_status: 'not_applied' }>
  | Readonly<{ error: 'account_suspended'; code: 'ACCOUNT_SUSPENDED' }>;

// The empty-string/array skeleton accounts for every key, quote and punctuation.
// pending=false + allow=true costs the same as pending=true + allow=false.
const skeleton: ConsentPageResponse = {
  client_id: '',
  display_name: '',
  scopes: [],
  requested: [],
  granted: [],
  pending_reduction: false,
  acting_account: { account_id: '', email: '' },
  decisions: { allow: true, decline: true, switch_account: true },
};
// Six bytes per UTF-16 unit covers JSON escapes (including lone surrogates),
// ASCII and UTF-8. This conservatively overcounts email syntax and nonescaped
// text. Nullable fields cost less than their maximal non-null strings.
const textBytes =
  6 * (2 * CONSENT_PAGE_MAX_ID_LENGTH + CONSENT_PAGE_MAX_DISPLAY_NAME_LENGTH + CONSENT_PAGE_MAX_EMAIL_LENGTH);
// OAuth scope characters are ASCII and exclude both quote and backslash. Each
// entry adds two quotes and one comma, except the last has no comma. All three
// arrays may coexist at their count/length ceilings in the native projection.
// The GET query's additional 8192-byte limit only reduces requested's size.
const scopeArrayBytes = CONSENT_PAGE_MAX_SCOPES * (CONSENT_PAGE_MAX_SCOPE_LENGTH + 3) - 1;
export const CONSENT_PAGE_MAX_RESPONSE_BYTES = JSON.stringify(skeleton).length + textBytes + 3 * scopeArrayBytes;

const decisionSkeleton: ReviewedConsentDecisionResponse = {
  account_id: '',
  client_id: '',
  requested: [],
  scope: [],
};
// The acknowledgement contains two independently bounded IDs and both arrays:
// requested can be unknown while the submitted union is already fully granted.
export const CONSENT_DECISION_MAX_RESPONSE_BYTES =
  JSON.stringify(decisionSkeleton).length + 12 * CONSENT_PAGE_MAX_ID_LENGTH + 2 * scopeArrayBytes;

// Native consent GET errors are {error:'authentication_denied'}, with code only
// for stale review. No arbitrary message/header participates in this allowance.
export const CONSENT_PAGE_MAX_ERROR_BYTES = JSON.stringify({
  error: 'authentication_denied',
  code: 'stale_review',
}).length;

const decisionErrors: readonly ConsentDecisionErrorResponse[] = [
  { error: 'authentication_denied' },
  { error: 'authentication_denied', code: 'stale_review' },
  { error: 'step_up_required', effect_status: 'not_applied' },
  { error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' },
];
export const CONSENT_DECISION_MAX_ERROR_BYTES = Math.max(...decisionErrors.map((body) => JSON.stringify(body).length));

/** Native-compatible reduction acknowledgement; reviewed Allow has its own DTO. */
export type ConsentReductionResponse = Readonly<{ client_id: string; scope: string[] }>;
export type ConsentReductionErrorResponse = ConsentDecisionErrorResponse;
// Empty keys/punctuation + one maximally escaped ID + one OAuth scope array.
export const CONSENT_REDUCTION_MAX_RESPONSE_BYTES =
  JSON.stringify({ client_id: '', scope: [] }).length + 6 * CONSENT_PAGE_MAX_ID_LENGTH + scopeArrayBytes;
export const CONSENT_REDUCTION_MAX_ERROR_BYTES = CONSENT_DECISION_MAX_ERROR_BYTES;
