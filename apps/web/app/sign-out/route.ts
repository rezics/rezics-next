import { cookies } from 'next/headers';
import { sameOriginWrite } from '../../features/api/origins.ts';
import { accountClient } from '../../features/auth/client.ts';
import { REFRESH_COOKIE } from '../../features/auth/cookies.ts';
import { signOut } from '../../features/auth/sign-out.ts';

/** POST only, so no other site can sign someone out with a link or image. */
export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData().catch(() => null);
  return signOut({ requestUrl: request.url,
    refreshToken: (await cookies()).get(REFRESH_COOKIE)?.value, client: accountClient(),
    next: String(form?.get('next') ?? '') });
}
