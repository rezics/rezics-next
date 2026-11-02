// Error identities must initialize without loading native commands or HTTP handlers.
export const PROBLEM_TYPE_BASE = 'https://rezics.com/problems/';

export const PROBLEMS = {
  invalid_request: { status: 400, title: 'Invalid Request', retryable: false },
  invalid_source_record_metadata: { status: 422, title: 'Invalid Source Record Metadata', retryable: false },
  source_record_metadata_conflict: { status: 409, title: 'Source Record Metadata Conflict', retryable: false },
  invalid_argument: { status: 400, title: 'Invalid Argument', retryable: false },
  precondition_failed: { status: 412, title: 'Precondition Failed', retryable: false },
  content_too_large: { status: 413, title: 'Content Too Large', retryable: false },
  invalid_signature: { status: 400, title: 'Invalid Signature', retryable: false },
  idempotency_conflict: { status: 422, title: 'Idempotency Key Reused', retryable: false },
  command_result_erased: { status: 410, title: 'Command Result Erased', retryable: false },
  too_many_events: { status: 422, title: 'Too Many Events', retryable: false },
  unsupported_library_profile: { status: 422, title: 'Unsupported Library Profile', retryable: false },
  authentication_required: { status: 401, title: 'Authentication Required', retryable: false },
  invalid_credentials: { status: 401, title: 'Invalid Credentials', retryable: false },
  account_suspended: { status: 403, title: 'Account Suspended', retryable: false },
  forbidden: { status: 403, title: 'Forbidden', retryable: false },
  platform_closed: { status: 403, title: 'Platform Closed', retryable: false },
  stale_editorial_head: { status: 409, title: 'Stale Editorial Head', retryable: false },
  offer_unavailable: { status: 409, title: 'Offer Unavailable', retryable: false },
  benefit_already_owned: { status: 409, title: 'Benefit Already Owned', retryable: false },
  acquisition_pending: { status: 409, title: 'Acquisition Pending', retryable: false },
  offer_revision_conflict: { status: 409, title: 'Offer Terms Changed', retryable: false },
  media_unavailable: { status: 409, title: 'Media Unavailable', retryable: false },
  invalid_cursor: { status: 400, title: 'Invalid Cursor', retryable: false },
  stale_cursor: { status: 409, title: 'Stale Cursor', retryable: false },
  copy_restore_stale: { status: 409, title: 'Copy Restore Stale', retryable: false },
  copy_restore_occupied: { status: 409, title: 'Copy Restore Occupied', retryable: false },
  copy_restore_expired: { status: 409, title: 'Copy Restore Expired', retryable: false },
  conflict: { status: 409, title: 'Conflict', retryable: false },
  realm_last_owner: { status: 409, title: 'Realm Ownership Transfer Required', retryable: false },
  library_label_restore_stale: { status: 409, title: 'Stale Library Label Restore', retryable: false },
  library_label_restore_expired: { status: 409, title: 'Library Label Restore Expired', retryable: false },
  library_label_restore_occupied: { status: 409, title: 'Library Label Restore Occupied', retryable: false },
  library_label_restore_capacity: { status: 409, title: 'Library Label Restore Capacity Reached', retryable: false },
  published_log_restore_stale: { status: 409, title: 'Stale Published Log Restore', retryable: false },
  published_log_restore_occupied: { status: 409, title: 'Published Log Restore Occupied', retryable: false },
  published_log_restore_expired: { status: 409, title: 'Published Log Restore Expired', retryable: false },
  dynamic_membership_immutable: { status: 409, title: 'Dynamic Membership Immutable', retryable: false },
  collection_full: { status: 409, title: 'Collection Full', retryable: false },
  collection_move_unsupported: {
    status: 409,
    title: 'Moving Between Different Curators Is Unsupported',
    retryable: false,
  },
  member_restore_stale: { status: 409, title: 'Collection Member Restore Stale', retryable: false },
  member_restore_occupied: { status: 409, title: 'Collection Member Placement Occupied', retryable: false },
  member_restore_expired: { status: 409, title: 'Collection Member Restore Expired', retryable: false },
  library_entry_restore_occupied: {
    status: 409,
    title: 'Library Entry Restore Occupied',
    retryable: false,
  },
  library_entry_restore_stale: {
    status: 409,
    title: 'Library Entry Restore Stale',
    retryable: false,
  },
  library_entry_restore_expired: {
    status: 409,
    title: 'Library Entry Restore Expired',
    retryable: false,
  },
  collection_restore_occupied: { status: 409, title: 'Collection Restore Occupied', retryable: false },
  collection_restore_stale: { status: 409, title: 'Stale Collection Restore', retryable: false },
  collection_restore_expired: { status: 409, title: 'Collection Restore Expired', retryable: false },
  library_label_capacity: { status: 409, title: 'Library Label Capacity Reached', retryable: false },
  semantic_not_ready: { status: 503, title: 'Semantic Layer Not Ready', retryable: true },
  presentation_not_ready: { status: 503, title: 'Presentation Not Ready', retryable: true },
  not_found: { status: 404, title: 'Not Found', retryable: false },
  internal_error: { status: 500, title: 'Internal Server Error', retryable: false },
  overloaded: { status: 503, title: 'Service Overloaded', retryable: true },
  partition_unavailable: { status: 503, title: 'Partition Unavailable', retryable: true },
  transaction_retry_exhausted: { status: 503, title: 'Transaction Retry Exhausted', retryable: true },
  deadline_exceeded: { status: 503, title: 'Deadline Exceeded', retryable: true },
  dependency_unavailable: { status: 503, title: 'Dependency Unavailable', retryable: true },
  rate_limited: { status: 429, title: 'Request Budget Exhausted', retryable: true },
  rate_limit_unavailable: { status: 503, title: 'Request Budget Unavailable', retryable: true },
  index_not_ready: { status: 503, title: 'Search Index Not Ready', retryable: true },
  search_restart_required: { status: 409, title: 'Search Restart Required', retryable: false },
  unsupported_query: { status: 422, title: 'Unsupported Query', retryable: false },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;
export type FieldErrorCode =
  | 'required'
  | 'unknown_field'
  | 'invalid_type'
  | 'invalid_format'
  | 'out_of_range'
  | 'unsupported';
export type FieldError = { pointer: string; code: FieldErrorCode };

export function truncateDetail(detail: string): string {
  let result = '';
  let length = 0;
  for (const character of detail) {
    if (length === 512) break;
    result += character;
    length++;
  }
  return result;
}

export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly detail: string | undefined;
  readonly errors: readonly FieldError[] | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly extensions: Readonly<Record<string, unknown>> | undefined;
  readonly effectStatus: 'not_applicable' | 'not_applied' | undefined;

  constructor(
    code: ProblemCode,
    options: {
      detail?: string;
      errors?: readonly FieldError[];
      headers?: Record<string, string>;
      effectStatus?: 'not_applicable' | 'not_applied';
      extensions?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(options.detail ?? PROBLEMS[code].title);
    this.name = 'ProblemError';
    this.code = code;
    this.detail = options.detail === undefined ? undefined : truncateDetail(options.detail);
    this.errors = options.errors;
    this.headers = options.headers;
    this.effectStatus = options.effectStatus;
    this.extensions = options.extensions;
  }
}
