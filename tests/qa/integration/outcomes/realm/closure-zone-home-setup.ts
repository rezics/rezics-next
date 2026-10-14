import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { PersonaSession, PersonaSessions } from '../../../support/personas.ts';

const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

/** Keep the same reader for delivery and absence controls without replacing their query. */
export function closureZoneReadPath(path: string, person: Pick<PersonaSession, 'actingSubject'>): string {
  if (!person.actingSubject) return path;
  return `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(person.actingSubject)}`;
}

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

/** The independent Zone publishes its separately prepared home document. */
export async function prepareClosureZoneHome(sessions: PersonaSessions, original: { work: string }) {
  const owner = sessions.owner;
  const root = `/v1/zones/${short(sessions.zone)}`;
  const config = await answer<{ revision: string }>(owner.main('GET', `${root}/configuration?${acting(owner)}`));
  await answer(owner.main('PUT', `${root}/configuration`, {
    actingSubject: owner.actingSubject, expectedHead: config.revision, defaultRealm: sessions.realm,
    prepareHomeDocument: true,
    presentation: {
      profile: 'zone-presentation-v2', preset: 'clean',
      tokens: {
        colorScheme: 'system', accent: '#2563eb', density: 'comfortable',
        cardRadius: 'md', headingFontScale: 'md', surfaceTint: 'none',
        fontPairing: 'sans', pageSurface: 'flat', coverStyle: 'portrait', titleEffect: 'plain',
      },
      navigation: [], slides: [], modules: [{
      id: 'latest', type: 'shelf', title: 'Original Realm adoptions',
      source: { kind: 'query-block', block: 'new-adoptions' },
      }],
    },
  }));
  const prepared = await answer<{ configuration: { homeDocument: string } }>(
    owner.main('GET', `${root}/configuration?${acting(owner)}`),
  );
  const homeDocument = prepared.configuration.homeDocument;
  expect(homeDocument).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(homeDocument).not.toBe(sessions.zone);
  const navigation = await answer<{ revision: string }>(owner.main('GET', `${root}?${acting(owner)}`));
  const mount = await answer<{ revision: string }>(owner.main('POST', `${root}/mounts`, {
    expectedHead: navigation.revision, target: original.work, routeSegment: 'original',
    disclosure: 'public', actingSubject: owner.actingSubject,
  }));
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead: null,
      document: fromPlainText('Independent original Zone home document', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      actingSubject: owner.actingSubject,
    }), 201,
  );
  const current = await answer<{ revision: string; configuration: { homeDocument: string } }>(
    owner.main('GET', `${root}/configuration?${acting(owner)}`),
  );
  expect(current.configuration.homeDocument).toBe(homeDocument);
  // Zone site publication has no rights-basis input; this fixture authors its
  // own home document and does not infer an imported license.
  const published = await answer<{ homeDocument: string; homeRevision: string; routesRevision: string;
    navigationRevision: string; pages: { page: string; variantId: string; revisionId: string }[] }>(owner.main('POST', `${root}/site-publications`, {
    routesRevision: mount.revision, navigationRevision: mount.revision,
    expectedHead: current.revision, actingSubject: owner.actingSubject,
    pages: [{ page: homeDocument, variantId, revisionId: draft.revisionId,
      byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }), 201);
  return { homeDocument, variantId, draft, mount, published };
}
