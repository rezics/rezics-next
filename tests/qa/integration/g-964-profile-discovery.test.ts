import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { configureNamePreferences } from '../../../services/main/src/modules/search/name-preferences.ts';

test('G-964: Agent works, collections, contributions and ratings emit live listing and HTTP discovery signals on empty pages', async () => {
  const s = await startMediaStack('g-964-profile', { profileCredits: true });
  try {
    const owner = await s.member('visibility-owner');
    await owner.grant('work:create:root', 'agent.control');
    await configureNamePreferences(s.env, s.accessPool);
    const app = createMainApp(s.fuseki, { environment: s.env, access: s.access,
      profiles: new ProfilesAccess(s.accessPool), personPreferences: new PersonPreferencesStore(s.accessPool),
      account: { verify: async () => owner.principal } });
    const root = `/v1/agents/${owner.actor.slice(-36)}`, acting = `actingSubject=${encodeURIComponent(owner.actor)}`;
    const paths = [`${root}/works`, `${root}/collections`, `/v1/me/contributions?${acting}`, `/v1/me/ratings?scope=global&${acting}`];
    for (const [version, listing] of [[0, 'unlisted'], [1, 'listed']] as const) {
      const response = await app.handle(new Request(`http://main.local${root}/listing`, { method: 'PUT',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ listing, expectedVersion: version }) }));
      expect(response.status, await response.text()).toBe(200);
      for (const path of paths) {
        const reading = await app.handle(new Request(`http://main.local${path}`, { headers: path.startsWith('/v1/me/')
          ? { authorization: `Bearer ${owner.token}` } : {} }));
        const body = await reading.json();
        expect(reading.status, JSON.stringify(body)).toBe(200);
        expect(body).toMatchObject({ items: [], listing, discovery: { indexable: listing === 'listed' && !path.startsWith('/v1/me/') } });
        expect(reading.headers.get('referrer-policy')).toBe(listing === 'unlisted' ? 'no-referrer' : null);
        expect(reading.headers.get('x-robots-tag')).toBe(listing === 'unlisted' || path.startsWith('/v1/me/') ? 'noindex' : null);
      }
    }
  } finally { await s.stop(); }
}, 180_000);
