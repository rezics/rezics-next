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
const privacy = 'a1791cd1749c6de420d60d74470456a23d3283b2831bdbf5386ddc121f09824a';
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
