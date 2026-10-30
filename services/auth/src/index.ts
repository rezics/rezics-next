import type {
  InvalidationReceipt,
  CredentialPurpose,
  PasskeyPurpose,
  CredentialEffectVerifier,
  TrustedAccessPorts,
  SessionProof,
} from '@rezics/auth-contract';
export type {
  AccessAccount,
  InvalidationReceipt,
  EffectPurpose,
  CredentialPurpose,
  PasskeyPurpose,
  CredentialFloorPurpose,
  CredentialFloorBinding,
  CredentialApprovalPorts,
  PasskeyTrustedAccessPorts,
  PasskeyAuthorizationInput,
  CredentialFloorAuthorizationInput,
  CredentialEffectBinding,
  CredentialEffectExpectation,
  CredentialEffectVerifier,
  CredentialEffectAuthorization,
  CredentialFloorReceipt,
  CredentialFloorPort,
  SessionAuthorizationInput,
  CredentialAuthorizationInput,
  AuthorizationConsumeInput,
  EffectAuthorization,
  AssignmentProof,
  TrustedAccessPorts,
  SessionProof,
} from '@rezics/auth-contract';
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
import type { ProvisioningResult } from './provisioning-evidence.ts';
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
export type { AccountOperationAccess } from './account-operations-transport.ts';
export { SigningRotationPending } from './signing.ts';
export { createAccountWorkflows } from './workflows.ts';
export type { TurnstileConfiguration } from './turnstile.ts';
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

export type CredentialEffect =
  | { kind: 'password'; password: string | null }
  | { kind: 'key'; kid: string; publicJwk: JWK; remove?: false }
  | { kind: 'key'; kid: string; remove: true };

/** Verified public passkey material stays outside operator credential effects. */
export type PasskeyEffect =
  | { kind: 'passkey'; id: string; remove: true }
  | {
      kind: 'passkey';
      id: string;
      remove?: false;
      name: string | null;
      createdAt: string;
      publicKey: string;
      credentialID: string;
      counter: number;
      deviceType: string;
      backedUp: boolean;
      transports: string;
      aaguid: string;
      registrationDigest: string;
    };

export interface AuthServiceOptions {
  database: Pool;
  issuer: string;
  audience: string;
  secret: string;
  signing: { activeKid: string; privateKeys: JWK[] };
  trustedAccess: TrustedAccessPorts;
  /** Trusted clock supplied by native contract harnesses; production uses wall time. */
  clock?: () => Date;
  /** Trusted mounted x-action catalogue, supplied by production composition. */
  siteActions?: ReadonlyMap<string, { anonymous: boolean; replay?: 'self-account-read' }>;
  recoveryDelivery?: {
    deliver(input: { accountId: string; email: string; token: string; expiresAt: Date; url: string }): Promise<void>;
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
     * during this instance's trusted authorization callbacks. Never persist it or its JWT. */
    accessTokenForProof(proof: SessionProof): Promise<string>;
    /** Auth-host transport only. Proves the current human from the Auth session as
     * approveCredentialEffect does and, unless `fresh` is false, requires the
     * session's auth_time within the last 600 seconds (401 step_up_required).
     * `work` runs inside the live proof scope, where accessTokenForProof gives the
     * Access bearer for the proof; the bearer never leaves that scope. */
    withFreshHuman<T>(
      input: { headers: Headers; fresh?: boolean },
      work: (proof: SessionProof) => Promise<T>,
    ): Promise<T>;
    /** One native expiry batch, at most 1000 rows; scheduled by the Auth host. */
    pruneExpiredVerifications(): Promise<number>;
    /** Bounded maintenance; the host registers and schedules these ports. */
    pruneExpiredSessions(batch?: number): Promise<number>;
    /** One bounded batch of consent left by accounts erased in Auth. */
    eraseDueConsents(batch?: number): Promise<number>;
    /** Indexed scheduling gate; only the durable cleanup step crosses DBOS. */
    hasDueConsentErasure(): Promise<boolean>;
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
      sourceRegistrationId?: string;
    }): Promise<ProvisioningResult>;
    provisionCredentialless(input: {
      authorization: string;
      idempotencyKey?: string;
      sourceRegistrationId?: string;
    }): Promise<ProvisioningResult>;
    /** The coordinator must commit Access tombstone/fence before erasure. */
    eraseAccount(accountId: string): Promise<void>;
    /** Accept the terminal obligation; each subsequent page is independently durable. */
    startAccountErasure(accountId: string): Promise<string>;
    nativeErasurePage(id: string): Promise<import('./erasure-native.ts').ErasurePage>;
    redriveNativeErasure(): Promise<number>;
    openAutomatedSession(input: {
      authorization: string;
      subjectAccountId: string;
      headers: Headers;
    }): Promise<Response>;
    /** Auth-host command only; no kernel HTTP route. Authenticate the current human
     * and validate an actor subject (organizations never hold credentials). Derive
     * one of the four exact purposes from the closed body; reject unknown fields,
     * generic management bodies and private JWK d/k. Keys must be public ES256 with
     * matching kid. Only Auth invokes the installed Better Auth password hasher.
     * Commit an immutable stage keyed by (subject, key), encrypted input or an
     * Auth-native staged hash using purpose-separated keys and workflows.ts's
     * AES-GCM/AAD pattern. Bind all CredentialEffectBinding fields and the complete
     * normalized payload in Auth's keyed commitment. Changed input under a used key
     * conflicts forever, including after restart/consumption. Return locators only.
     */
    stageCredentialEffect(input: {
      key: string;
      subjectAccountId: string;
      headers: Headers;
      credential:
        | { kind: 'password'; password: string }
        | { kind: 'password'; password: null }
        | { kind: 'key'; kid: string; publicJwk: JWK; remove?: undefined }
        | { kind: 'key'; kid: string; remove: true; publicJwk?: undefined };
    }): Promise<{ effectRef: string; key: string; subjectId: string; purpose: CredentialPurpose; digest: string }>;
    /** Own-human removal staging. Installations are accepted only from a verified ceremony. */
    stagePasskeyEffect(input: {
      key: string;
      subjectAccountId: string;
      headers: Headers;
      credential: Extract<PasskeyEffect, { remove: true }>;
    }): Promise<{ effectRef: string; key: string; subjectId: string; purpose: PasskeyPurpose; digest: string }>;
    /** Resolve Auth's stage; enter the live proof callback and request an exact
     * native approval for this purpose/key/commitment. Authenticate anew; never
     * serialize proof/JWT/context. Own-human account:manage uses actor grant AND
     * consented client scope AND principal grant when present, with explicit deny
     * or missing evidence denying. Activation installs self account:manage beside
     * self account:read for actor accounts only, never organizations or automated
     * accounts. No self-owner bypass/fake operator relation. Native opening rules
     * and expiry are specified by createCredentialCapability. Fresh authenticated
     * approval may resume only the same unfinished immutable operation.
     */
    approveCredentialEffect(input: {
      effectRef: string;
      key: string;
      subjectAccountId: string;
      headers: Headers;
      /** Deadline created at the Auth request boundary. */
      deadline?: number;
    }): Promise<{ reference: string; expiresAt: string }>;
    /** Resolve the same immutable stage; consume an exact credential authorization,
     * compare its binding with Auth's stage, then revalidate current authority at
     * the Auth commit boundary. Revocation in that gap leaves the opening spent
     * and credentials unchanged. One Auth transaction commits ONE credential CAS,
     * required session revocation (at most 64), and an exact auth_effect_receipt
     * success result. Old four-column rows never mean success. Lost acknowledgement
     * returns the saved receipt with replayed=true only after current authorization;
     * never repeat mutation. A consumed opening without exact success fails closed;
     * only NEW authenticated approval may resume the same immutable operation.
     * Destructive changes require the exact committed CredentialFloorPort receipt.
     * Refuse removal of a person's last interactive credential with 409 and
     * effect_status=not_applied (doc 20 section 3); automation may lose its last key.
     * Reject unknown/device/session fields; transport purpose/digest, if present,
     * only compare against Auth's resolved stage. No secret enters Access/DBOS.
     * Cost: O(log R + (1+K) log G), R=N+U*t+M, fixed selected rows/statements,
     * logarithmic buffers; no history/session scans. Native tasks prove growth with
     * checkGrowth at 1x/8x/64x separately growing consumed same-subject openings,
     * old Auth effects and unrelated owners.
     */
    applyCredentialEffect(input: {
      authorization: string;
      effectRef: string;
      key: string;
      subjectAccountId: string;
      headers: Headers;
      /** Deadline created at the Auth request boundary. */
      deadline?: number;
    }): Promise<{ receiptId: string; replayed: boolean }>;
    /** Auth-owned point-read verifier; no minting path. */
    verifyCredentialEffect: CredentialEffectVerifier;
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
    registerClient(input: {
      clientId: string;
      firstParty: boolean;
      scopes: string[];
      displayName?: string;
      /** Insert when absent; otherwise require exact party/scopes without replacing metadata. */
      mode?: 'create-or-match';
    }): Promise<void>;
  };
}

export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  return buildAuthService(options);
}
