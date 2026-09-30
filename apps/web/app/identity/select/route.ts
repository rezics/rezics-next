import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { mainApi } from '../../../features/api/main.ts';
import { sameOriginWrite } from '../../../features/api/origins.ts';
import { identityOptions } from '../../../features/auth/acting-identity.ts';
import { SESSION_KEY_COOKIE } from '../../../features/auth/cookies.ts';
import { choiceKey } from '../../../features/auth/choice-key.ts';
import { safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { readSession, sessionAgents, sessionAgentState } from '../../../features/auth/session.ts';
import { isUiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';

/** Main compare-and-set switches this session; an optional second write saves
 * the account-wide main-Agent preference without retargeting other sessions. */
export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData();
  const agent = String(form.get('agent') ?? '');
  const requested = String(form.get('locale') ?? '');
  const locale = isUiLocale(requested) ? requested : 'en';
  const next = safeReturnPath(String(form.get('next') ?? ''), localizedPath('/', locale));
  const back = (error: string) => new URL(`${localizedPath('/identity', locale)}?error=${error}&next=${encodeURIComponent(next)}`,
    request.url);
  if (!await readSession()) {
    return NextResponse.redirect(new URL(signInPath(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(next)}`),
      request.url), 303);
  }
  const [discovery, state, jar] = await Promise.all([
    sessionAgents(), sessionAgentState(), cookies()]);
  const sessionKey = jar.get(SESSION_KEY_COOKIE)?.value;
  if (!discovery || !state || !sessionKey) return NextResponse.redirect(back('unavailable'), 303);
  if (!identityOptions(discovery).some(option => option.iri === agent)) {
    return NextResponse.redirect(back('invalid'), 303);
  }
  const main = await mainApi();
  const sessionRevision = String(form.get('sessionRevision') ?? '') || null;
  const selected = await main.v1.me['session-agent'].put({
    actingSubject: agent, expectedRevision: sessionRevision,
  }, { headers: { 'x-session-key': sessionKey,
    // The same form submitted again replays instead of failing as stale.
    'idempotency-key': choiceKey('session', sessionKey, sessionRevision, agent) } }).catch(() => null);
  if (!selected || selected.error) {
    const error = selected?.error?.status === 409 ? 'stale-session'
      : selected?.error?.status === 403 ? 'invalid' : 'unavailable';
    return NextResponse.redirect(back(error), 303);
  }
  let destination = new URL(next, request.url);
  if (form.get('saveDefault') === 'on' && state.mainAgent.actingSubject !== agent) {
    const revision = String(form.get('preferenceRevision') ?? '');
    const saved = await main.v1.me['main-agent-preference'].put({ actingSubject: agent,
      // The revision the person saw: a default changed elsewhere since is reported, not overwritten.
      expectedRevision: revision || null,
    }, { headers: { 'idempotency-key': choiceKey('main', revision, agent) } }).catch(() => null);
    if (!saved || saved.error) {
      destination = back(saved?.error?.status === 409 ? 'stale-default' : 'default-not-saved');
    }
  }
  return NextResponse.redirect(destination, 303);
}
