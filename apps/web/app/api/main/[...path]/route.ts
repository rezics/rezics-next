import { cookies } from 'next/headers';
import { forwardToMain } from '../../../../features/api/bff.ts';
import { serviceOrigin } from '../../../../features/api/origins.ts';
import { ACCESS_COOKIE } from '../../../../features/auth/cookies.ts';

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  // `proxy.ts` refreshed the token for this request if it had expired.
  return forwardToMain(request, (await params).path, { mainOrigin: serviceOrigin('MAIN_ORIGIN'),
    accessToken: (await cookies()).get(ACCESS_COOKIE)?.value });
}

// One export per method in MAIN_METHODS (tests/session-bff.test.ts keeps them equal).
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
