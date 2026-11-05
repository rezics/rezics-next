/** Exact HTTP projections for the native credential-effect phase transport. */
export type CredentialEffectStageResponse = {
  effectRef: string;
  key: string;
  subjectId: string;
  purpose: 'set-password' | 'remove-password' | 'add-key' | 'remove-key' | 'add-passkey' | 'remove-passkey';
  digest: string;
};

export type PasswordCredentialEffectStageResponse = Omit<CredentialEffectStageResponse, 'purpose'> & {
  purpose: 'set-password';
};

export type CredentialEffectApprovalResponse = {
  reference: string;
  expiresAt: string;
};

export type CredentialEffectApplyResponse = {
  receiptId: string;
  replayed: boolean;
};

export type CredentialEffectErrorResponse =
  | { error: 'credential_effect_denied'; effect_status: 'not_applied' }
  | { error: 'step_up_required'; effect_status: 'not_applied' };

export const credentialEffectNotAppliedStatuses = [400, 401, 403, 409, 413, 415, 503] as const;

const uuid = '00000000-0000-4000-8000-000000000000';
const digest = 'a'.repeat(64);

function sealedTokenLength(payloadBytes: number): number {
  // Access seal encodes [version, key id, UTF-8 JSON] as unpadded base64url,
  // followed by a dot and a SHA-256 HMAC (43 base64url characters).
  return Math.ceil(((payloadBytes + 2) * 4) / 3) + 44;
}

function sealedPayloadLength(payload: unknown): number {
  // These producer-shaped placeholders serialize entirely as ASCII, including
  // the worst-case escaped operation key below, so string length is UTF-8 size.
  return JSON.stringify(payload).length;
}

const workflowApprovalReferenceMax = sealedTokenLength(
  sealedPayloadLength({ route: 65_535, id: uuid, binding: digest }),
);

const passwordWorkflowOpeningReferenceMax = sealedTokenLength(
  sealedPayloadLength({
    operationKey: '\u0000'.repeat(255),
    effectReference: uuid,
    effectDigest: digest,
    subjectAccountId: uuid,
    purpose: 'set-password',
    kind: 'workflow-approval',
    reference: 'A'.repeat(workflowApprovalReferenceMax),
  }),
);

const passwordOperatorOpeningReferenceMax = sealedTokenLength(
  sealedPayloadLength({
    operationKey: '\u0000'.repeat(255),
    effectReference: uuid,
    effectDigest: digest,
    subjectAccountId: uuid,
    purpose: 'set-password',
    kind: 'operator-opening',
    operatorAccountId: uuid,
    receiptId: uuid,
  }),
);

const genericWorkflowOpeningReferenceMax = sealedTokenLength(
  sealedPayloadLength({
    operationKey: '\u0000'.repeat(255),
    effectReference: uuid,
    effectDigest: digest,
    subjectAccountId: uuid,
    purpose: 'remove-password',
    kind: 'workflow-approval',
    reference: 'A'.repeat(workflowApprovalReferenceMax),
  }),
);

const genericOperatorOpeningReferenceMax = sealedTokenLength(
  sealedPayloadLength({
    operationKey: '\u0000'.repeat(255),
    effectReference: uuid,
    effectDigest: digest,
    subjectAccountId: uuid,
    purpose: 'remove-password',
    kind: 'operator-opening',
    operatorAccountId: uuid,
    receiptId: uuid,
  }),
);

/**
 * Host text admission is 1,024 UTF-16 code units. Access seals the password
 * approval locator with a 255-unit operation-key ceiling, UUID account/effect
 * locators and either a sealed workflow approval or a UUID operator receipt.
 * This is the larger of those two exact Access producer shapes; the reference
 * is ASCII, so code units and UTF-8 bytes are equal.
 */
export const credentialEffectResponseLimits = Object.freeze({
  textUnits: 1_024,
  approvalReferenceUnits: Math.max(genericWorkflowOpeningReferenceMax, genericOperatorOpeningReferenceMax),
  passwordApprovalReferenceUnits: Math.max(passwordWorkflowOpeningReferenceMax, passwordOperatorOpeningReferenceMax),
});

const stageSuccessBytes = JSON.stringify({
  effectRef: uuid,
  key: '\u0000'.repeat(credentialEffectResponseLimits.textUnits),
  subjectId: '\u0000'.repeat(credentialEffectResponseLimits.textUnits),
  purpose: 'set-password',
  digest,
}).length;

const approvalSuccessBytes = JSON.stringify({
  reference: 'A'.repeat(credentialEffectResponseLimits.passwordApprovalReferenceUnits),
  expiresAt: '9999-12-31T23:59:59.999Z',
}).length;

const applySuccessBytes = JSON.stringify({ receiptId: uuid, replayed: false }).length;

const errorBytes = Math.max(
  JSON.stringify({ error: 'credential_effect_denied', effect_status: 'not_applied' }).length,
  JSON.stringify({ error: 'step_up_required', effect_status: 'not_applied' }).length,
);

/** Maximum actual UTF-8 response bytes, before decoding or JSON parsing. */
export const credentialEffectResponseByteBudgets = Object.freeze({
  stage: Object.freeze({ success: stageSuccessBytes, error: errorBytes }),
  approve: Object.freeze({ success: approvalSuccessBytes, error: errorBytes }),
  apply: Object.freeze({ success: applySuccessBytes, error: errorBytes }),
});

const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sealedAccessReference = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

function canonicalBase64Url(value: string): boolean {
  if (value.length % 4 === 1) return false;
  const last = value.at(-1)!;
  const code = last.charCodeAt(0);
  const sextet =
    code >= 65 && code <= 90
      ? code - 65
      : code >= 97 && code <= 122
        ? code - 97 + 26
        : code >= 48 && code <= 57
          ? code - 48 + 52
          : last === '-'
            ? 62
            : 63;
  return value.length % 4 === 0 || (value.length % 4 === 2 ? sextet % 16 === 0 : sextet % 4 === 0);
}

/** Auth's effect and receipt IDs come from node:crypto.randomUUID(). */
export function isCredentialEffectUuid(value: unknown): value is string {
  return typeof value === 'string' && nativeUuid.test(value);
}

/** Access's approval is a sealed base64url payload plus a SHA-256 HMAC. */
export function isCredentialEffectApprovalReference(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > credentialEffectResponseLimits.approvalReferenceUnits) return false;
  const parts = sealedAccessReference.exec(value);
  return Boolean(parts && canonicalBase64Url(parts[1]!) && canonicalBase64Url(parts[2]!));
}

/** The password phase accepts only its own producer-shaped reference maximum. */
export function isPasswordCredentialEffectApprovalReference(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > credentialEffectResponseLimits.passwordApprovalReferenceUnits)
    return false;
  const parts = sealedAccessReference.exec(value);
  return Boolean(parts && canonicalBase64Url(parts[1]!) && canonicalBase64Url(parts[2]!));
}

/** Access publishes approval expiry with Date.prototype.toISOString(). */
export function isCredentialEffectApprovalExpiry(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
