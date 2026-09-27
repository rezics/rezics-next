// WebAuthn options and credentials cross the wire as base64url JSON (the
// shape SimpleWebAuthn and `PublicKeyCredential.toJSON()` use). Browsers
// without the JSON helpers still get the same encoding from these functions.

type Json = Record<string, unknown>;

function toBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0));
}

export function base64url(value: ArrayBuffer | ArrayBufferView | null | undefined): string | undefined {
  if (!value) return undefined;
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const descriptors = (value: unknown) => Array.isArray(value)
  ? value.map(item => ({ ...(item as Json), id: toBytes(String((item as Json).id)) }) as unknown as PublicKeyCredentialDescriptor)
  : undefined;

export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return { ...json, challenge: toBytes(String(json.challenge)),
    allowCredentials: descriptors(json.allowCredentials) } as PublicKeyCredentialRequestOptions;
}

export function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as Json;
  return { ...json, challenge: toBytes(String(json.challenge)), user: { ...user, id: toBytes(String(user.id)) },
    excludeCredentials: descriptors(json.excludeCredentials) } as unknown as PublicKeyCredentialCreationOptions;
}

export function credentialJson(credential: PublicKeyCredential): Json {
  if (typeof credential.toJSON === 'function') return credential.toJSON() as unknown as Json;
  const assertion = credential.response as AuthenticatorAssertionResponse;
  const attestation = credential.response as AuthenticatorAttestationResponse;
  const body: Json = 'signature' in credential.response
    ? { clientDataJSON: base64url(assertion.clientDataJSON), authenticatorData: base64url(assertion.authenticatorData),
      signature: base64url(assertion.signature), userHandle: base64url(assertion.userHandle) }
    : { clientDataJSON: base64url(attestation.clientDataJSON), attestationObject: base64url(attestation.attestationObject),
      transports: attestation.getTransports?.() ?? [] };
  return { id: credential.id, rawId: base64url(credential.rawId), type: credential.type, response: body,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined };
}

/** WebAuthn needs a named origin: a page at an IP address (such as local
 * development at 127.0.0.1) can't use passkeys, only one at `localhost`. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
    && !/^(\d+\.){3}\d+$|^\[/.test(window.location.hostname);
}

/** Whether the browser can offer passkeys in the email field's autofill. */
export async function autofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try { return await PublicKeyCredential.isConditionalMediationAvailable?.() === true; }
  catch { return false; }
}

/** A dismissed, timed-out or aborted prompt; the person simply didn't choose one. */
export function isCancelled(error: unknown): boolean {
  return error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name);
}
