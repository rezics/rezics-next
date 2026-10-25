import type { Pool } from 'pg';
import { buildAuthService } from './service.ts';
import type { JWK } from 'jose';
export { createAccountWorkflows } from './workflows.ts';
export type {
  AccountWorkflowOptions,
  AccountWorkflowPorts,
  AccountOperation,
  RegistrationReference,
  WorkflowHandleTransition,
  WorkflowFence,
  WorkflowMembership,
  WorkflowResponsibility,
  WorkflowAccount,
} from './workflows.ts';

export interface AccessAccount {
  accountId: string;
  kind: 'actor' | 'organization';
  state: 'pending' | 'active' | 'suspended' | 'deleted';
  authnEpoch: number;
  automated: boolean;
  fenced?: boolean;
}

export interface InvalidationReceipt {
  receiptId: string;
  accountId: string;
  minimumAuthnEpoch: number;
}

export type EffectPurpose = 'session' | 'set-password' | 'remove-password' | 'add-key' | 'remove-key';

/** A consumed durable Access authorization, never a caller-supplied approval. */
export interface EffectAuthorization {
  receiptId: string;
  subjectAccountId: string;
  actingHumanId: string;
  operatorAccountId: string | null;
  purpose: EffectPurpose;
  clientId: string;
  scopes: string[];
  humanEpoch: number;
  subjectEpoch: number;
  expiresAt: string;
  invalidation?: InvalidationReceipt;
}

export type CredentialEffect =
  | { kind: 'password'; password: string | null }
  | { kind: 'key'; kid: string; publicJwk: JWK; remove?: false }
  | { kind: 'key'; kid: string; remove: true };

/** Internal application ports. Never construct these results from HTTP fields. */
export interface TrustedAccessPorts {
  readAccount(accountId: string): Promise<AccessAccount | null>;
  authorizeProvisioning(commandReference: string): Promise<{ accountId: string }>;
  /** Consume once while rechecking operator relationship, permission, epochs and client evidence. */
  consumeAuthorization?(input: {
    authorization: string;
    subjectAccountId: string;
    purpose: EffectPurpose;
    human: SessionProof;
  }): Promise<EffectAuthorization>;
  /** Commit a durable floor increase before returning; never clear an existing fence. */
  invalidateAccount?:
    | ((input: {
        accountId: string;
        previousEpoch: number;
        reason: 'consent-reduction';
      }) => Promise<InvalidationReceipt>)
    | undefined;
  /** Recovery-only authoritative read may expose a fenced active human's current floor. */
  readRecoveryAccount?(accountId: string): Promise<AccessAccount | null>;
  /** Reject a stale proof; commit an invalidation barrier without clearing any fence. */
  authorizeRecovery?(input: { accountId: string; proofEpoch: number }): Promise<InvalidationReceipt>;
}

export interface AuthServiceOptions {
  database: Pool;
  issuer: string;
  audience: string;
  secret: string;
  signing: { activeKid: string; privateKeys: JWK[] };
  trustedAccess: TrustedAccessPorts;
  recoveryDelivery?: {
    deliver(input: { accountId: string; email: string; token: string; expiresAt: Date }): Promise<void>;
  };
}

export interface SessionProof {
  account_id: string;
  client_id: string;
  scope: string[];
  authn_epoch: number;
  auth_time: number;
  amr: string[];
}

/** Public ES256 verification material; private JWK members are intentionally absent. */
export interface PublicJwks {
  keys: Array<{
    kty: 'EC';
    crv: 'P-256';
    x: string;
    y: string;
    kid: string;
    alg: 'ES256';
    use: 'sig';
  }>;
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
    /** One native expiry batch, at most 1000 rows; schedule through the shared worker. */
    pruneExpiredVerifications(): Promise<number>;
    provisionPassword(input: {
      authorization: string;
      email: string;
      password: string;
      idempotencyKey?: string;
    }): Promise<{ accountId: string }>;
    provisionCredentialless(input: { authorization: string }): Promise<{ accountId: string }>;
    /** The coordinator must commit Access tombstone/fence before erasure. */
    eraseAccount(accountId: string): Promise<void>;
    openAutomatedSession(input: {
      authorization: string;
      subjectAccountId: string;
      headers: Headers;
    }): Promise<Response>;
    setCredential(input: {
      authorization: string;
      subjectAccountId: string;
      headers: Headers;
      credential: CredentialEffect;
    }): Promise<void>;
    reduceConsent(input: {
      accountId: string;
      clientId: string;
      scopes: string[];
      barrier: InvalidationReceipt;
    }): Promise<void>;
    beginClientReduction(input: {
      clientId: string;
      operationId: string;
      scopes: string[];
      firstParty: boolean;
    }): Promise<void>;
    clientReductionPage(input: {
      clientId: string;
      operationId: string;
      after: string;
      limit: number;
    }): Promise<{ items: string[]; next: string | null }>;
    finishClientReduction(input: {
      clientId: string;
      operationId: string;
      scopes: string[];
      firstParty: boolean;
    }): Promise<void>;
    revokeSessions(accountId: string): Promise<void>;
    registerClient(input: { clientId: string; firstParty: boolean; scopes: string[] }): Promise<void>;
  };
}

export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  return buildAuthService(options);
}
