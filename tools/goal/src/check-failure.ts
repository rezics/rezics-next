/**
 * Transport and timeout signatures shared by the verifier and promotion. Callers keep their own retry
 * and verdict policy, including promotion's Bun per-test timeout exclusion and the verifier's
 * unavailable-command and truncated-output handling.
 */
export function isTransportTimeout(text: string): boolean {
  return /ETIMEDOUT|timed out|timeout while (?:starting|creating|setting up).*docker|(?:ssh|rsync).*?(?:exit(?:ed)? 255|code 255|status 255)/i.test(
    text,
  );
}

export function isPromotionInfrastructureText(text: string): boolean {
  // Bun reports a test that exceeds its own timeout as "this test timed out after Nms": that is a test failure.
  const cleaned = text.replace(/^.*\btest\b.*\btimed out after\b.*$/gim, '');
  return (
    isTransportTimeout(cleaned) ||
    /docker\s+(?:run\b|:).*?(?:failed|failure|error|exit(?:ed)?(?: with code)? [1-9])/i.test(cleaned)
  );
}
