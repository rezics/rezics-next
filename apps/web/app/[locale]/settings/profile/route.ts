import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { sameOriginWrite } from '../../../../features/api/origins.ts';
import { readAgentProfile } from '../../../../features/auth/agent-profile.ts';
import { ACCESS_COOKIE } from '../../../../features/auth/cookies.ts';
import { readSession } from '../../../../features/auth/session.ts';
import { type AvatarReport, profileSaveInput, saveAgentProfile } from '../../../../features/settings/profile-api.ts';
import { isUiLocale } from '../../../../i18n/define.ts';
import { localizedPath } from '../../../../i18n/locale.ts';

export async function POST(request: Request, { params }: { params: Promise<{ locale: string }> }) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const { locale } = await params;
  if (!isUiLocale(locale)) return new Response('Unknown locale', { status: 404 });
  const back = (code: string) => new URL(`${localizedPath('/settings', locale)}?error=${code}`, request.url);
  const session = await readSession();
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token || !session || session.agent.status !== 'selected') {
    return NextResponse.redirect(back('denied'), 303);
  }
  const form = await request.formData();
  const agent = session.agent.agent.iri;
  if (form.get('agent') !== agent) return NextResponse.redirect(back('denied'), 303);
  const profile = await readAgentProfile(agent, token);
  if (!profile) return NextResponse.redirect(back('unavailable'), 303);
  if (profile.revision !== form.get('expectedHead')) return NextResponse.redirect(back('conflict'), 303);
  const file = form.get('avatar');
  const report: AvatarReport = {};
  const result = await saveAgentProfile(profileSaveInput(profile, {
    token, agent, displayName: String(form.get('displayName') ?? ''),
    bioText: String(form.get('bio') ?? ''), bioLanguage: String(form.get('bioLanguage') ?? ''), avatar: file instanceof File && file.size ? file : undefined,
    removeAvatar: form.get('removeAvatar') === 'on', key: String(form.get('key') ?? ''), report,
  }));
  // A new avatar's check and a spent upload budget are told on the page that follows.
  if (result !== 'saved') {
    const target = back(result);
    if (report.retryAfter) target.searchParams.set('wait', String(report.retryAfter));
    return NextResponse.redirect(target, 303);
  }
  const saved = new URL(`${localizedPath('/settings', locale)}?updated=profile`, request.url);
  if (report.clearance) saved.searchParams.set('avatar', report.clearance);
  return NextResponse.redirect(saved, 303);
}
