import { cookies } from 'next/headers';
import { forwardDisplayPreferences } from '../../../features/api/preferences.ts';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { ACCESS_COOKIE } from '../../../features/auth/cookies.ts';

async function proxy(request: Request) {
  return forwardDisplayPreferences(request, { accountOrigin: serviceOrigin('ACCOUNT_ORIGIN'),
    accessToken: (await cookies()).get(ACCESS_COOKIE)?.value });
}

export const GET = proxy;
export const PUT = proxy;
