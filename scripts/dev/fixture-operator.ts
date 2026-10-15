import type { Pool } from 'pg';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';

/** Local fixture preparation owns these disposable credentials and database.
 * It exercises Account's factor policy; production users supply their own OTP. */
export async function proveFixtureOperator(input: { pool: Pool; secret: string; origin: string;
  handle: (request: Request) => Promise<Response> },
operator: { id: string; email: string; password: string; cookie?: string }): Promise<string> {
  let cookie = operator.cookie ?? '';
  const takeCookies = (response: Response) => {
    const issued = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    if (issued) cookie = issued;
  };
  const post = async (path: string, body: unknown) => {
    const response = await input.handle(new Request(`${input.origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: input.origin, cookie },
      body: JSON.stringify(body) }));
    if (!response.ok) throw new Error(`Fixture operator ${path}: HTTP ${response.status}`);
    takeCookies(response);
    await response.body?.cancel();
  };
  if (!cookie) await post('/api/auth/sign-in/email', { email: operator.email, password: operator.password });
  let factor = (await input.pool.query<{ secret: string }>('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [operator.id])).rows[0];
  if (!factor) {
    await post('/api/auth/two-factor/enable', { password: operator.password });
    factor = (await input.pool.query<{ secret: string }>('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [operator.id])).rows[0];
  }
  if (!factor) throw new Error('Fixture operator has no authenticator');
  const totp = createOTP(await symmetricDecrypt({ key: input.secret, data: factor.secret }));
  await post('/api/auth/two-factor/verify-totp', { code: await totp.totp() });
  await post('/api/account/reauthenticate', { password: operator.password, totpCode: await totp.totp() });
  const session = await input.handle(new Request(`${input.origin}/api/auth/get-session`, { headers: { cookie } }));
  if (!session.ok || (await session.json() as { user?: { id?: string } } | null)?.user?.id !== operator.id) {
    throw new Error('Fixture operator identity changed');
  }
  return cookie;
}
