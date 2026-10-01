import type { PolicyAcceptance } from '../api/client.ts';
import { safeReturnPath } from '../api/oauth-query.ts';

/** One policy a person accepts: the exact version Account records an acceptance of. */
export interface PolicyVersion {
  policyId: PolicyAcceptance['policyId'];
  /** Repository path of the text, e.g. `docs/legal/terms-of-service.md`. */
  source: string;
  effectiveDate: string;
  versionDigest: string;
}
export interface PolicyStatus {
  policies: PolicyVersion[];
  /** Whether the signed-in visitor has not yet accepted every current version. */
  acceptanceRequired: boolean;
}

const ids = new Set<string>(['terms', 'privacy']);

/** Account's `GET /api/account/policies`, or null for any other shape. */
export function parsePolicyStatus(value: unknown): PolicyStatus | null {
  const body = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  if (typeof body.acceptanceRequired !== 'boolean' || !Array.isArray(body.policies)) return null;
  const policies: PolicyVersion[] = [];
  for (const item of body.policies as unknown[]) {
    const policy = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    if (typeof policy.policyId !== 'string' || !ids.has(policy.policyId)
      || typeof policy.source !== 'string' || typeof policy.effectiveDate !== 'string'
      || typeof policy.versionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.versionDigest)) return null;
    policies.push({ policyId: policy.policyId as PolicyVersion['policyId'], source: policy.source,
      effectiveDate: policy.effectiveDate, versionDigest: policy.versionDigest });
  }
  return policies.length ? { policies, acceptanceRequired: body.acceptanceRequired } : null;
}

/** What the sign-up request and the acceptance request send: the displayed versions, nothing else. */
export const acceptances = (policies: readonly PolicyVersion[]): PolicyAcceptance[] =>
  policies.map(({ policyId, versionDigest }) => ({ policyId, versionDigest }));

/** The policy's page on the about site, in the reader's locale (it publishes `legal/<policy id>`). */
export const policyHref = (aboutOrigin: string, locale: string, policyId: PolicyVersion['policyId']) =>
  `${aboutOrigin.replace(/\/$/, '')}/${locale}/legal/${policyId}/`;

/** The one place a refusal's minimum age and the region it applied to are named for the person. */
export function regionName(country: string | null | undefined, locale: string): string | null {
  if (!country || !/^[A-Z]{2}$/.test(country) || country === 'XX') return null;
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(country) ?? null; } catch { return null; }
}

/** Where acceptance resumes: only a refused authorization request, never an arbitrary path. */
export function acceptanceContinuation(value: string | null | undefined): string {
  const path = safeReturnPath(value);
  return /^\/(?:api\/auth\/)?oauth2\/authorize\?/.test(path) ? path : '/';
}
