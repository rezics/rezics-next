/** Main's body-bearing reads have no admitted write or receipt effect. Keep
 * this list explicit: an Idempotency-Key alone never licenses an automatic retry. */
export function mainBodyRead(path: string, method?: string): boolean {
  return (
    method?.toUpperCase() === 'POST' &&
    [
      '/v1/query',
      '/v1/resources/summaries',
      '/v1/governance/rule-queries',
      '/v1/media/metadata',
      '/v1/suitability/reads',
    ].includes(path)
  );
}
