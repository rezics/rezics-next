import { cookies } from 'next/headers';
import { currentSessionRecord } from '../../../features/auth/session-state.ts';

/** Lets a persistent client layout notice when a later request ended its session. */
export async function GET() {
  const active = currentSessionRecord(await cookies());
  return new Response(null, { status: active ? 204 : 401,
    headers: { 'cache-control': 'no-store' } });
}
