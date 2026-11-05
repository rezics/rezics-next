import { securityJsonStringBytes as stringBytes, securityResponseLimits } from './security-response-bounds';

/** Supported pinned producer, not bounds on arbitrary PostgreSQL text. */
export const passkeyEnrollmentLimits = Object.freeze({
  challenge: 43, // base64url(32 random bytes)
  userHandle: 43, // base64url(32 ASCII random characters), independent of account ID
  userLabel: securityResponseLimits.id, // native empty name falls back to the account ID
  credentialId: 16384, // a credential ID cannot exceed the entire admitted registration request
  excluded: securityResponseLimits.passkeys,
});
const objectBytes = (fields: Record<string, number>) =>
  2 +
  Object.entries(fields).reduce((n, [key, size]) => n + JSON.stringify(key).length + 1 + size, 0) +
  Math.max(0, Object.keys(fields).length - 1);
const arrayBytes = (count: number, size: number) => 2 + count * size + Math.max(0, count - 1);
const ascii = (length: number) => length + 2;
const transports = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
type Transport = (typeof transports)[number];
const l = passkeyEnrollmentLimits;
const selectionBytes = objectBytes({
  residentKey: stringBytes(8),
  requireResidentKey: 4,
  userVerification: stringBytes(8),
});
export const passkeyEnrollmentResponseBytes = Object.freeze({
  options: objectBytes({
    challenge: ascii(l.challenge),
    rp: objectBytes({ id: stringBytes(10), name: stringBytes(6) }),
    user: objectBytes({
      id: ascii(l.userHandle),
      name: stringBytes(l.userLabel),
      displayName: stringBytes(l.userLabel),
    }),
    pubKeyCredParams: arrayBytes(3, objectBytes({ alg: 4, type: stringBytes(10) })),
    timeout: 5,
    attestation: stringBytes(4),
    excludeCredentials: arrayBytes(
      l.excluded,
      objectBytes({
        id: ascii(l.credentialId),
        type: stringBytes(10),
        transports: arrayBytes(transports.length, stringBytes(10)),
      }),
    ),
    authenticatorSelection: selectionBytes,
    extensions: objectBytes({ credProps: 4 }),
    hints: 2,
  }),
  created: objectBytes({
    id: stringBytes(securityResponseLimits.id),
    name: stringBytes(securityResponseLimits.passkeyName),
    created_at: stringBytes(securityResponseLimits.date),
  }),
  error: objectBytes({
    error: stringBytes('credential_effect_denied'.length),
    effect_status: stringBytes('not_applied'.length),
  }),
});

export type PasskeyEnrollmentOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { alg: number; type: 'public-key' }[];
  timeout: number;
  attestation: 'none';
  excludeCredentials: { id: string; type: 'public-key'; transports?: Transport[] }[];
  authenticatorSelection: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' };
  extensions: { credProps: true };
  hints: [];
};
export type PasskeyEnrollmentCreated = { id: string; name: string | null; created_at: string };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const encoded = (value: unknown, max: number): value is string =>
  text(value, max) && value.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(value);

/** Validate and project the complete configured creation DTO at response ingress. */
export function parsePasskeyEnrollmentOptions(value: unknown): PasskeyEnrollmentOptions | null {
  if (
    !record(value) ||
    !closed(value, [
      'challenge',
      'rp',
      'user',
      'pubKeyCredParams',
      'timeout',
      'attestation',
      'excludeCredentials',
      'authenticatorSelection',
      'extensions',
      'hints',
    ])
  )
    return null;
  const {
    rp,
    user,
    pubKeyCredParams: algorithms,
    authenticatorSelection: selection,
    extensions,
    excludeCredentials: excluded,
  } = value;
  if (
    !encoded(value.challenge, l.challenge) ||
    value.challenge.length !== l.challenge ||
    !record(rp) ||
    !closed(rp, ['id', 'name']) ||
    rp.id !== 'rezics.com' ||
    rp.name !== 'REZICS' ||
    !record(user) ||
    !closed(user, ['id', 'name', 'displayName']) ||
    !encoded(user.id, l.userHandle) ||
    user.id.length !== l.userHandle ||
    !text(user.name, l.userLabel) ||
    !text(user.displayName, l.userLabel) ||
    !Array.isArray(algorithms) ||
    algorithms.length !== 3 ||
    algorithms.some(
      (alg, i) =>
        !record(alg) || !closed(alg, ['alg', 'type']) || alg.type !== 'public-key' || alg.alg !== [-8, -7, -257][i],
    ) ||
    value.timeout !== 60000 ||
    value.attestation !== 'none' ||
    !record(selection) ||
    !closed(selection, ['residentKey', 'requireResidentKey', 'userVerification']) ||
    selection.residentKey !== 'required' ||
    selection.requireResidentKey !== true ||
    selection.userVerification !== 'required' ||
    !record(extensions) ||
    !closed(extensions, ['credProps']) ||
    extensions.credProps !== true ||
    !Array.isArray(value.hints) ||
    value.hints.length !== 0 ||
    !Array.isArray(excluded) ||
    excluded.length > l.excluded
  )
    return null;
  const credentials: PasskeyEnrollmentOptions['excludeCredentials'] = [];
  for (const credential of excluded) {
    if (
      !record(credential) ||
      !closed(credential, ['id', 'type', 'transports']) ||
      credential.type !== 'public-key' ||
      !encoded(credential.id, l.credentialId)
    )
      return null;
    // Native absent transports are stored as '' and split into ['']; no hint is equivalent to [].
    const routes =
      Array.isArray(credential.transports) && credential.transports.length === 1 && credential.transports[0] === ''
        ? []
        : credential.transports;
    if (
      routes !== undefined &&
      (!Array.isArray(routes) ||
        routes.length > transports.length ||
        routes.some((route) => !transports.includes(route)))
    )
      return null;
    credentials.push({
      id: credential.id,
      type: 'public-key',
      ...(routes === undefined ? {} : { transports: routes as Transport[] }),
    });
  }
  return {
    challenge: value.challenge,
    rp: { id: rp.id, name: rp.name },
    user: { id: user.id, name: user.name, displayName: user.displayName },
    pubKeyCredParams: [-8, -7, -257].map((alg) => ({ alg, type: 'public-key' })),
    timeout: 60000,
    attestation: 'none',
    excludeCredentials: credentials,
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { credProps: true },
    hints: [],
  };
}

/** The effect's absent name is null; inventory separately projects it to an empty label. */
export function parsePasskeyEnrollmentCreated(value: unknown): PasskeyEnrollmentCreated | null {
  if (
    !record(value) ||
    !closed(value, ['id', 'name', 'created_at']) ||
    !text(value.id, securityResponseLimits.id) ||
    !(value.name === null || text(value.name, securityResponseLimits.passkeyName)) ||
    !text(value.created_at, securityResponseLimits.date) ||
    !Number.isFinite(Date.parse(value.created_at))
  )
    return null;
  return { id: value.id, name: value.name, created_at: value.created_at };
}

export function parsePasskeyEnrollmentError(value: unknown): { error: string; effect_status?: 'not_applied' } | null {
  if (
    !record(value) ||
    !closed(value, ['error', 'effect_status']) ||
    !['step_up_required', 'credential_effect_denied', 'authentication_denied'].includes(String(value.error)) ||
    (value.effect_status !== undefined && value.effect_status !== 'not_applied')
  )
    return null;
  return {
    error: value.error as string,
    ...(value.effect_status === 'not_applied' ? { effect_status: 'not_applied' as const } : {}),
  };
}
