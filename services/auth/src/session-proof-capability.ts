import type { AccessTokenClaims, SessionProof, VerifierConfiguration } from './index.ts';

/** The single native API JWT dialect, shared by HTTP and trusted live-proof issuance. */
export function signSessionAccessToken(
  signer: { sign(claims: AccessTokenClaims): Promise<string> },
  verifier: Pick<VerifierConfiguration, 'issuer' | 'audience'>,
  proof: SessionProof,
  expiresAt = Infinity,
  requestedBy?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signer.sign({
    iss: verifier.issuer,
    aud: verifier.audience,
    sub: proof.account_id,
    client_id: proof.client_id,
    scope: proof.scope.join(' '),
    authn_epoch: proof.authn_epoch,
    iat: now,
    exp: Math.min(now + 300, Math.floor(expiresAt / 1000)),
    auth_time: proof.auth_time,
    amr: proof.amr,
    ...(requestedBy === undefined ? {} : { requested_by: requestedBy }),
  });
}
