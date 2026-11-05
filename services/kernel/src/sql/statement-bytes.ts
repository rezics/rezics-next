/** Detached SQL text reserves a bounded sqlcommenter tag when its source metadata is unavailable. */
export const SQL_COMMENT_BYTE_BOUND = 512;

/** Upper bound for SQL sent by Reylo, including the comment omitted from `.sql` in 0.7.0. */
export function statementBytes(statement: string | { sql: string; source?: string | undefined }): number {
  if (typeof statement === 'string') return Buffer.byteLength(statement) + SQL_COMMENT_BYTE_BOUND;
  const source = statement.source;
  const comment = source ? Buffer.byteLength(` /*file='${encodeURIComponent(source).replace(/'/g, "\\'")}'*/`) : SQL_COMMENT_BYTE_BOUND;
  return Buffer.byteLength(statement.sql) + comment;
}
