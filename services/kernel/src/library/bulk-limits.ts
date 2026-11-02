/** Maximum explicit subject or occurrence IDs accepted by one bulk command. */
export const BULK_MAX_SELECTION_IDS = 1_000;

/** A 1,000-ID UUID list is about 53 KiB; this leaves bounded room for its envelope and filters. */
export const BULK_ADMISSION_BODY_BYTES = 64 * 1024;
