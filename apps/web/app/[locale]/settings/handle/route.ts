import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { sameOriginWrite } from '../../../../features/api/origins.ts';
import { ACCESS_COOKIE } from '../../../../features/auth/cookies.ts';
import { readSession } from '../../../../features/auth/session.ts';
import { changeHandle } from '../../../../features/onboarding/change-handle.ts';
import { currentVanityHandle } from '../../../../features/onboarding/handle.ts';
import { isUiLocale } from '../../../../i18n/define.ts';
import { localizedPath } from '../../../../i18n/locale.ts';

export async function POST(request: Request, { params }: { params: Promise<{ locale: string }> }) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const { locale: requested } = await params;
  if (!isUiLocale(requested)) return new Response('Unknown locale', { status: 404 });
  const form = await request.formData();
  const back = (code: string) => new URL(`${localizedPath('/settings', requested)}?error=${code}`, request.url);
  const session = await readSession();
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token || !session || session.agent.status !== 'selected') {
    return NextResponse.redirect(back('denied'), 303);
  }
  const agent = session.agent.agent;
  if (form.get('agent') !== agent.iri || form.get('expectedHandle') !== (agent.handle ?? '')) {
    return NextResponse.redirect(back('conflict'), 303);
  }
  const changed = await changeHandle(token, agent.iri, String(form.get('handle') ?? ''),
    currentVanityHandle(agent.handle), String(form.get('key') ?? ''));
  if (changed !== 'changed') return NextResponse.redirect(back(changed), 303);
  return NextResponse.redirect(new URL(`${localizedPath('/settings', requested)}?updated=handle`, request.url), 303);
}
