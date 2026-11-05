import { parseSignInOptions, signInResponseBytes } from '@rezics/auth-contract';
import { parsePasskeyEnrollmentOptions, passkeyEnrollmentResponseBytes } from '@rezics/auth-contract';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { passkey, type PasskeyOptions } from '@better-auth/passkey';
export type PasskeyAssertion = Parameters<
  NonNullable<NonNullable<PasskeyOptions['authentication']>['afterVerification']>
>[0]['clientData'];
import { APIError } from 'better-auth/api';
import type { PasskeyEffect } from './index.ts';

type Installation = Extract<PasskeyEffect, { kind: 'passkey'; publicKey: string }>;
type Ceremony = { credential?: Installation };
export const passkeyCeremonies = new AsyncLocalStorage<Ceremony>();

/** The pinned plugin owns WebAuthn verification and challenge consumption. Its
 * registration hook stops native persistence: only a credential effect installs
 * the verified public credential. This also keeps native mutation routes private.
 */
export function passkeyPlugin(issuer: string) {
  return passkey({
    rpID: 'rezics.com',
    rpName: 'REZICS',
    origin: issuer,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    registration: {
      afterVerification({ verification, clientData, ctx }) {
        const ceremony = passkeyCeremonies.getStore();
        const info = verification.registrationInfo;
        // This plugin version requests UV but passes requireUserVerification:false
        // to the verifier. Enforce the verified authenticator flag in both hooks.
        if (!ceremony || !info?.userVerified) throw new APIError('UNAUTHORIZED');
        const input = registrationInput(clientData, ctx.body.name);
        ceremony.credential = {
          kind: 'passkey',
          id: randomUUID(),
          name: input.name,
          createdAt: new Date().toISOString(),
          publicKey: Buffer.from(info.credential.publicKey).toString('base64'),
          credentialID: info.credential.id,
          counter: info.credential.counter,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          transports: clientData.response.transports?.join(',') ?? '',
          aaguid: info.aaguid,
          registrationDigest: input.digest,
        };
        throw new APIError('BAD_REQUEST', { code: 'AUTH_CREDENTIAL_EFFECT_REQUIRED' });
      },
    },
    authentication: {
      afterVerification({ verification }) {
        if (!verification.authenticationInfo.userVerified) throw new APIError('UNAUTHORIZED');
      },
    },
  });
}

export function registrationInput(response: unknown, name: unknown) {
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 128))
    throw new APIError('BAD_REQUEST');
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new APIError('BAD_REQUEST');
  const value = response as { response?: { clientDataJSON?: unknown } };
  const encoded = value.response?.clientDataJSON;
  if (typeof encoded !== 'string' || encoded.length > 12000) throw new APIError('BAD_REQUEST');
  let challenge: unknown;
  try {
    challenge = JSON.parse(Buffer.from(encoded, 'base64url').toString()).challenge;
  } catch {
    throw new APIError('BAD_REQUEST');
  }
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(challenge)) throw new APIError('BAD_REQUEST');
  const label = typeof name === 'string' ? name.trim() : null;
  // The operation identity is the ceremony challenge. Bind the exact response so
  // knowing a challenge cannot disclose a saved receipt with substituted input.
  return {
    key: `passkey-register:${challenge}`,
    name: label,
    digest: createHash('sha256')
      .update(JSON.stringify([response, label]))
      .digest('hex'),
  };
}

/** Plugin HTTP response boundary: no partial options or challenge cookie is published. */
export async function receiveRegistrationOptions(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new APIError('SERVICE_UNAVAILABLE');
  let complete = false;
  try {
    const announced = response.headers.get('content-length');
    if (announced && /^\d+$/.test(announced) && Number(announced) > passkeyEnrollmentResponseBytes.options)
      throw new APIError('SERVICE_UNAVAILABLE');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (value.byteLength > passkeyEnrollmentResponseBytes.options - size) throw new APIError('SERVICE_UNAVAILABLE');
      size += value.byteLength;
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    const options = parsePasskeyEnrollmentOptions(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!options || options.rp.id !== 'rezics.com' || options.rp.name !== 'REZICS')
      throw new APIError('SERVICE_UNAVAILABLE');
    return options;
  } catch {
    throw new APIError('SERVICE_UNAVAILABLE');
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Discoverable authentication output from the pinned plugin; no challenge cookie escapes failed receiving. */
export async function receiveAuthenticationOptions(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new APIError('SERVICE_UNAVAILABLE');
  let complete = false;
  try {
    const announced = response.headers.get('content-length');
    if (announced && /^\d+$/.test(announced) && Number(announced) > signInResponseBytes.pluginOptions)
      throw new APIError('SERVICE_UNAVAILABLE');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (value.byteLength > signInResponseBytes.pluginOptions - size) throw new APIError('SERVICE_UNAVAILABLE');
      size += value.byteLength;
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    const options = parseSignInOptions(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), true);
    if (!options) throw new APIError('SERVICE_UNAVAILABLE');
    return options;
  } catch {
    throw new APIError('SERVICE_UNAVAILABLE');
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
