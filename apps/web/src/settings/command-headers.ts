/** Encode the original semantic key as a native Structured Field string only at the HTTP boundary. */
export function settingsCommandKeyHeader(idempotencyKey: string): string {
  return JSON.stringify(idempotencyKey);
}
