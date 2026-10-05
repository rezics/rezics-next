import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { configureNamePreferences, namePreferencesProjection } from '../../../services/main/src/modules/search/name-preferences.ts';
import { backfillPublicNameProjections } from '../../../services/main/src/modules/search/backfill.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { configureDisclosure, configureDisclosurePool, DisclosureStore } from '../../../services/main/src/modules/disclosure/read.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';

interface Page { items: { id: string; realm?: string }[]; nextCursor: string | null; complete: boolean }

test('G-964: query, name search and Discover page only listed public Spaces; suggestions exclude a hidden cohort larger than their candidate window', async () => {
  const h = await startHomeStack('g-964-discovery');
  const { stack: s, author: owner } = h;
  try {
    const token = `g964${randomUUID().replaceAll('-', '')}`;
    await owner.grant('work:create:root', 'agent.control');
    await owner.grant('space:create:root', 'space.create');
    await configureNamePreferences(s.env, s.accessPool);
    const disclosure = new DisclosureStore(s.accessPool);
    configureDisclosurePool(s.accessPool, disclosure);
    configureDisclosure(s.env, disclosure);
    const admin = new AccessRealmManagement(s.accessPool);
    const app = createMainApp(s.fuseki, { ...h.deps, realmAdmin: admin, mediaAccess: s.mediaAccess,
      discovery: new DiscoveryProjection(s.accessPool), suitability: new SuitabilityStore(s.accessPool, s.access),
      personPreferences: new PersonPreferencesStore(s.accessPool, namePreferencesProjection(s.env)) });
    const call = (path: string, body?: object, method = body ? 'POST' : 'GET', bearer?: string) => app.handle(
      new Request(`http://main.local${path}`, { method, headers: { 'accept-language': 'en',
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined }));
    const realms: string[] = [], zones: string[] = [], hidden: string[] = [];
    const work = await s.publicWork(owner.actor, ['en'], `${token} sample`);
    // Hidden resources are newer than every eligible resource and exceed the
    // suggestions owner's twelve-Realm candidate window. A post-page filter
    // either leaks them or starves the visible tail.
    for (let n = 0; n < 19; n++) {
      const community = await h.json<{ realm: string; space: string }>(await call('/v1/spaces',
        { profile: 'space-realm-v1', name: `${token} community ${n}`, language: 'en', capabilities: ['realm'], actingSubject: owner.actor },
        'POST', owner.token), 201);
      const zone = `https://rezics.com/id/${randomUUID()}`;
      await owner.grant(`zone:edit:${zone}`, 'zone.edit');
      await h.json(await call('/v1/zones', { zone, space: community.space, disclosure: 'public', actingSubject: owner.actor },
        'POST', owner.token), 201);
      await admin.initialize(owner.principal, community.realm, owner.actor, s.env);
      const adoption = { context: { kind: 'realm-local' as const, id: community.realm }, work: work.work,
        mainVersion: work.mainVersion, contribution: work.variants[0]!.contribution,
        publicationDecision: work.variants[0]!.decision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review' as const, actingSubject: owner.actor };
      expect((await selectRealmLocal(s.env, s.admission(owner.actor, `publication:adopt:${community.realm}`,
        'publication.adopt', realmSelectionDigest(adoption)), adoption)).outcome).toBe('succeeded');
      if (n < 3) { realms.push(community.realm); zones.push(zone); }
      else {
        hidden.push(community.realm, zone);
        const current = await admin.spaceSettings(owner.principal, community.space, owner.actor, s.env);
        await admin.changeSpaceSettings(owner.principal, community.space,
          { actingSubject: owner.actor, expectedGeneration: current.generation, reason: 'Exclude this resource from public discovery',
            settings: { visibility: n < 17 ? 'public' : 'private', listing: n < 17 ? 'unlisted' : 'listed',
              history: 'everything', admission: 'invitation' } }, randomUUID(), s.env);
      }
    }
    expect((await backfillPublicNameProjections(s.env, s.accessPool, 64)).complete).toBe(true);
    await owner.grant(MANAGE_SCOPE, MANAGE_ACTION);
    let built = await h.json<{ generation: string; checkpoint: string; complete: boolean }>(await call('/v1/discovery/generation-builds',
      { profile: 'discovery-generation-build-v1', actingSubject: owner.actor, basis: { scope: 'global', realm: null, context: null } },
      'POST', owner.token));
    while (!built.complete) {
      const checkpoint = built.checkpoint;
      built = await h.json(await call(`/v1/discovery/generations/${built.generation}/advance`,
        { actingSubject: owner.actor, expectedCheckpoint: built.checkpoint }, 'POST', owner.token));
      expect(built.complete || built.checkpoint !== checkpoint).toBe(true);
    }
    expect(built.complete).toBe(true);
    const head = await h.json<{ activeHeadRevision: string | null }>(await call(
      `/v1/discovery/generations/${built.generation}?actingSubject=${encodeURIComponent(owner.actor)}`, undefined, 'GET', owner.token));
    await h.json(await call('/v1/discovery/generation-activations', { profile: 'discovery-generation-activation-v1',
      actingSubject: owner.actor, generation: built.generation, expectedHeadRevision: head.activeHeadRevision }, 'POST', owner.token));
    await waitForRealmDirectory(s.env, () => call(`/v1/realms?q=${token}`),
      page => page.items.length === realms.length && page.items.every(item => realms.includes(item.id)));
    for (const [type, expected] of [[`${RV}Realm`, realms], [`${RV}Zone`, zones], [`${RV}Space`, [...realms, ...zones]]] as const)
      for (const sort of ['newest', 'relevance']) {
        let cursor: string | null = null;
        const found: string[] = [];
        for (let page = 0; page < 30; page++) {
          const result = (await h.json<{ result: Page }>(await call('/v1/query',
            { profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort, q: token,
              limit: 1, ...(cursor ? { cursor } : {}), filter: { all: [{ facet: 'type', any: [type] }] } }))).result;
          if (found.length < expected.length) expect(result.items).toHaveLength(1);
          found.push(...result.items.map(item => item.id));
          if (result.complete) break;
          expect(result.nextCursor).not.toBeNull();
          cursor = result.nextCursor;
        }
        expect(found.sort()).toEqual([...expected].sort());
      }
    for (const [section, expected] of [['communities', realms], ['sites', zones]] as const) {
      let cursor: string | null = null;
      const found: string[] = [];
      for (let page = 0; page < 10; page++) {
        const result = (await h.json<{ items: { page: Page }[] }>(await call(`/v1/discovery/sections?section=${section}&q=${token}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))).items[0]!.page;
        if (found.length < expected.length) expect(result.items).toHaveLength(1);
        found.push(...result.items.map(item => item.id));
        if (result.complete) break;
        cursor = result.nextCursor;
      }
      expect(found.sort()).toEqual([...expected].sort());
    }
    const suggestions = await h.json<{ items: { id: string; realm: string }[] }>(await call('/v1/onboarding/suggested-follows'));
    expect(suggestions.items.some(item => hidden.includes(item.id) || hidden.includes(item.realm))).toBe(false);
    expect(suggestions.items.filter(item => realms.includes(item.realm)).length).toBeGreaterThan(0);
  } finally { await h.stop(); }
}, 300_000);
