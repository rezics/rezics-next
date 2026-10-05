// The franchise wiki Zone built on the scoped-subjects demo: the saga Work, which belongs to Canon and to Legends, in its
// franchise list, and Anakin in its characters list, so that a Character page read inside the Zone offers the continuity
// switch. Written through Main's public commands into the browser QA stack after the demo itself, as the Zone's own
// holder. The official franchise-wiki route segment is one per stack: when another journey has taken it this exits 3,
// and the journey skips its Zone step instead of failing the other one.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SeedApiError } from '../../../scripts/dev/seed/api.ts';
import type { ScopedSubjectManifest } from '../../../scripts/dev/seed/scoped-subjects.ts';
import { ZONE_PRESETS } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { scopedSubjectsFixture } from '../../../tests/qa/integration/scoped-subjects-support.ts';
import { manifest as zoneManifest, sourceDigest } from './g-849-records.ts';
import { createHash } from 'node:crypto';

if (!process.env.REZICS_QA_RUN_ID || !process.env.REZICS_WEB_AUTH_PRIVATE_PATH)
  throw new Error('Use the browser QA stack');
const runId = process.env.REZICS_QA_RUN_ID;
const directory = resolve('.temp/scoped-subjects-journey', runId);
const demo = JSON.parse(readFileSync(resolve(directory, 'seed.json'), 'utf8')) as ScopedSubjectManifest;
const web = JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH, 'utf8')) as { principalId: string; actingSubject: string };
const spec = zoneManifest();
const short = (ref: string) => ref.slice(-36);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const id = () => `https://rezics.com/id/${randomUUID()}`;
const h = await scopedSubjectsFixture();

/** A command Main has admitted but not yet applied answers 202; the same request under the same key settles it. */
async function settled<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await send(); } catch (error) {
      const pending = error instanceof SeedApiError && [202, 503].includes(error.status);
      if (!pending || attempt >= 120) throw error;
      await Bun.sleep(1000);
    }
  }
}

try {
  await (async () => {
    const holder = h.owner;
    const reviewer = await h.person('Zone theme reviewer');
    const api = h.api(holder);
    const post = <T>(path: string, body: object, key = randomUUID()) => settled(() => api.post<T>(path, body, key));
    /** A grant to `actor`, held through `principalId`, on a scope; the web member's own, or the reviewer's. */
    const grantTo = async (principalId: string, actor: string, scope: string, action: string) => {
      await h.stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await h.stack.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
      await h.stack.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };
    const grantReader = (scope: string, action: string) => grantTo(web.principalId, web.actingSubject, scope, action);
    await h.authorize('space:create:root', 'space.create');
    const space = await post<{ space: string; realm: string }>('/v1/spaces', { profile: 'space-realm-v2', handle: spec.routeSegment,
      name: spec.name, capabilities: ['realm'], actingSubject: holder.actor }).catch(error => {
      if (error instanceof SeedApiError && [409, 422].includes(error.status)) {
        console.error(`route segment held: ${error.detail}`);
        process.exitCode = 3;
        return null;
      }
      throw error;
    });
    if (!space) return;
    const zone = id();
    for (const [scope, action] of [[`zone:edit:${zone}`, 'zone.edit'], [`semantic:read:${zone}`, 'semantic.read'],
      [`zone:official:${zone}`, 'zone.official']] as const) await h.authorize(scope, action);
    let navigation = await post<{ revision: string }>('/v1/zones', { zone, space: space.space, disclosure: 'public',
      name: spec.name, language: spec.language, actingSubject: holder.actor });
    const members: Record<string, string[]> = { franchise: [demo.works.saga!.work], characters: [demo.subjects.anakin!] };
    const collections: Record<string, string> = {};
    for (const mount of spec.mounts) {
      const collection = id();
      collections[mount.id] = collection;
      await h.authorize(`collection:edit:${collection}`, 'collection.edit');
      await h.authorize(`semantic:read:${collection}`, 'semantic.read');
      const made = await post<{ structure: string; revision: string }>('/v1/collections', { collection, name: mount.name,
        language: spec.language, disclosure: 'public', actingSubject: holder.actor });
      let head = made.revision;
      for (const target of members[mount.id] ?? []) {
        head = (await post<{ revision: string }>(`/v1/collections/${short(collection)}/changes`, { expectedHead: head,
          actingSubject: holder.actor, operations: [{ op: 'insert', parent: made.structure, role: 'member', position: 'last', target }] })).revision;
      }
      navigation = await post(`/v1/zones/${short(zone)}/mounts`, { expectedHead: navigation.revision, target: collection,
        routeSegment: mount.routeSegment, position: 'last', disclosure: 'public', actingSubject: holder.actor });
    }
    // The web member reads the Zone's Work and Character as anyone does; the Work grant covers the reading position.
    await grantReader(`work:read:${demo.works.saga!.work}`, 'work.read');
    await grantReader(`semantic:read:${demo.subjects.anakin!}`, 'semantic.read');

    // The Zone is official under its route segment, and its package runs once Main reports the approval.
    const theme = id();
    const digest = await sourceDigest(spec.routeSegment);
    for (const [scope, action] of [['theme:create:root', 'theme.create'], [`theme:revise:${short(theme)}`, 'theme.revise'],
      [`theme:activate:${short(theme)}`, 'theme.activate']] as const) await h.authorize(scope, action);
    await grantTo(reviewer.principalId, reviewer.actor, `theme:review:${short(theme)}`, 'theme.review');
    // Theme approval needs the verified Account the fixture's own app presents, which the bare stack app does not.
    const command = async <T>(method: string, path: string, person: typeof holder, body: object, status: number): Promise<T> => settled(async () => {
      const key = randomUUID();
      const response = await h.call(person, method, path, { ...body, ...method === 'PUT' ? {} : { idempotencyKey: key } }, key);
      const text = await response.text();
      if (response.status !== status) throw new SeedApiError(`${method} ${path}`, response.status, text);
      return JSON.parse(text) as T;
    });
    await command('POST', '/v1/themes', holder, { theme: short(theme), owner: holder.actor, hostZone: zone, actingSubject: holder.actor }, 201);
    const entry = `assets/${spec.routeSegment}/main.js`;
    const revision = await command<{ operation: string }>('POST', `/v1/themes/${short(theme)}/revisions`, holder,
      { expectedRevision: null, bundle: { profile: 'first-party-bundle-v1', hostZone: zone, packageDigest: digest, entry,
        files: [{ path: entry, digest: sha(`${spec.routeSegment}:${digest}`), gzipBytes: 1000 }], slots: ['home', 'entity', 'memberIndex'],
        connectOrigins: [], imageOrigins: [], fontOrigins: [] }, actingSubject: holder.actor }, 201);
    await command('POST', `/v1/themes/${short(theme)}/revisions/${short(revision.operation)}/reviews`, reviewer,
      { decision: 'approved', reviewEvidenceDigest: sha(`reviewed ${digest}`), actingSubject: reviewer.actor }, 201);
    await command('POST', `/v1/themes/${short(theme)}/first-party-activations`, holder,
      { revision: revision.operation, expectedActivation: null,
        approvalExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), actingSubject: holder.actor }, 201);
    const current = await api.get<{ revision: string }>(`/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(holder.actor)}`);
    await command('PUT', `/v1/zones/${short(zone)}/configuration`, holder, { expectedHead: current.revision,
      actingSubject: holder.actor, name: spec.name, language: spec.language, defaultRealm: space.realm, official: {},
      presentation: { profile: 'zone-presentation-v2', preset: spec.preset, tokens: ZONE_PRESETS[spec.preset],
        navigation: spec.navigation, slides: [], official: { theme },
        modules: [{ id: 'works', type: 'shelf', title: 'Works', source: { kind: 'collection', collection: collections.franchise! },
          options: { layout: 'covers', limit: 12 } }] } }, 200);
    const zoneSeed = { zone, realm: space.realm, segment: spec.routeSegment, character: demo.subjects.anakin!, work: demo.works.saga!.work };
    writeFileSync(resolve(directory, 'zone.json'), JSON.stringify(zoneSeed));
    console.log(JSON.stringify(zoneSeed));
  })();
} finally {
  await h.stop();
}
