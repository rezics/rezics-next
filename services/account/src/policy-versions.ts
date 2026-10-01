export type PolicyVersion = Readonly<{
  policyId: 'terms' | 'privacy';
  source: `docs/legal/${string}.md`;
  effectiveDate: string;
  versionDigest: string;
  /** Material changes remove old digests; editorial updates may retain them. */
  acceptanceDigests: readonly string[];
}>;

// These identify the repository drafts, not counsel approval or launch readiness.
// G-736 checks the digest against the text it publishes; do not embed that text.
const terms = '7ec866bc49919daac7be37e4a3876554803c60e33bc2a3ba74596bbc4186ef2e';
const privacy = 'b5e2f1e780965e8b90a07626b6ffb509b4355c79bb5c6206a3727a6537e770a7';
export const POLICY_VERSIONS = [
  {
    policyId: 'terms',
    source: 'docs/legal/terms-of-service.md',
    effectiveDate: '2026-10-01',
    versionDigest: terms,
    acceptanceDigests: [terms],
  },
  {
    policyId: 'privacy',
    source: 'docs/legal/privacy-policy.md',
    effectiveDate: '2026-10-01',
    versionDigest: privacy,
    acceptanceDigests: [privacy],
  },
] as const satisfies readonly PolicyVersion[];
