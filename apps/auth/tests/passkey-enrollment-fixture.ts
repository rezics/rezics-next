/** Pinned native creation output, with no credentials yet excluded. */
export function enrollmentOptionsFixture() {
  return {
    challenge: 'Y2hhbGxlbmdl',
    rp: { id: 'auth.test', name: 'REZICS' },
    user: { id: 'YWNjb3VudA', name: 'reader', displayName: 'Reader' },
    pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key', alg })),
    timeout: 60000,
    attestation: 'none',
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { credProps: true },
    hints: [],
  };
}
