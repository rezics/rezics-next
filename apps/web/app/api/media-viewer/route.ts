import { cookies } from 'next/headers';
import { readMediaViewer } from '../../../features/api/media-viewer.ts';
import { serviceOrigin } from '../../../features/api/origins.ts';
import { ACCESS_COOKIE } from '../../../features/auth/cookies.ts';

export async function GET() {
  const viewer = await readMediaViewer({ accountOrigin: serviceOrigin('ACCOUNT_ORIGIN'),
    accessToken: (await cookies()).get(ACCESS_COOKIE)?.value });
  return Response.json(viewer, { status: viewer.ready ? 200 : 503,
    headers: { 'cache-control': 'no-store' } });
}
