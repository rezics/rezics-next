import { managementOperationProfile } from './management';
import { securityResponseLimits } from './security-response-bounds';

/** Same UTF-16 identity ceiling as SessionProof's native securityId producer.
 * Historical identifiers are opaque: no UUID version, normalization or truncation.
 */
export const RENAME_PAGE_MAX_ID_LENGTH = securityResponseLimits.id;
export const RENAME_PAGE_MAX_ACTIONS = 8;
const profile = managementOperationProfile('rename');
const skeleton = {
  state: 'ready',
  viewer: {
    accountId: '',
    clientId: profile.client_id,
    scopes: profile.scope,
    kind: 'actor',
    authnEpoch: Number.MIN_SAFE_INTEGER,
    authTime: Number.MIN_SAFE_INTEGER,
    amr: ['pwd'],
  },
  profile: { id: '', kind: 'actor', handle: 'a'.repeat(64) },
  authActions: { state: 'ready', operations: [] },
};
const action = {
  operationId: 'auth.account.rename',
  action: 'account:update',
  resource: { route: Number.MIN_SAFE_INTEGER, id: '0'.repeat(36) },
};
// Empty-string skeleton counts every key, quote and punctuation. Six bytes per
// UTF-16 unit covers control escapes, lone surrogates and UTF-8. handle64 is
// ASCII without escapes; null is smaller. Exact client/scopes and one pwd/pop
// have fixed lengths. Safe integers use at most 17 bytes including a sign (also conservative for epoch/time).
// A retained action forces the SAME account ID to UUID36, so the two maximal
// identity copies cannot coexist with eight descriptors. Empty ready actions
// cost more than authActions unavailable. All small union branches are fixed.
const opaqueIdentity = JSON.stringify(skeleton).length + 2 * 6 * RENAME_PAGE_MAX_ID_LENGTH;
const withActions =
  JSON.stringify(skeleton).length + 2 * 36 + RENAME_PAGE_MAX_ACTIONS * (JSON.stringify(action).length + 1) - 1;
export const RENAME_PAGE_MAX_RESPONSE_BYTES = Math.max(
  opaqueIdentity,
  withActions,
  ...['signed-out', 'refused', 'unavailable'].map((state) => JSON.stringify({ state }).length),
  JSON.stringify({
    state: 'management-auth-required',
    continuation: {
      kind: 'management-operation-step-up',
      operation: 'rename',
    },
  }).length,
);
