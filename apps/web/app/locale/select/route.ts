import { NextResponse } from 'next/server';
import { sameOriginWrite } from '../../../features/api/origins.ts';
import { LOCALE_COOKIE, localizedPath } from '../../../i18n/locale.ts';
import { isUiLocale } from '../../../i18n/define.ts';

export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData();
  const locale = form.get('locale');
  if (typeof locale !== 'string' || !isUiLocale(locale)) return new Response('Unsupported locale', { status: 400 });
  const origin = new URL(request.url).origin;
  const referer = request.headers.get('referer');
  let returnPath = `/${locale}`;
  if (referer) {
    try {
      const source = new URL(referer);
      const candidate = source.pathname + source.search;
      if (source.origin === origin && /^\/(?!\/)[^\\\r\n]*$/.test(candidate)) {
        returnPath = `${localizedPath(source.pathname, locale)}${source.search}`;
      }
    } catch { /* A missing or invalid referrer returns to the home page. */ }
  }
  const response = NextResponse.redirect(new URL(returnPath, origin), 303);
  response.cookies.set(LOCALE_COOKIE, locale, { httpOnly: true, sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 365 });
  return response;
}
