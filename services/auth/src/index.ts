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
export type CredentialPurpose = Exclude<EffectPurpose, 'session'>;

/** Auth-owned nonsecret commitment, never credential material or permission context.
 * The keyed digest binds version, stage locator, immutable (subject, operationKey),
 * exact purpose, normalized payload, selected credential row identity/version,
 * human, client and exact consented scopes. Null row identity/version denotes
 * expected absence, including a first password or new key. Caller hashes are
 * comparisons only; only Auth establishes provenance. Changed input under a used
 * key conflicts even after consumption or restart. Access/DBOS retain only these
 * locators, never passwords, private keys, cookies, JWTs or SessionProof objects.
 */
export interface CredentialEffectBinding {
  operationKey: string;
  effectReference: string;
  effectDigest: string;
  subjectAccountId: string;
  purpose: CredentialPurpose;
  credentialRowId: string | null;
  credentialRowVersion: string | null;
  actingHumanId: string;
  clientId: string;
  scopes: string[];
}

/** Expected current identity and immutable operation; an optional digest only compares. */
export type CredentialEffectExpectation = Pick<
  CredentialEffectBinding,
  'operationKey' | 'subjectAccountId' | 'purpose' | 'actingHumanId' | 'clientId' | 'scopes'
> & { effectDigest?: string };

/** Auth-owned read closure, supplied only by trusted host composition. Point-read
 * the committed stage and verify its keyed provenance, exact expected binding and
 * selected credential row/version. After commit resolve the exact terminal receipt,
 * never treat the old row version as new mutation authority. No minting path, Auth
 * database/key/runtime exposure to the kernel, or caller digest as provenance.
 */
export type CredentialEffectVerifier = (
  reference: string,
  expected: CredentialEffectExpectation,
) => Promise<CredentialEffectBinding>;

/** Exact credential consume result. Auth compares every field with its own stage
 * before writing; a session/device approval or broad credential opening cannot
 * substitute. A durable reference is a locator, never current authorization.
 */
export interface CredentialEffectAuthorization extends EffectAuthorizationBase {
  operationKey: string;
  effectReference: string;
  effectDigest: string;
  purpose: CredentialPurpose;
}

/** A committed native floor receipt, bound to the exact stage and consumed opening.
 * minimumAuthnEpoch must equal previousFloor + 1 and the existing fence is preserved.
 * Resolve provenance from native storage; equal caller epochs/foreign receipts deny.
 */
export interface CredentialFloorReceipt extends InvalidationReceipt {
  operationKey: string;
  effectReference: string;
  effectDigest: string;
  purpose: CredentialPurpose;
  openingReceiptId: string;
  previousFloor: number;
  fenced: boolean;
}

/** Credential-only trusted floor hook. Bind Auth's verified stage, already consumed
 * opening, expected previous subject floor, immutable key and purpose. Commit the
 * exact next floor before mutation for password replacement/remove-password/remove-key;
 * add-key and first password installation do not advance it. Recheck current
 * authority, including the operator for automation, and preserve fences. Never widen
 * consent/recovery hooks or relabel this effect as either. The in-flight own-human
 * operation may finish against only its exact committed barrier and unchanged next
 * floor; its invalidated source session grants no consume/replay authority.
 */
export type CredentialFloorPort = (input: {
  stage: CredentialEffectBinding;
  consumedOpening: CredentialEffectAuthorization;
  expectedPreviousFloor: number;
  key: string;
  purpose: CredentialPurpose;
}) => Promise<CredentialFloorReceipt>;

/** The session input stays byte-for-byte equivalent to the existing contract. */
export type SessionAuthorizationInput = {
  authorization: string;
  subjectAccountId: string;
  purpose: 'session';
  human: SessionProof;
};

/** One exact credential purpose; both immutable stage locators are mandatory. */
export type CredentialAuthorizationInput = {
  [Purpose in CredentialPurpose]: Omit<SessionAuthorizationInput, 'purpose'> & {
    purpose: Purpose;
    operationKey: string;
    effectReference: string;
  };
}[CredentialPurpose];

/** @deprecated Only legacy internal.setCredential produces this unbound input.
 * Native kernel capabilities must reject it: it carries no exact effect binding.
 * A later task removes this variant together with the legacy setCredential path.
 */
export type LegacyCredentialAuthorizationInput = Omit<SessionAuthorizationInput, 'purpose'> & {
  purpose: CredentialPurpose;
  operationKey?: undefined;
  effectReference?: undefined;
};

export type AuthorizationConsumeInput =
  | SessionAuthorizationInput
  | CredentialAuthorizationInput
  | LegacyCredentialAuthorizationInput;

interface EffectAuthorizationBase {
  receiptId: string;
  subjectAccountId: string;
  actingHumanId: string;
  operatorAccountId: string | null;
  clientId: string;
  scopes: string[];
  humanEpoch: number;
  subjectEpoch: number;
  expiresAt: string;
  invalidation?: InvalidationReceipt;
}

/** A consumed durable Access authorization, never a caller-supplied approval.
 * Native credential results carry the complete credential extension. The unbound
 * branch exists for sessions and legacy setCredential only; it cannot carry a
 * partial credential binding. Auth must compare the native extension to its stage.
 */
export type EffectAuthorization =
  | (EffectAuthorizationBase & {
      purpose: EffectPurpose;
      operationKey?: undefined;
      effectReference?: undefined;
      effectDigest?: undefined;
    })
  | CredentialEffectAuthorization;

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
  /** Consume once while rechecking relationship, formula, floors and client evidence.
   * Exact credential calls return CredentialEffectAuthorization; Auth compares its
   * operationKey, effectReference, effectDigest, purpose and subject with its own
   * immutable stage before writing. Native capabilities reject the legacy variant.
   */
  consumeAuthorization?(input: AuthorizationConsumeInput): Promise<EffectAuthorization>;
  /** Trusted native credential capability. Missing ports fail closed. Approval
   * creates the exact native opening; revalidation repeats current authorization
   * at the Auth commit boundary and before disclosing a saved result. The exact
   * floor receipt permits only this in-flight operation against its own barrier. */
  approveCredentialEffect?(input: {
    stage: CredentialEffectBinding;
    human: SessionProof;
  }): Promise<{ reference: string; expiresAt: string }>;
  /** Resolve the exact native opening from authorization and compare its binding
   * to stage. Repeat the same formula, current human/operator/subject state,
   * fences, floors, consent, evidence and original expiry on every call. replay
   * permits saved-result disclosure only; it never reopens a consumed approval.
   * floorReceipt permits only the exact in-flight own-human barrier exception.
   * No proof or permission context may be retained after this callback. */
  revalidateCredentialEffect?(input: {
    stage: CredentialEffectBinding;
    human: SessionProof;
    authorization: string;
    consumedOpening?: CredentialEffectAuthorization;
    floorReceipt?: CredentialFloorReceipt;
    replay: boolean;
  }): Promise<void>;
  advanceCredentialFloor?: CredentialFloorPort;
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
     * during this instance's trusted authorization callbacks. Never persist it or its JWT. */
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
    }): Promise<{ receiptId: string; replayed: boolean }>;
    /** Auth-owned point-read verifier; no minting path. */
    verifyCredentialEffect: CredentialEffectVerifier;
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
    registerClient(input: {
      clientId: string;
      firstParty: boolean;
      scopes: string[];
      displayName?: string;
    }): Promise<void>;
  };
}

export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  return buildAuthService(options);
}
