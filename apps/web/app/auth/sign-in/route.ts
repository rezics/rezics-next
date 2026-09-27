import { NextResponse } from 'next/server';
import { sameOriginWrite, serviceOrigin } from '../../../features/api/origins.ts';
import { safeReturnPath } from '../../../features/auth/paths.ts';

/** The sign-in form's target before (or without) JavaScript: signs in or
 * creates the account at Account, keeps its session cookie and starts
 * authorization, so credentials never travel in a URL. */
export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData();
  const mode = form.get('mode') === 'sign-up' ? 'sign-up' : 'sign-in';
  const next = safeReturnPath(String(form.get('next') ?? ''));
  const accountOrigin = serviceOrigin('ACCOUNT_ORIGIN');
  const account = await fetch(new URL(`/api/auth/${mode}/email`, accountOrigin), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: accountOrigin },
    body: JSON.stringify({ email: String(form.get('email') ?? ''), password: String(form.get('password') ?? ''),
      ...(mode === 'sign-up' ? { name: String(form.get('name') ?? '') } : {}) }),
    cache: 'no-store', redirect: 'manual' }).catch(() => null);
  await account?.body?.cancel();
  if (!account?.ok) {
    return NextResponse.redirect(new URL(`/sign-in?next=${encodeURIComponent(next)}&error=${mode}`,
      request.url), 303);
  }
  const response = NextResponse.redirect(new URL(`/auth/start?next=${encodeURIComponent(next)}`,
    request.url), 303);
  for (const header of account.headers.getSetCookie()) response.headers.append('set-cookie', header);
  return response;
}
