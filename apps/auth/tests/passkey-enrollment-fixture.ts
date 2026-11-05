/** Pinned native creation output, with no credentials yet excluded. */
export function enrollmentOptionsFixture() {
  return {
    challenge: 'a'.repeat(42) + 'A',
    rp: { id: 'auth.test', name: 'REZICS' },
    user: { id: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE', name: 'reader', displayName: 'Reader' },
    pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key', alg })),
    timeout: 60000,
    attestation: 'none',
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { credProps: true },
    hints: [],
  };
}
