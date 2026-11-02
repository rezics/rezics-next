/** Maximum explicit subject or occurrence IDs accepted by one bulk command. */
export declare const BULK_MAX_SELECTION_IDS = 1000;
/** A 1,000-ID UUID list is about 53 KiB; this leaves bounded room for its envelope and filters. */
export declare const BULK_ADMISSION_BODY_BYTES: number;
