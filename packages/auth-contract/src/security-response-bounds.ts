/** Native private read contracts; lengths are UTF-16 code units, counts are entries. */
export const securityResponseLimits = Object.freeze({
  id: 1024,
  displayName: 100,
  userAgent: 512,
  passkeyName: 128,
  scope: 128,
  date: 27,
  sessions: 64,
  passkeys: 32,
  selectedPage: 20,
  cursor: 8192,
});

function finite(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid Security byte budget');
  return value;
}
const add = (...values: number[]) => finite(values.reduce((sum, value) => sum + finite(value), 0));
const multiply = (a: number, b: number) => finite(finite(a) * finite(b));
/** Six bytes per code unit covers control escapes, lone surrogates and UTF-8. Includes quotes. */
export const securityJsonStringBytes = (units: number): number => add(2, multiply(6, units));
const array = (count: number, item: number) => add(2, multiply(count, item), Math.max(0, count - 1));
const object = (fields: Record<string, number>) =>
  add(
    2,
    ...Object.entries(fields).map(([key, bytes]) => add(JSON.stringify(key).length, 1, bytes)),
    Math.max(0, Object.keys(fields).length - 1),
  );
const nullable = (bytes: number) => Math.max(4, bytes);

/** Pass the same mounted keys used by native Auth, or undefined only when no catalogue is installed. */
export function securityScopeLimit(siteActions?: Iterable<string>): number {
  return siteActions === undefined
    ? 1000
    : finite(new Set(['openid', 'offline_access', 'media:complete', ...siteActions]).size);
}

/** Closed DTO maxima, including punctuation and all mutually compatible fields.
 * selectedLimit is the requested native page size (20 for the browser successor).
 */
export function securityResponseByteBudgets(scopeLimit: number, selectedLimit = 20) {
  finite(scopeLimit);
  if (!Number.isSafeInteger(selectedLimit) || selectedLimit < 1 || selectedLimit > 100)
    throw new RangeError('Invalid Security page size');
  const l = securityResponseLimits,
    s = securityJsonStringBytes;
  const id = s(l.id),
    label = nullable(s(l.displayName)),
    date = s(l.date),
    advice = s(16);
  const scopes = array(scopeLimit, s(l.scope));
  const passkey = object({ id, name: s(l.passkeyName), created_at: date, last_used_at: nullable(date) });
  const session = object({
    id,
    client_id: id,
    client_display_name: label,
    created_at: date,
    expires_at: date,
    user_agent: nullable(s(l.userAgent)),
    current: 5,
    revoke: advice,
  });
  const inventory = (rows: number) => object({ kind: s(5), rows, limit: 2, truncated: 5 });
  const client = object({ client_id: id, display_name: label, disabled: 5, scopes });
  const consent = object({
    client_id: id,
    display_name: label,
    granted: scopes,
    status: s(11),
    reducible: 5,
    pending_reduction: 5,
  });
  return Object.freeze({
    securityPage: object({
      viewer: object({ account_id: id, session_id: id, client_id: id }),
      sessions: inventory(array(l.sessions, session)),
      passkeys: inventory(
        array(
          l.passkeys,
          object({ id, name: s(l.passkeyName), created_at: date, last_used_at: nullable(date), remove: advice }),
        ),
      ),
      actions: object({ change_password: advice, register_passkey: advice }),
    }),
    clients: object({ clients: array(selectedLimit, client), next: nullable(s(l.cursor)) }),
    consents: object({ consents: array(selectedLimit, consent), next: nullable(s(l.cursor)) }),
    session: object({
      account_id: id,
      client_id: id,
      scope: scopes,
      authn_epoch: 17,
      auth_time: 17,
      amr: array(1, s(15)),
    }),
    passkeys: object({ passkeys: array(l.passkeys, passkey) }),
    registrationPage: object({
      kind: s(17),
      viewer: object({ account_id: id }),
      requirements: object({
        handle: object({ minLength: 1, maxLength: 2 }),
        email: object({ maxLength: 3 }),
        password: object({ minLength: 16, maxLength: 16 }),
        verification: object({ provider: s(9), required: 4 }),
      }),
      verification: object({ configured: 5 }),
      actions: object({ register: 5, continue: 5 }),
      reason: s(12),
    }),
  });
}
