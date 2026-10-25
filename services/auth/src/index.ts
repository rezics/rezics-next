export {
  createNativeWorkflowProofPorts,
  type NativeWorkflowProofPorts,
  type AutomatedCreationBinding,
} from './native-workflow-proofs.ts';
export { createBarrierProofVerifier, type BarrierProof } from './barrier-proofs.ts';
export { createRecoveryEstablishmentVerifier, type RecoveryEstablishmentEvidence } from './recovery-establishment.ts';
export { createProvisioningEvidenceVerifier } from './provisioning-evidence.ts';
export type {
  ProvisioningAuthorization,
  ProvisioningReceiptMetadata,
  ProvisioningEvidenceLocator,
  ProvisioningEvidenceReference,
  ProvisioningEvidence,
  ProvisioningResult,
} from './provisioning-evidence.ts';
import type { ProvisioningAuthorization, ProvisioningResult } from './provisioning-evidence.ts';
export {
  registerMembershipWorkflows,
  type MembershipWorkflowPorts,
  type MembershipWorkInput,
  type MembershipWorkResult,
} from './membership-workflows.ts';
import type { Pool } from 'pg';
import type { RecoveryEstablishmentEvidence } from './recovery-establishment.ts';
import { buildAuthService } from './service.ts';
export { WEBSITE_CLIENT_ID } from './website.ts';
import type { JWK } from 'jose';
import type { SessionTrim } from './session-limits.ts';
export { createAuthHost, AuthHostConfigurationError } from './host.ts';
export type { AuthHostOptions } from './host.ts';
export { SigningRotationPending } from './signing.ts';
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

/** Current, principal-created assignment evidence from the Access owner. */
export type AssignmentProof =
  | { kind: 'none' | 'unresolved' }
  | { kind: 'resolved'; principalId: string; assignedActorId: string; requestId: string; valid: string };

/** Internal application ports. Never construct these results from HTTP fields. */
export interface TrustedAccessPorts {
  readAccount(accountId: string): Promise<AccessAccount | null>;
  /** Private pending read bound to the exact verified native registration command. */
  readProvisioningAccount?(
    accountId: string,
    commandReference: string,
  ): Promise<(AccessAccount & { registrationId: string; expiresAt: string }) | null>;
  /** Bind Access readAssignment: checks provenance, actor, validity, revocation and principal state/fence. */
  readAssignment?(requestedBy: string, assignedActorId: string): Promise<AssignmentProof>;
  authorizeProvisioning(commandReference: string): Promise<ProvisioningAuthorization>;
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
        reason: 'consent-reduction' | 'session-revocation' | 'logout' | 'refresh-replay';
        proofReference?: string;
        operationKey?: string;
      }) => Promise<InvalidationReceipt>)
    | undefined;
  /** Recovery-only authoritative read may expose a fenced active human's current floor. */
  readRecoveryAccount?(accountId: string): Promise<AccessAccount | null>;
  /** Reject a stale proof; commit an invalidation barrier without clearing any fence. */
  authorizeRecovery?(input: {
    accountId: string;
    proofEpoch: number;
    proofReference?: string;
    operationKey?: string;
  }): Promise<InvalidationReceipt>;
  /** Trusted Auth-host composition only, after a successful native credential
   * transaction commits and releases its connection. The nonsecret locator
   * resolves to the actual Auth witness; Access authorizes the exact current
   * receipt/floor before execution or replay. HTTP success awaits completion. */
  completeRecovery?: (reference: string) => Promise<void>;
}

export interface AuthServiceOptions {
  database: Pool;
  issuer: string;
  audience: string;
  secret: string;
  signing: { activeKid: string; privateKeys: JWK[] };
  trustedAccess: TrustedAccessPorts;
  /** Trusted mounted x-action catalogue, supplied by production composition. */
  siteActions?: ReadonlyMap<string, { anonymous: boolean; replay?: 'self-account-read' }>;
  recoveryDelivery?: {
    deliver(input: { accountId: string; email: string; token: string; expiresAt: Date }): Promise<void>;
  };
}

export interface SigningState {
  generation: number;
  current: string | null;
  next: string | null;
  retiring: string | null;
}

/** Auth-only operational controls. Generation is a durable compare-and-swap token. */
export interface SigningControl {
  status(): Promise<SigningState>;
  stage(input: { expectedGeneration: number; key: JWK }): Promise<SigningState>;
  rotate(input: { expectedGeneration: number; kid: string }): Promise<SigningState>;
  prune(input: { expectedGeneration: number }): Promise<SigningState>;
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

export interface WebsiteClientRegistration {
  publicJwks: PublicJwks;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** Protocol scopes plus exact mounted site actions from the trusted catalogue. */
  scopes: string[];
}

export interface AuthService {
  handler(request: Request): Promise<Response>;
  verifier: VerifierConfiguration;
  internal: {
    /** Auth-owned read closure; composition receives no database or credential material. */
    resolveRecoveryEstablishment(reference: unknown): Promise<RecoveryEstablishmentEvidence | null>;
    /** Trusted server composition only; the exact native human proof is live only
     * during this instance's consumeAuthorization callback. Never persist it or its JWT. */
    accessTokenForProof(proof: SessionProof): Promise<string>;
    /** One native expiry batch, at most 1000 rows; scheduled by the Auth host. */
    pruneExpiredVerifications(): Promise<number>;
    /** Bounded maintenance; the host registers and schedules these ports. */
    pruneExpiredSessions(batch?: number): Promise<number>;
    /** One bounded batch per expired native OAuth/OIDC kind (tokens, refresh
     * families, client assertions, recent OIDC sessions); at most 1000 each. */
    pruneExpiredProtocolState(batch?: number): Promise<number>;
    trimSessionHistory(accountId: string, batch?: number): Promise<SessionTrim>;
    sessionUpgradePage(after: string, limit?: number): Promise<string[]>;
    signing: SigningControl;
    provisionPassword(input: {
      authorization: string;
      email: string;
      password: string;
      idempotencyKey?: string;
    }): Promise<ProvisioningResult>;
    provisionCredentialless(input: { authorization: string; idempotencyKey?: string }): Promise<ProvisioningResult>;
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
    /** Record an Access floor only after native session revocation completed. */
    completeClientReductionOwner(input: {
      clientId: string;
      operationId: string;
      accountId: string;
      barrier: InvalidationReceipt;
    }): Promise<void>;
    /** Deployment-only bounded coverage; existing clients remain closed until ready. */
    backfillClientIssuance(input: {
      clientId: string;
      limit: number;
    }): Promise<{ next: string | null; ready: boolean }>;
    finishClientReduction(input: {
      clientId: string;
      operationId: string;
      scopes: string[];
      firstParty: boolean;
    }): Promise<void>;
    /** Bounded cleanup is valid only after a durable Access floor; remaining
     * native rows cannot pass sessionProof and expire when presented. */
    revokeSessions(accountId: string, options?: { boundedCleanup: true; barrier: InvalidationReceipt }): Promise<void>;
    registerWebsiteClient(input: WebsiteClientRegistration): Promise<void>;
    registerClient(input: { clientId: string; firstParty: boolean; scopes: string[] }): Promise<void>;
  };
}

export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  return buildAuthService(options);
}
