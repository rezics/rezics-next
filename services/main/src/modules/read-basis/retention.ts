/** A continuation's expiry is fixed by its first page, never renewed by use.
 * Discovery keeps immutable rows through this window plus one read deadline;
 * live graph/Access checks still decide which fields may be disclosed. */
export const READ_BASIS_RETENTION_MS = 5 * 60_000;
