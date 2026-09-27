import { cookies } from 'next/headers';
import { sameOriginWrite, serviceOrigin } from '../../features/api/origins.ts';
import { accountClient } from '../../features/auth/client.ts';
import { accountCookieHeader, REFRESH_COOKIE } from '../../features/auth/cookies.ts';
import { signOut } from '../../features/auth/sign-out.ts';

/** POST only, so no other site can sign someone out with a link or image. */
export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData().catch(() => null);
  return signOut({ requestUrl: request.url, cookieHeader: accountCookieHeader(request.headers.get('cookie')),
    refreshToken: (await cookies()).get(REFRESH_COOKIE)?.value, client: accountClient(),
    accountOrigin: serviceOrigin('ACCOUNT_ORIGIN'), next: String(form?.get('next') ?? '') });
}
