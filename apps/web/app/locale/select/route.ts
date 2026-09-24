import { NextResponse } from 'next/server';
import { sameOriginWrite } from '../../../features/api/origins.ts';
import { LOCALE_COOKIE } from '../../../i18n/locale.ts';

export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData();
  const locale = form.get('locale');
  if (locale !== 'en' && locale !== 'zh-CN') return new Response('Unsupported locale', { status: 400 });
  const origin = new URL(request.url).origin;
  const referer = request.headers.get('referer');
  let returnPath = '/';
  if (referer) {
    try {
      const source = new URL(referer);
      const candidate = source.pathname + source.search;
      if (source.origin === origin && /^\/(?!\/)[^\\\r\n]*$/.test(candidate)) returnPath = candidate;
    } catch { /* A missing or invalid referrer returns to the home page. */ }
  }
  const response = NextResponse.redirect(new URL(returnPath, origin), 303);
  response.cookies.set(LOCALE_COOKIE, locale, { httpOnly: true, sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 365 });
  return response;
}
