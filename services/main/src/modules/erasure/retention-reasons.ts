/** Authored physical-retention explanations contain no private hold or case basis. */
export const CONTENT_LIVE_RETENTION =
  'PostgreSQL keeps prior row versions and WAL until a qualified rewrite and WAL recycling';
export const GRAPH_LIVE_RETENTION =
  'TDB2 and Lucene old filesets remain until a verified sanitized cutover and retirement';
export const ACCOUNT_LIVE_RETENTION =
  'Account PostgreSQL keeps prior credential row versions and WAL until a qualified rewrite';
export const CONTENT_UPLOAD_RETENTION =
  'Content PostgreSQL keeps prior private upload row versions and WAL until a qualified rewrite';
export const GRAPH_COPY_RETENTION = {
  snapshot: 'Snapshot destruction evidence is required',
  backup: 'Backup destruction evidence is required',
  media: 'Media destruction evidence is required',
} as const;

const publicReasons = new Set<string>([CONTENT_LIVE_RETENTION, GRAPH_LIVE_RETENTION,
  ACCOUNT_LIVE_RETENTION, CONTENT_UPLOAD_RETENTION, ...Object.values(GRAPH_COPY_RETENTION)]);

/** Unknown journal prose may contain a confidential preservation basis. */
export function publicRetentionReason(reason: string | null): string | null {
  return reason === null || publicReasons.has(reason) ? reason : 'Copy destruction requires verification';
}
