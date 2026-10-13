import { platformOperationOpen, type PlatformAccessSummary } from '../../../generated/openapi/main/exposure.ts';
import type { OutcomeRecorder } from './outcome-test.ts';
import type { PersonaName, PersonaSession } from './personas.ts';

/** Record the server frame's anonymous and personal reads without changing the reader's identity. */
export async function recordFrameReads(
  recording: OutcomeRecorder,
  persona: PersonaName,
  session: PersonaSession,
  visitor: PersonaSession,
  realm: string,
  zone: string | null,
  addressScope: string,
  addressKey: string,
  path: string,
): Promise<void> {
  const publicRead = recording.session(persona, visitor);
  const personalRead = recording.session(persona, session);
  const root = `/v1/realms/${realm.slice(-36)}`;
  const subject = session.actingSubject;
  const viewer = (url: string) => subject
    ? `${url}${url.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(subject)}`
    : url;
  const read = async (sample: ReturnType<OutcomeRecorder['session']>, label: string, url: string,
    headers?: Record<string, string>): Promise<Response> => {
    const response = await sample(label, 'GET', url, undefined, undefined, { headers });
    if (response.status >= 500) throw new Error(`Frame read ${url}: HTTP ${response.status}: ${await response.text()}`);
    return response;
  };
  const discard = async (pending: Promise<Response>) => { await (await pending).body?.cancel(); };
  await discard(read(publicRead, 'frame-realm-header', root));
  await discard(read(publicRead, 'frame-facets', '/v1/facets'));
  await discard(read(publicRead, 'frame-address', `/v1/addresses/resolve?${new URLSearchParams({
    scope: addressScope, key: addressKey,
  })}`, { 'accept-language': 'en', 'x-rezics-display-languages': 'en' }));
  if (zone) {
    const zoneRoot = `/v1/zones/${zone.slice(-36)}`;
    let after: string | null = null;
    const cursors = new Set<string>();
    do {
      const response = await read(personalRead, after ? `frame-presentation-${cursors.size}` : 'frame-presentation',
        viewer(`${zoneRoot}/presentation${after ? `?after=${encodeURIComponent(after)}` : ''}`));
      const page = response.ok ? await response.json() as { navigationComplete: boolean; navigationNext: string | null } : null;
      if (!response.ok) await response.body?.cancel();
      after = page && !page.navigationComplete ? page.navigationNext : null;
      if (after && cursors.has(after)) throw new Error('Frame navigation repeated a cursor');
      if (after) cursors.add(after);
    } while (after);
    await discard(read(personalRead, 'frame-routes', `${zoneRoot}/routes?${new URLSearchParams({
      ...(subject ? { actingSubject: subject } : {}), path,
    })}`));
  }
  if (!subject) return;
  await discard(read(personalRead, 'frame-joining', viewer(`${root}/joining`)));
  await discard(read(personalRead, 'frame-follow', viewer(`/v1/follows/${realm.slice(-36)}?kind=realm`)));
  const access = await read(personalRead, 'frame-platform-access', '/v1/me/platform-access');
  const platform = access.ok ? await access.json() as PlatformAccessSummary : null;
  if (!access.ok) await access.body?.cancel();
  if (platform && platformOperationOpen('getV1RealmsByRealmMember-ban', platform))
    await discard(read(personalRead, 'frame-member-ban', viewer(`${root}/member-ban`)));
  // PersonaSession.main owns the same opaque x-session-key header as the web session.
  await discard(read(personalRead, 'frame-session-agent', '/v1/me/session-agent'));
  await discard(read(personalRead, 'frame-person-preferences', viewer('/v1/me/person-preferences')));
}
