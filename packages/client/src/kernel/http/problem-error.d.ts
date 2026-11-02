export declare const PROBLEM_TYPE_BASE = "https://rezics.com/problems/";
export declare const PROBLEMS: {
    readonly invalid_request: {
        readonly status: 400;
        readonly title: 'Invalid Request';
        readonly retryable: false;
    };
    readonly invalid_source_record_metadata: {
        readonly status: 422;
        readonly title: 'Invalid Source Record Metadata';
        readonly retryable: false;
    };
    readonly source_record_metadata_conflict: {
        readonly status: 409;
        readonly title: 'Source Record Metadata Conflict';
        readonly retryable: false;
    };
    readonly invalid_argument: {
        readonly status: 400;
        readonly title: 'Invalid Argument';
        readonly retryable: false;
    };
    readonly precondition_failed: {
        readonly status: 412;
        readonly title: 'Precondition Failed';
        readonly retryable: false;
    };
    readonly content_too_large: {
        readonly status: 413;
        readonly title: 'Content Too Large';
        readonly retryable: false;
    };
    readonly invalid_signature: {
        readonly status: 400;
        readonly title: 'Invalid Signature';
        readonly retryable: false;
    };
    readonly idempotency_conflict: {
        readonly status: 422;
        readonly title: 'Idempotency Key Reused';
        readonly retryable: false;
    };
    readonly command_result_erased: {
        readonly status: 410;
        readonly title: 'Command Result Erased';
        readonly retryable: false;
    };
    readonly too_many_events: {
        readonly status: 422;
        readonly title: 'Too Many Events';
        readonly retryable: false;
    };
    readonly unsupported_library_profile: {
        readonly status: 422;
        readonly title: 'Unsupported Library Profile';
        readonly retryable: false;
    };
    readonly authentication_required: {
        readonly status: 401;
        readonly title: 'Authentication Required';
        readonly retryable: false;
    };
    readonly invalid_credentials: {
        readonly status: 401;
        readonly title: 'Invalid Credentials';
        readonly retryable: false;
    };
    readonly account_suspended: {
        readonly status: 403;
        readonly title: 'Account Suspended';
        readonly retryable: false;
    };
    readonly forbidden: {
        readonly status: 403;
        readonly title: 'Forbidden';
        readonly retryable: false;
    };
    readonly platform_closed: {
        readonly status: 403;
        readonly title: 'Platform Closed';
        readonly retryable: false;
    };
    readonly stale_editorial_head: {
        readonly status: 409;
        readonly title: 'Stale Editorial Head';
        readonly retryable: false;
    };
    readonly offer_unavailable: {
        readonly status: 409;
        readonly title: 'Offer Unavailable';
        readonly retryable: false;
    };
    readonly benefit_already_owned: {
        readonly status: 409;
        readonly title: 'Benefit Already Owned';
        readonly retryable: false;
    };
    readonly acquisition_pending: {
        readonly status: 409;
        readonly title: 'Acquisition Pending';
        readonly retryable: false;
    };
    readonly offer_revision_conflict: {
        readonly status: 409;
        readonly title: 'Offer Terms Changed';
        readonly retryable: false;
    };
    readonly media_unavailable: {
        readonly status: 409;
        readonly title: 'Media Unavailable';
        readonly retryable: false;
    };
    readonly invalid_cursor: {
        readonly status: 400;
        readonly title: 'Invalid Cursor';
        readonly retryable: false;
    };
    readonly stale_cursor: {
        readonly status: 409;
        readonly title: 'Stale Cursor';
        readonly retryable: false;
    };
    readonly copy_restore_stale: {
        readonly status: 409;
        readonly title: 'Copy Restore Stale';
        readonly retryable: false;
    };
    readonly copy_restore_occupied: {
        readonly status: 409;
        readonly title: 'Copy Restore Occupied';
        readonly retryable: false;
    };
    readonly copy_restore_expired: {
        readonly status: 409;
        readonly title: 'Copy Restore Expired';
        readonly retryable: false;
    };
    readonly conflict: {
        readonly status: 409;
        readonly title: 'Conflict';
        readonly retryable: false;
    };
    readonly realm_last_owner: {
        readonly status: 409;
        readonly title: 'Realm Ownership Transfer Required';
        readonly retryable: false;
    };
    readonly library_label_restore_stale: {
        readonly status: 409;
        readonly title: 'Stale Library Label Restore';
        readonly retryable: false;
    };
    readonly library_label_restore_expired: {
        readonly status: 409;
        readonly title: 'Library Label Restore Expired';
        readonly retryable: false;
    };
    readonly library_label_restore_occupied: {
        readonly status: 409;
        readonly title: 'Library Label Restore Occupied';
        readonly retryable: false;
    };
    readonly library_label_restore_capacity: {
        readonly status: 409;
        readonly title: 'Library Label Restore Capacity Reached';
        readonly retryable: false;
    };
    readonly published_log_restore_stale: {
        readonly status: 409;
        readonly title: 'Stale Published Log Restore';
        readonly retryable: false;
    };
    readonly published_log_restore_occupied: {
        readonly status: 409;
        readonly title: 'Published Log Restore Occupied';
        readonly retryable: false;
    };
    readonly published_log_restore_expired: {
        readonly status: 409;
        readonly title: 'Published Log Restore Expired';
        readonly retryable: false;
    };
    readonly dynamic_membership_immutable: {
        readonly status: 409;
        readonly title: 'Dynamic Membership Immutable';
        readonly retryable: false;
    };
    readonly collection_full: {
        readonly status: 409;
        readonly title: 'Collection Full';
        readonly retryable: false;
    };
    readonly collection_move_unsupported: {
        readonly status: 409;
        readonly title: 'Moving Between Different Curators Is Unsupported';
        readonly retryable: false;
    };
    readonly member_restore_stale: {
        readonly status: 409;
        readonly title: 'Collection Member Restore Stale';
        readonly retryable: false;
    };
    readonly member_restore_occupied: {
        readonly status: 409;
        readonly title: 'Collection Member Placement Occupied';
        readonly retryable: false;
    };
    readonly member_restore_expired: {
        readonly status: 409;
        readonly title: 'Collection Member Restore Expired';
        readonly retryable: false;
    };
    readonly library_entry_restore_occupied: {
        readonly status: 409;
        readonly title: 'Library Entry Restore Occupied';
        readonly retryable: false;
    };
    readonly library_entry_restore_stale: {
        readonly status: 409;
        readonly title: 'Library Entry Restore Stale';
        readonly retryable: false;
    };
    readonly library_entry_restore_expired: {
        readonly status: 409;
        readonly title: 'Library Entry Restore Expired';
        readonly retryable: false;
    };
    readonly collection_restore_occupied: {
        readonly status: 409;
        readonly title: 'Collection Restore Occupied';
        readonly retryable: false;
    };
    readonly collection_restore_stale: {
        readonly status: 409;
        readonly title: 'Stale Collection Restore';
        readonly retryable: false;
    };
    readonly collection_restore_expired: {
        readonly status: 409;
        readonly title: 'Collection Restore Expired';
        readonly retryable: false;
    };
    readonly library_label_capacity: {
        readonly status: 409;
        readonly title: 'Library Label Capacity Reached';
        readonly retryable: false;
    };
    readonly semantic_not_ready: {
        readonly status: 503;
        readonly title: 'Semantic Layer Not Ready';
        readonly retryable: true;
    };
    readonly presentation_not_ready: {
        readonly status: 503;
        readonly title: 'Presentation Not Ready';
        readonly retryable: true;
    };
    readonly not_found: {
        readonly status: 404;
        readonly title: 'Not Found';
        readonly retryable: false;
    };
    readonly internal_error: {
        readonly status: 500;
        readonly title: 'Internal Server Error';
        readonly retryable: false;
    };
    readonly overloaded: {
        readonly status: 503;
        readonly title: 'Service Overloaded';
        readonly retryable: true;
    };
    readonly partition_unavailable: {
        readonly status: 503;
        readonly title: 'Partition Unavailable';
        readonly retryable: true;
    };
    readonly transaction_retry_exhausted: {
        readonly status: 503;
        readonly title: 'Transaction Retry Exhausted';
        readonly retryable: true;
    };
    readonly deadline_exceeded: {
        readonly status: 503;
        readonly title: 'Deadline Exceeded';
        readonly retryable: true;
    };
    readonly dependency_unavailable: {
        readonly status: 503;
        readonly title: 'Dependency Unavailable';
        readonly retryable: true;
    };
    readonly rate_limited: {
        readonly status: 429;
        readonly title: 'Request Budget Exhausted';
        readonly retryable: true;
    };
    readonly rate_limit_unavailable: {
        readonly status: 503;
        readonly title: 'Request Budget Unavailable';
        readonly retryable: true;
    };
    readonly index_not_ready: {
        readonly status: 503;
        readonly title: 'Search Index Not Ready';
        readonly retryable: true;
    };
    readonly search_restart_required: {
        readonly status: 409;
        readonly title: 'Search Restart Required';
        readonly retryable: false;
    };
    readonly unsupported_query: {
        readonly status: 422;
        readonly title: 'Unsupported Query';
        readonly retryable: false;
    };
};
export type ProblemCode = keyof typeof PROBLEMS;
export type FieldErrorCode = 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported';
export type FieldError = {
    pointer: string;
    code: FieldErrorCode;
};
export declare function truncateDetail(detail: string): string;
export declare class ProblemError extends Error {
    readonly code: ProblemCode;
    readonly detail: string | undefined;
    readonly errors: readonly FieldError[] | undefined;
    readonly headers: Record<string, string> | undefined;
    readonly extensions: Readonly<Record<string, unknown>> | undefined;
    readonly effectStatus: 'not_applicable' | 'not_applied' | undefined;
    constructor(code: ProblemCode, options?: {
        detail?: string;
        errors?: readonly FieldError[];
        headers?: Record<string, string>;
        effectStatus?: 'not_applicable' | 'not_applied';
        extensions?: Readonly<Record<string, unknown>>;
    });
}
