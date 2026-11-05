/** Closed native responses for the exact Security session and passkey removals. */
export type SecuritySessionRemovalSuccess = Record<never, never>;
export type SecuritySessionRemovalError =
  | { error: 'authentication_denied' }
  | { error: 'authentication_denied'; code: 'stale_review' };

export type SecurityPasskeyRemovalSuccess = { success: true };
export type SecurityPasskeyRemovalError =
  | { error: 'step_up_required'; effect_status: 'not_applied' }
  | { error: 'credential_effect_denied'; effect_status: 'not_applied' }
  | { error: 'authentication_denied' };

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

// These are the compact JSON bodies emitted by service.ts and its attempt wrapper.
const sessionRemovalSuccess = utf8Bytes('{}');
const sessionRemovalDenied = utf8Bytes('{"error":"authentication_denied"}');
const sessionRemovalStale = utf8Bytes('{"error":"authentication_denied","code":"stale_review"}');
const passkeyRemovalSuccess = utf8Bytes('{"success":true}');
const stepUpRequired = utf8Bytes('{"error":"step_up_required","effect_status":"not_applied"}');
const credentialEffectDenied = utf8Bytes('{"error":"credential_effect_denied","effect_status":"not_applied"}');
const attemptDenied = utf8Bytes('{"error":"authentication_denied"}');

/** Exact UTF-8 maximum across each endpoint's success and supported error envelopes. */
export const securityActionResponseByteBudgets = Object.freeze({
  session: Math.max(sessionRemovalSuccess, sessionRemovalDenied, sessionRemovalStale),
  passkey: Math.max(passkeyRemovalSuccess, stepUpRequired, credentialEffectDenied, attemptDenied),
});
