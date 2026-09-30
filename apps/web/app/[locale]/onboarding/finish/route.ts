import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { sameOriginWrite } from '../../../../features/api/origins.ts';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../../../../features/auth/cookies.ts';
import { safeReturnPath } from '../../../../features/auth/paths.ts';
import { changeHandle } from '../../../../features/onboarding/change-handle.ts';
import { ensureOnboarding } from '../../../../features/onboarding/ensure.ts';
import { isUiLocale } from '../../../../i18n/define.ts';
import { localizedPath } from '../../../../i18n/locale.ts';

export async function POST(request: Request, { params }: { params: Promise<{ locale: string }> }) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const { locale: requested } = await params;
  if (!isUiLocale(requested)) return new Response('Unknown locale', { status: 404 });
  const form = await request.formData();
  const next = safeReturnPath(String(form.get('next') ?? ''), localizedPath('/', requested));
  const back = (error: string) => new URL(`${localizedPath('/onboarding', requested)}?error=${error}&next=${encodeURIComponent(next)}`, request.url);
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  const sessionKey = jar.get(SESSION_KEY_COOKIE)?.value;
  if (!token || !sessionKey) return NextResponse.redirect(back('unavailable'), 303);
  // The typed name creates the Person; without one this continues an existing Person
  // (Main keeps an existing Person's name and never reads Account data for it).
  const typed = form.has('displayName') ? String(form.get('displayName')).trim() : undefined;
  if (typed !== undefined && (!typed || typed.length > 200 || /[\u0000-\u001f\u007f]/.test(typed))) {
    return NextResponse.redirect(back('invalid-name'), 303);
  }
  const outcome = await ensureOnboarding(token, sessionKey, undefined, undefined, typed);
  if (outcome.kind === 'invalid-name') return NextResponse.redirect(back('invalid-name'), 303);
  if (outcome.kind !== 'active') return NextResponse.redirect(back('unavailable'), 303);
  const changed = await changeHandle(token, outcome.person.agent, String(form.get('handle') ?? ''),
    null, String(form.get('key') ?? ''));
  if (changed !== 'changed') return NextResponse.redirect(back(changed), 303);
  return NextResponse.redirect(new URL(next, request.url), 303);
}
