import { securityResponseLimits } from './security-response-bounds';

/** Closed private review body shared by the Auth producer and browser reader. */
export type OrganizationDeletionResponse =
  | {
      kind: 'authentication-required';
      humanAccountId: string;
      action: 'authenticate';
    }
  | {
      kind: 'ready';
      humanAccountId: string;
      action: 'confirm';
      account: {
        id: string;
        kind: 'organization';
        handle: string | null;
        displayName: string | null;
      };
    }
  | { kind: 'signed-out' | 'hidden' | 'denied' | 'missing' | 'changed' | 'unavailable' };

export const ORGANIZATION_DELETION_MAX_SESSION_PROOF_ID_LENGTH = securityResponseLimits.id;
export const ORGANIZATION_DELETION_MAX_ORGANIZATION_ID_LENGTH = 36;
export const ORGANIZATION_DELETION_MAX_HANDLE_LENGTH = 64;
export const ORGANIZATION_DELETION_MAX_DISPLAY_NAME_LENGTH = 4096;

const readySkeleton = {
  kind: 'ready',
  humanAccountId: '',
  action: 'confirm',
  account: {
    id: '0'.repeat(ORGANIZATION_DELETION_MAX_ORGANIZATION_ID_LENGTH),
    kind: 'organization',
    handle: 'a'.repeat(ORGANIZATION_DELETION_MAX_HANDLE_LENGTH),
    displayName: '',
  },
};
const authenticationRequiredSkeleton = {
  kind: 'authentication-required',
  humanAccountId: '',
  action: 'authenticate',
};

// The fixed skeleton includes every key, quote, ASCII handle/UUID, and punctuation.
// Six bytes per UTF-16 unit bounds escaped opaque IDs and display names, including
// control characters and lone surrogates. Nullable strings cost less than maxima.
const readyBytes =
  JSON.stringify(readySkeleton).length +
  6 * (ORGANIZATION_DELETION_MAX_SESSION_PROOF_ID_LENGTH + ORGANIZATION_DELETION_MAX_DISPLAY_NAME_LENGTH);
const authenticationRequiredBytes =
  JSON.stringify(authenticationRequiredSkeleton).length + 6 * ORGANIZATION_DELETION_MAX_SESSION_PROOF_ID_LENGTH;
const fixedAdviceBytes = ['signed-out', 'hidden', 'denied', 'missing', 'changed', 'unavailable'].map(
  (kind) => JSON.stringify({ kind }).length,
);

/** UTF-8 bytes for every closed success variant and the fixed 400/413 error body. */
export const ORGANIZATION_DELETION_MAX_RESPONSE_BYTES = Math.max(
  readyBytes,
  authenticationRequiredBytes,
  ...fixedAdviceBytes,
  JSON.stringify({ error: 'organization_deletion_read_denied' }).length,
);
