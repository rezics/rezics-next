export declare const ACCESS_EVIDENCE_TTL_MS = 1000;
/** Evidence is live only for the caller's request and its short real-time TTL. */
export declare function accessEvidenceDeadline(requestDeadline: number, ttlMs?: number): number;
