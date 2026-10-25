import type { Pool } from 'pg';
import type { JWK } from 'jose';

export interface AccessAccount {
  accountId: string;
  kind: 'actor' | 'organization';
  state: 'pending' | 'active' | 'suspended' | 'deleted';
  authnEpoch: number;
  automated: boolean;
}

/** Internal application ports. Never construct these results from HTTP fields. */
export interface TrustedAccessPorts {
  readAccount(accountId: string): Promise<AccessAccount | null>;
  authorizeProvisioning(commandReference: string): Promise<{ accountId: string }>;
}

export interface AuthServiceOptions {
  database: Pool;
  issuer: string;
  audience: string;
  secret: string;
  signing: { activeKid: string; privateKeys: JWK[] };
  trustedAccess: TrustedAccessPorts;
}

export interface SessionProof {
  account_id: string;
  client_id: string;
  scope: string[];
  authn_epoch: number;
  auth_time: number;
  amr: string[];
}

export interface AccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  authn_epoch: number;
  iat: number;
  exp: number;
  auth_time: number;
  amr: string[];
  requested_by?: string;
}

export interface VerifierConfiguration {
  issuer: string;
  audience: string;
  jwksUrl: string;
  algorithms: ['ES256'];
  accessTokenLifetimeSeconds: 300;
}

export interface AuthService {
  handler(request: Request): Promise<Response>;
  verifier: VerifierConfiguration;
  internal: {
    provisionPassword(input: {
      authorization: string;
      email: string;
      password: string;
    }): Promise<{ accountId: string }>;
    revokeSessions(accountId: string): Promise<void>;
    registerClient(input: { clientId: string; firstParty: boolean; scopes: string[] }): Promise<void>;
  };
}

export async function createAuthService(_options: AuthServiceOptions): Promise<AuthService> {
  throw new Error('Auth foundation is not implemented');
}
