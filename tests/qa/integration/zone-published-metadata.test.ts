import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { fromPlainText } from '@rezics/document';
import type { CanonicalAddress } from '@rezics/model/address';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration, readZoneRevisionConfiguration, readZoneSitePublicationReceipt,
  type ZoneSitePublicationReceipt } from '../../../services/main/src/modules/zone/configuration.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

const INITIAL_NAME = 'Published site';
interface Metadata { name: string; language: string; direction: 'ltr' | 'rtl' }
interface Summary { reference: string; status: string; type: string;
  name: { value: string; language: string; direction: string }; address: CanonicalAddress }
interface Presentation extends Metadata { revision: string; address: CanonicalAddress;
  home?: { reference: { revisionId: string } } }
interface Home extends Metadata { kind: string; revision: string;
  page?: { reference: { revisionId: string } } }
interface Page { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }

async function fixture(documentSite = false) {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-published-metadata-${randomUUID()}`),
    'openid work:create work:edit work:read space:create zone:edit owner:operate');
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try {
      await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [f.account.a.id]);
    } finally { await accountPool.end(); }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    await f.authoredBody({ actingSubject: f.actor });
    // Content authoring needs a live direct controller as well as stewardship.
    const controlId = randomUUID();
    await f.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity'::timestamptz)`, [controlId, f.principalId, f.actor]);
    await f.accessPool.query(`INSERT INTO access.agent_provision
      (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
        display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
      VALUES ($1,$2,$3,$4,$5,'person','QA fixture author',0,'active',$6,0,$7)`,
    [randomUUID(), f.principalId, randomUUID(), 'a'.repeat(64), f.actor, f.env.lineage.dataEpoch, controlId]);
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const content = new ContentCore(f.pool);
    let revokeBeforeSwitch = false;
    let siteSpace: string;
    let zoneGrant: string;
    let zoneResourceGrant: string | null = null;
    const revokeEditor = async () => {
      const replacement = nativeId();
      const profile = { kind: 'person' as const, displayName: 'Replacement site owner' };
      await createAgentGraph(f.env, { id: randomUUID(), agent: replacement,
        ...profile, digest: agentProvisionDigest(profile) });
      await f.env.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
        DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(siteSpace)} rv:owner ${iri(f.actor)} } }
        INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(siteSpace)} rv:owner ${iri(replacement)} } }
        WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(siteSpace)} rv:owner ${iri(f.actor)} } }`);
      await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [zoneGrant]);
      if (zoneResourceGrant) await f.accessPool.query(`UPDATE access.principal_permission_grant
        SET active = false, generation = generation + 1 WHERE id = $1`, [zoneResourceGrant]);
    };
    const access = new Proxy(f.access, { get(target, property) {
      if (property === 'withOwnerAuthority') return async (...args: Parameters<typeof target.withOwnerAuthority>) => {
        if (revokeBeforeSwitch && args[0].action === 'zone.edit') {
          revokeBeforeSwitch = false;
          // Revoke between Content preparation and the final publication fence.
          await revokeEditor();
        }
        return target.withOwnerAuthority(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
      access, content, contentAuthoring: content, catalogueIntake: f.catalogueIntake });
    const call = (method: string, path: string, body?: object, key = randomUUID(),
      token: string | null = f.account.tokenA) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string; realm?: string; zone?: string; navigationRevision?: string }>(
      await call('POST', '/v1/spaces', { profile: documentSite ? 'space-zone-v1' : 'space-realm-v1',
        name: INITIAL_NAME, language: 'en', capabilities: [documentSite ? 'zone' : 'realm'], actingSubject: f.actor }), 201);
    siteSpace = space.space;
    const zone = space.zone ?? nativeId();
    zoneGrant = await f.grant(`zone:edit:${zone}`, 'zone.edit');
    const navigationRevision = space.navigationRevision ?? (await f.json<{ revision: string }>(
      await call('POST', '/v1/zones', { zone, space: space.space, disclosure: 'public',
        name: INITIAL_NAME, language: 'en', actingSubject: f.actor }), 201)).revision;
    const path = `/v1/zones/${shortId(zone)}`;
    const configure = async (patch: object, expectedHead?: string) => f.json<{ revision: string }>(
      await call('PUT', `${path}/configuration`, {
        expectedHead: expectedHead ?? (await readZoneConfiguration(f.env, zone)).revision,
        ...patch, actingSubject: f.actor,
      }), 200);
    if (!documentSite) {
      // A separately created Realm Zone has no Zone Space creation receipt.
      // Its Content bridge uses the supported administrator resource proof.
      await grantRecordedPlatformUse(f.accessPool, f.principalId, ['platform-admin'], f.actor);
      zoneResourceGrant = randomUUID();
      await f.accessPool.query(`INSERT INTO access.principal_permission_grant
        (id, issuer_subject, principal_id, scope_id, action, valid_until)
        VALUES ($1,$2,$3,$4,'platform:resource:zone.edit','infinity'::timestamptz)`,
      [zoneResourceGrant, f.actor, f.principalId, `zone:edit:${zone}`]);
      await f.accessPool.query(`INSERT INTO access.platform_grant_episode
        (id, principal_grant_id, issuer_subject, permission, scope_id, assigned_by_principal, receipt)
        VALUES ($1,$1,$2,'platform:resource:zone.edit',$3,$4,$5)`,
      [zoneResourceGrant, f.actor, `zone:edit:${zone}`, f.principalId,
        `urn:rezics:access-receipt:${createHash('sha256').update(zoneResourceGrant).digest('hex')}`]);
      await f.grant(`zone:official:${zone}`, 'zone.official');
      await configure({ official: {}, defaultRealm: space.realm });
    }
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const save = async (text = 'Published home', expectedHead: string | null = null): Promise<Page> => {
      const saved = await f.json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
        await call('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: zone, variantId,
          expectedHead, document: fromPlainText(text, 'blocks'),
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: f.actor }), 201);
      return { page: zone, variantId, revisionId: saved.revisionId,
        byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch };
    };
    const pages = [await save()];
    const publish = async (key = randomUUID(), expectedHead?: string, selectedPages = pages) =>
      call('POST', `${path}/site-publications`, { routesRevision: navigationRevision, navigationRevision,
        pages: selectedPages, expectedHead: expectedHead ?? (await readZoneConfiguration(f.env, zone)).revision,
        actingSubject: f.actor }, key);
    const publicCall = (method: string, url: string, body?: object) => call(method, url, body, randomUUID(), null);
    const presentation = async () => f.json<Presentation>(await publicCall('GET', `${path}/presentation`), 200);
    const home = async () => f.json<Home>(await publicCall('GET', `${path}/routes?path=%2F`), 200);
    const publicMetadata = async () => {
      const resource = await f.json<Summary>(await publicCall('GET', `/v1/resources/${shortId(zone)}`), 200);
      const batch = await f.json<{ summaries: Summary[] }>(await publicCall('POST', '/v1/resources/summaries',
        { profile: 'resource-summary-batch-v1', resources: [zone] }), 200);
      const listing = await f.json<{ items: Array<{ zone: string; address: CanonicalAddress }> }>(
        await publicCall('GET', '/v1/zones?official=true'), 200);
      return { resource, summary: batch.summaries[0]!, official: listing.items.find(item => item.zone === zone),
        presentation: await presentation(), home: await home() };
    };
    return { ...f, zone, path, pages, content, configure, save, publish, call, publicMetadata, presentation, home,
      revokeBeforeSwitch: () => { revokeBeforeSwitch = true; },
      switchRevocationConsumed: () => !revokeBeforeSwitch };
  } catch (error) { await f.close(); throw error; }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function expectPublicMetadata(read: Awaited<ReturnType<Fixture['publicMetadata']>>,
  metadata: Metadata, revision: string, pageRevision: string) {
  for (const summary of [read.resource, read.summary]) {
    expect(summary).toMatchObject({ status: 'available', type: 'zone',
      name: { value: metadata.name, language: metadata.language, direction: metadata.direction } });
    expect(summary.address.suffixSource).toBe(metadata.name);
  }
  expect(read.official).toMatchObject({ address: { suffixSource: metadata.name } });
  expect(read.official!.address).toEqual(read.resource.address);
  expect(read.summary.address).toEqual(read.resource.address);
  expect(read.presentation).toMatchObject({ ...metadata, revision, address: read.resource.address,
    home: { reference: { revisionId: pageRevision } } });
  expect(read.home).toMatchObject({ ...metadata, kind: 'home', revision,
    page: { reference: { revisionId: pageRevision } } });
}

test('configuration drafts preserve published names and address suffixes across every anonymous reader until publish', async () => {
  const f = await fixture();
  try {
    const first = await f.json<ZoneSitePublicationReceipt>(await f.publish(), 201);
    const original = { name: INITIAL_NAME, language: 'en', direction: 'ltr' as const };
    expectPublicMetadata(await f.publicMetadata(), original, first.revision, f.pages[0]!.revisionId);
    const draft = { name: 'مكتبة الغد', language: 'ar', direction: 'rtl' as const };
    const edited = await f.configure({ name: draft.name, language: draft.language });
    const editor = await f.json<Metadata & { revision: string }>(await f.call('GET',
      `${f.path}/configuration?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(editor).toMatchObject({ ...draft, revision: edited.revision });
    const retained = await f.configure({ budget: { timeMs: 100, rows: 10 } });
    const state = await readZoneConfiguration(f.env, f.zone);
    expect(state).toMatchObject({ ...draft, revision: retained.revision, publicationRevision: first.revision });
    expect(await readZoneRevisionConfiguration(f.env, state, edited.revision)).toMatchObject(draft);
    expectPublicMetadata(await f.publicMetadata(), original, first.revision, f.pages[0]!.revisionId);
    // A stale publication cannot leak its draft through a failed bundle switch.
    expect((await f.publish(randomUUID(), edited.revision)).status).toBe(409);
    expectPublicMetadata(await f.publicMetadata(), original, first.revision, f.pages[0]!.revisionId);
    const second = await f.json<ZoneSitePublicationReceipt>(await f.publish(), 201);
    expect(second.themeRevision).toBe(retained.revision);
    expectPublicMetadata(await f.publicMetadata(), draft, second.revision, f.pages[0]!.revisionId);
    expect(await readZoneRevisionConfiguration(f.env, await readZoneConfiguration(f.env, f.zone), first.themeRevision))
      .toMatchObject(original);
  } finally { await f.close(); }
}, 120_000);

test('lost publication response promotes metadata once and replay never promotes a later draft', async () => {
  const f = await fixture();
  try {
    await f.json(await f.publish(), 201);
    const selected = { name: 'Published after retry', language: 'en', direction: 'ltr' as const };
    const draft = await f.configure({ name: selected.name, language: selected.language });
    const key = randomUUID();
    const original = f.env.fuseki;
    let commands = 0, lost = false;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
        const result = await target.commandWithReceipt(...args);
        if (args[0].update.includes('rv:sitePublicationRevision')) {
          commands++;
          if (!lost) { lost = true; throw new Error('lost publication acknowledgement'); }
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const first = await f.json<ZoneSitePublicationReceipt & { replayed: boolean }>(await f.publish(key, draft.revision), 201);
    expect(lost).toBe(true);
    expectPublicMetadata(await f.publicMetadata(), selected, first.revision, f.pages[0]!.revisionId);
    const later = await f.configure({ name: 'Unpublished after retry', language: 'en' });
    const settledPosition = await f.content.ownerPosition();
    const replay = await f.json<ZoneSitePublicationReceipt & { replayed: boolean }>(await f.publish(key, draft.revision), 200);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(commands).toBe(1);
    expect(await f.content.ownerPosition()).toEqual(settledPosition);
    expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(later.revision);
    expectPublicMetadata(await f.publicMetadata(), selected, first.revision, f.pages[0]!.revisionId);
    const { replayed: _replayed, ...proof } = first;
    expect(await readZoneSitePublicationReceipt(f.env, first.receipt)).toEqual(proof);
    const receipts = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:sitePublicationRevision ${iri(first.revision)} ;
        rv:structureOwner ${iri(f.zone)} . }
    } LIMIT 3`, 4096);
    expect(receipts.results?.bindings).toHaveLength(1);
    f.env.fuseki = original;
  } finally { await f.close(); }
}, 120_000);

test('revoking the editor after Content pinning cannot promote their draft metadata', async () => {
  const f = await fixture();
  try {
    const first = await f.json<ZoneSitePublicationReceipt>(await f.publish(), 201);
    const draft = await f.configure({ name: 'Revoked editor draft', language: 'en' });
    const page = await f.save('Revoked editor home', f.pages[0]!.revisionId);
    const key = randomUUID();
    f.revokeBeforeSwitch();
    expect((await f.publish(key, draft.revision, [page])).status).toBe(403);
    expect(f.switchRevocationConsumed()).toBe(true);
    expect((await readZoneConfiguration(f.env, f.zone))).toMatchObject({ name: 'Revoked editor draft',
      revision: draft.revision, publicationRevision: first.revision });
    expectPublicMetadata(await f.publicMetadata(), { name: INITIAL_NAME, language: 'en', direction: 'ltr' },
      first.revision, f.pages[0]!.revisionId);
    expect((await f.publish(key, draft.revision, [page])).status).toBe(403);
    expectPublicMetadata(await f.publicMetadata(), { name: INITIAL_NAME, language: 'en', direction: 'ltr' },
      first.revision, f.pages[0]!.revisionId);
    const preparation = await f.pool.query<{ status: string; pin_active: boolean }>(
      'SELECT status, pin_active FROM content.publication_preparation WHERE revision_id = $1', [page.revisionId]);
    expect(preparation.rows).toEqual([{ status: 'rejected', pin_active: false }]);
  } finally { await f.close(); }
}, 120_000);

test('never-published Realm Zones retain live public metadata and Zone-only homes retain their creation shell', async () => {
  for (const documentSite of [false, true]) {
    const f = await fixture(documentSite);
    try {
      const creation = await f.presentation();
      const draft = { name: 'Visible before first publication', language: 'en', direction: 'ltr' as const };
      await f.configure({ name: draft.name, language: draft.language });
      const state = await readZoneConfiguration(f.env, f.zone);
      expect(state.publicationRevision).toBeNull();
      const read = await f.publicMetadata();
      for (const summary of [read.resource, read.summary]) {
        expect(summary).toMatchObject({ status: 'available', name: { value: draft.name, language: draft.language },
          address: { suffixSource: draft.name } });
      }
      expect(read.presentation).toMatchObject(documentSite
        ? { name: INITIAL_NAME, revision: creation.revision, address: { suffixSource: INITIAL_NAME } }
        : { ...draft, revision: state.revision, address: { suffixSource: draft.name } });
      expect(read.home).toMatchObject({ kind: 'home', name: documentSite ? INITIAL_NAME : draft.name,
        revision: documentSite ? creation.revision : state.revision });
      expect(read.home.page).toBeUndefined();
      if (documentSite) expect(read.official).toBeUndefined();
      else expect(read.official).toMatchObject({ address: { suffixSource: draft.name } });
    } finally { await f.close(); }
  }
}, 120_000);
