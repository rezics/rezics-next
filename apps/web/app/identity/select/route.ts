import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { safeReturnPath } from '../../../features/auth/paths.ts';
import { sameOriginWrite } from '../../../features/api/origins.ts';

export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData();
  const subject = String(form.get('subject') ?? '').trim();
  const next = safeReturnPath(String(form.get('next') ?? ''));
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(subject)) {
    return NextResponse.redirect(new URL(`/identity?error=invalid&next=${encodeURIComponent(next)}`, request.url), 303);
  }
  const jar = await cookies();
  if (!jar.get('rezics_access')?.value) {
    return NextResponse.redirect(new URL(`/sign-in?next=${encodeURIComponent('/identity')}`, request.url), 303);
  }
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set('rezics_subject', subject, { httpOnly: true, sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 30 });
  return response;
}
