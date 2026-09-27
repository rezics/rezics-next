import { NextResponse } from 'next/server';
import { mainApi } from '../../../features/api/main.ts';
import { sameOriginWrite } from '../../../features/api/origins.ts';
import { agentOptions } from '../../../features/auth/acting-identity.ts';
import { safeReturnPath, signInPath } from '../../../features/auth/paths.ts';
import { readSession, sessionDiscovery } from '../../../features/auth/session.ts';
import { writeSessionAgent } from '../../../features/auth/session-state.ts';

/** Switches the session Agent to an Agent Main lists as eligible now, and
 * optionally saves it as the `work.create` default under compare-and-set. */
export async function POST(request: Request) {
  if (!sameOriginWrite(request)) return new Response('Origin mismatch', { status: 403 });
  const form = await request.formData();
  const agent = String(form.get('agent') ?? '');
  const next = safeReturnPath(String(form.get('next') ?? ''), '/');
  const back = (error: string) => new URL(`/identity?error=${error}&next=${encodeURIComponent(next)}`,
    request.url);
  if (!await readSession()) {
    return NextResponse.redirect(new URL(signInPath(`/identity?next=${encodeURIComponent(next)}`),
      request.url), 303);
  }
  const discovery = await sessionDiscovery();
  if (!discovery) return NextResponse.redirect(back('unavailable'), 303);
  if (!agentOptions(discovery).some(option => option.iri === agent)) {
    return NextResponse.redirect(back('invalid'), 303);
  }
  let destination = new URL(next, request.url);
  if (form.get('saveDefault') === 'on' && discovery.preferredActingSubject !== agent) {
    const revision = String(form.get('preferenceRevision') ?? '');
    const saved = await (await mainApi()).v1.me['acting-context-preferences']['work.create'].put({
      profile: 'work-create-acting-context-preference-v1', task: 'work.create', actingSubject: agent,
      // The revision the person saw: a default changed elsewhere since is reported, not overwritten.
      expectedRevision: revision || null, idempotencyKey: crypto.randomUUID(),
    }).catch(() => null);
    if (!saved || saved.error) {
      destination = back(saved?.error?.status === 409 ? 'stale-default' : 'default-not-saved');
    }
  }
  const response = NextResponse.redirect(destination, 303);
  writeSessionAgent(response.cookies, request.url, agent);
  return response;
}
