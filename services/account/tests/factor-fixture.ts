import { expect } from 'bun:test';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt } from 'better-auth/crypto';
import type { Pool } from 'pg';

export const factorCookies = (response: Response) => response.headers.getSetCookie()
  .map(value => value.split(';')[0]).join('; ');

/** Enroll and prove the operator's own authenticator through the public API. */
export async function enrollSecondFactor(f: { pool: Pool; secret: string;
  request: (path: string, body: unknown, cookie: string) => Promise<Response> },
member: { id: string; password: string; cookie: string }) {
  if (!(await f.pool.query('SELECT 1 FROM "twoFactor" WHERE "userId" = $1 AND verified', [member.id])).rowCount) {
    expect((await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie)).status).toBe(200);
  }
  const row = (await f.pool.query<{ secret: string }>('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0]!;
  const secret = await symmetricDecrypt({ key: f.secret, data: row.secret });
  const verified = await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() }, member.cookie);
  expect(verified.status).toBe(200);
  if (factorCookies(verified)) member.cookie = factorCookies(verified);
  expect((await f.request('/api/account/reauthenticate', { password: member.password,
    totpCode: await createOTP(secret).totp() }, member.cookie)).status).toBe(200);
  return secret;
}

/** Independent HTTP fixtures use the same enrollment policy as accountFixture. */
export function enrollOperatorAt(pool: Pool, secret: string, origin: string,
  member: { id: string; password: string; cookie: string }) {
  return enrollSecondFactor({ pool, secret, request: (path, body, cookie) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body),
  }) }, member);
}
