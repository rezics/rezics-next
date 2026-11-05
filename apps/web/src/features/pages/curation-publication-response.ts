const PROFILE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isCanonicalProfileDigest(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_DIGEST.exec(value)?.[0] === value;
}

/** Native publish `{digest}` bound to the submitted profile. Extra JSON fields are ignored. */
export function admittedPublishDigest(data: unknown, expected: string): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const digest = (data as { digest?: unknown }).digest;
  return isCanonicalProfileDigest(digest) && digest === expected ? digest : undefined;
}

/** Native activate `{digest,head}` bound to the submitted profile. Head is a nonnegative safe integer. */
export function admittedActivationResult(
  data: unknown,
  expected: string,
): { digest: string; head: number } | undefined {
  if (!admittedPublishDigest(data, expected) || !data || typeof data !== 'object') return undefined;
  const head = (data as { head?: unknown }).head;
  return Number.isSafeInteger(head) && (head as number) >= 0 ? { digest: expected, head: head as number } : undefined;
}
