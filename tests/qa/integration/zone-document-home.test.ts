import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { ContentCore, ContentConflict, type ContentPosition } from '../../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { applyContentErasure, checkContentErasureTargets, ContentErasureGraphRequired } from '../../../services/main/src/modules/erasure/content.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration, readZoneSitePublicationReceipt, ZoneUnavailable, ZonePublicationUnavailable,
  type ZoneSitePublicationReceipt } from '../../../services/main/src/modules/zone/configuration.ts';
import { isZonePublishedPageRevision, readZonePublication } from '../../../services/main/src/modules/zone/publication.ts';
import { ZONE_SITE_PUBLICATION_COST, zonePublishedPageBinding } from '../../../services/main/src/modules/zone/config-format.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

interface SavedDraft { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }
interface SelectedPage { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }
interface Home { kind: string; realm: string | null; page?: { reference: { revisionId: string };
  document: DocumentSnapshot; blocks: Array<Record<string, unknown>>;
  showcases: Array<{ id: string; module: { id: string; type: string } | null; sources: unknown[] }>;
  showcaseData: { slides: Array<{ id: string }>; slideMedia: unknown[] } } }
const boundPages = (pages: readonly Pick<SelectedPage, 'page' | 'variantId' | 'revisionId'>[]) => pages.map(({ page, variantId, revisionId }) =>
  ({ page, variantId, revisionId }));

async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-document-home-${randomUUID()}`),
    'openid work:create work:edit work:read space:create zone:edit collection:edit semantic:read');
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try {
      await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [f.account.a.id]);
    } finally { await accountPool.end(); }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    await f.authoredBody({ actingSubject: f.actor });
    // Zone Content authority follows verified stewardship and a live direct Agent
    // controller; the ordinary fixture's per-operation grants do not establish it.
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
    const core = new ContentCore(f.pool);
    let failSettlement = false;
    let failRejectionAt: number | null = null;
    let failPreparationAt: number | null = null;
    const content = new Proxy(core, { get(target, property) {
      if (property === 'preparePublication') return async (...args: Parameters<typeof target.preparePublication>) => {
        if (failPreparationAt !== null && --failPreparationAt === 0) {
          failPreparationAt = null;
          throw new ZonePublicationUnavailable('interrupted while pinning the second page');
        }
        return target.preparePublication(...args);
      };
      if (property === 'settlePublication') return async (...args: Parameters<typeof target.settlePublication>) => {
        if (args[2].outcome === 'rejected' && failRejectionAt !== null && --failRejectionAt === 0) {
          failRejectionAt = null; throw new Error('interrupted before Content rejection');
        }
        if (failSettlement) { failSettlement = false; throw new Error('interrupted before Content settlement'); }
        return target.settlePublication(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let revokeBeforeSwitch = false;
    let lateZoneGrant: string | null = null;
    let siteSpace: string | null = null;
    const revokeEditor = async () => {
      // Stewardship can change while the Agent retains its final controller.
      // Removing that controller would test controller continuity instead.
      const replacement = nativeId();
      const profile = { kind: 'person' as const, displayName: 'Replacement site owner' };
      await createAgentGraph(f.env, { id: randomUUID(), agent: replacement,
        ...profile, digest: agentProvisionDigest(profile) });
      await f.env.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
        DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(siteSpace!)} rv:owner ${iri(f.actor)} } }
        INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(siteSpace!)} rv:owner ${iri(replacement)} } }
        WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(siteSpace!)} rv:owner ${iri(f.actor)} } }`);
      await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [lateZoneGrant]);
    };
    const access = new Proxy(f.access, { get(target, property) {
      if (property === 'withOwnerAuthority') return async (...args: Parameters<typeof target.withOwnerAuthority>) => {
        if (revokeBeforeSwitch && args[0].action === 'zone.edit') {
          revokeBeforeSwitch = false;
          // The Content pin's authority transaction has ended. Revoke before
          // the final switch acquires its own authority fence, avoiding a lock race.
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
      token: string | null = f.account.tokenA, headers: Record<string, string> = {}) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    await f.grant('space:create:root', 'space.create');
    const created = await f.json<{ space: string; zone: string; navigationRevision: string }>(
      await call('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Independent site',
        capabilities: ['zone'], actingSubject: f.actor }), 201);
    const zoneGrant = await f.grant(`zone:edit:${created.zone}`, 'zone.edit');
    lateZoneGrant = zoneGrant;
    siteSpace = created.space;
    const path = `/v1/zones/${shortId(created.zone)}`;
    const save = async (document = fromPlainText('Published home', 'blocks'),
      expectedHead: string | null = null, variantId = `urn:rezics:variant:${randomUUID()}`,
      resourceId = created.zone, language = 'en'): Promise<SelectedPage> => {
      const saved = await f.json<SavedDraft>(await call('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId, variantId, expectedHead, document,
        language: { kind: 'tag', tag: language, originalTag: language }, direction: 'ltr', actingSubject: f.actor,
      }), 201);
      return { page: resourceId, variantId, revisionId: saved.revisionId,
        byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch };
    };
    const initialContentPosition = await core.ownerPosition();
    const initialDocument = fromPlainText('Published home', 'blocks');
    const selection = { routesRevision: created.navigationRevision,
      navigationRevision: created.navigationRevision, pages: [await save(initialDocument)] };
    const publish = async (pages = selection.pages, key = randomUUID(),
      expectedHead?: string, navigationRevision = selection.navigationRevision) =>
      call('POST', `${path}/site-publications`, { ...selection, pages,
        routesRevision: navigationRevision, navigationRevision,
        expectedHead: expectedHead ?? (await readZoneConfiguration(f.env, created.zone)).revision,
        actingSubject: f.actor }, key);
    const home = async (language?: string) => f.json<Home>(await call('GET', `${path}/routes?path=%2F`, undefined, randomUUID(), null,
      language ? { 'accept-language': language } : {}), 200);
    const exact = (revision: string, editor = false) => call('GET', `/v1/content-revisions/${revision}${editor
      ? `?actingSubject=${encodeURIComponent(f.actor)}` : ''}`, undefined, randomUUID(), editor ? f.account.tokenA : null);
    return { ...f, ...created, zoneGrant, controlId, path, selection, initialDocument, publish, save, call, home, exact, content, initialContentPosition,
      revokeBeforeSwitch: () => { revokeBeforeSwitch = true; },
      revokeEditor,
      switchRevocationConsumed: () => !revokeBeforeSwitch,
      failSettlement: () => { failSettlement = true; },
      failRejection: () => { failRejectionAt = 1; },
      failSecondRejection: () => { failRejectionAt = 2; },
      failSecondPreparation: () => { failPreparationAt = 2; } };
  } catch (error) { await f.close(); throw error; }
}

async function reconcileSiteEvents(f: Awaited<ReturnType<typeof fixture>>, terminalType: string) {
  const cursor = new ContentProjectionCursor(f.pool);
  const consumer = `site-proof-${randomUUID()}`;
  const start: ContentPosition = f.initialContentPosition;
  await cursor.initialize(consumer);
  // This consumer belongs to this isolated fixture. Older fixtures' publication
  // proofs may have been deliberately damaged by their own counterexamples.
  await f.pool.query(`UPDATE content.projection_checkpoint
    SET sequence = $2::bigint, scan_sequence = $2::bigint WHERE consumer = $1 AND data_epoch = $3`,
  [consumer, start.sequence, start.dataEpoch]);
  const highWater = await f.content.ownerPosition();
  const terminal = await f.pool.query<{ sequence: string }>(`SELECT sequence::text FROM content.outbox
    WHERE data_epoch = $1 AND sequence > $2::bigint AND sequence <= $3::bigint
      AND revision_id = $4 AND event_type = $5`,
  [start.dataEpoch, start.sequence, highWater.sequence, f.selection.pages[0]!.revisionId, terminalType]);
  expect(terminal.rows).toHaveLength(1);
  const dispositions = new Map<string, string>();
  for (let steps = 0; BigInt((await cursor.readScan(consumer)).sequence) < BigInt(highWater.sequence); steps++) {
    if (steps >= 32) throw new Error('Site Content event reconciliation exceeded fixture event bound');
    const result = await relayContentProjectionOnce(f.env, f.content, cursor, consumer);
    if (!result) throw new Error('Site Content event reconciliation stopped before its owner cut');
    expect(result.disposition).not.toBe('deferred');
    dispositions.set(result.sourceSequence, result.disposition);
  }
  expect(dispositions.get(terminal.rows[0]!.sequence)).toBe('ignored');
  expect(await cursor.read(consumer)).toEqual(highWater);
  expect(await cursor.retries(consumer)).toEqual([]);
}

test('Realm-less site binds exact revisions; drafts stay outside and republishing moves public membership', async () => {
  const f = await fixture();
  try {
    const { page, revisionId } = f.selection.pages[0]!;
    expect((await readZonePublication(f.env, f.zone)).realm).toBeNull();
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(false);
    expect((await f.home()).page).toBeUndefined();
    expect((await f.exact(revisionId)).status).toBe(404);
    const preview = await f.json<{ body: { document: DocumentSnapshot } }>(await f.exact(revisionId, true), 200);
    expect(preview.body.document).toEqual(f.initialDocument);
    const before = await readZoneConfiguration(f.env, f.zone);
    const first = await f.json<ZoneSitePublicationReceipt & { replayed: boolean }>(await f.publish(), 201);
    expect(first).toMatchObject({ zone: f.zone, pages: boundPages(f.selection.pages),
      routesRevision: f.navigationRevision, navigationRevision: f.navigationRevision,
      themeRevision: before.revision, outcome: 'succeeded' });
    const { replayed: _replayed, ...firstProof } = first;
    expect(await readZoneSitePublicationReceipt(f.env, first.receipt)).toEqual(firstProof);
    const draftHead = (await readZoneConfiguration(f.env, f.zone)).revision;
    const draftDocument = fromPlainText('Draft home', 'blocks');
    const newerDraft = await f.save(draftDocument, revisionId, f.selection.pages[0]!.variantId);
    const draftRevision = newerDraft.revisionId;
    expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(draftHead);
    const draftPreview = await f.json<{ body: { document: DocumentSnapshot } }>(await f.exact(draftRevision, true), 200);
    expect(draftPreview.body.document).toEqual(draftDocument);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, draftRevision)).toBe(false);
    expect(await isZonePublishedPageRevision(f.env, f.zone, nativeId(), revisionId)).toBe(false);
    expect((await f.home()).page).toMatchObject({ reference: { revisionId },
      document: f.initialDocument });
    expect((await f.exact(revisionId)).status).toBe(200);
    expect((await f.exact(draftRevision)).status).toBe(404);

    let membershipCalls = 0;
    const original = f.env.fuseki;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'query') return (...args: Parameters<typeof target.query>) => {
        if (args[0].includes('rv:publishedPage <urn:rezics:zone-published-page:')) {
          membershipCalls++;
          expect(args[1]).toBe(ZONE_SITE_PUBLICATION_COST.membershipResponseBytes);
        }
        return target.query(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
    expect(membershipCalls).toBe(ZONE_SITE_PUBLICATION_COST.membershipGraphReads);
    f.env.fuseki = original;

    const publishedDraft = [newerDraft];
    const second = await f.json<ZoneSitePublicationReceipt>(await f.publish(publishedDraft), 201);
    expect(second.revision).not.toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(false);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, draftRevision)).toBe(true);
    expect((await f.home()).page).toMatchObject({ reference: { revisionId: draftRevision },
      document: draftDocument });
    expect((await f.exact(revisionId)).status).toBe(404);
    expect(boundPages((await readZoneSitePublicationReceipt(f.env, first.receipt))!.pages)).toEqual(boundPages(f.selection.pages));
  } finally { await f.close(); }
}, 120_000);

test('anonymous home language preferences select only exact variants in the published bundle', async () => {
  const f = await fixture();
  try {
    const english = f.selection.pages[0]!;
    const frenchDocument = fromPlainText('Accueil publié', 'blocks');
    const french = await f.save(frenchDocument, null, `urn:rezics:variant:${randomUUID()}`, f.zone, 'fr');
    const receipt = await f.json<ZoneSitePublicationReceipt>(await f.publish([english, french]), 201);
    expect(receipt.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: english.revisionId, language: 'en' }),
      expect.objectContaining({ revisionId: french.revisionId, language: 'fr' }),
    ]));
    expect((await f.home('en-US,en;q=0.9')).page?.reference.revisionId).toBe(english.revisionId);
    const preferred = 'fr-FR,fr;q=0.9,en;q=0.5';
    expect((await f.home(preferred)).page).toMatchObject({ reference: { revisionId: french.revisionId },
      document: frenchDocument });
    const preview = await f.save(fromPlainText('Brouillon privé', 'blocks'), french.revisionId,
      french.variantId, f.zone, 'fr');
    expect((await f.exact(preview.revisionId)).status).toBe(404);
    expect((await f.home(preferred)).page?.reference.revisionId).toBe(french.revisionId);
    const presentation = await f.json<{ home?: Home['page'] }>(await f.call('GET', `${f.path}/presentation`,
      undefined, randomUUID(), null, { 'accept-language': preferred }), 200);
    expect(presentation.home?.reference.revisionId).toBe(french.revisionId);
    expect((await readZoneSitePublicationReceipt(f.env, receipt.receipt))?.pages).toEqual(receipt.pages);
  } finally { await f.close(); }
}, 120_000);

test('site publication rejects nonexistent, unrelated, wrongly selected and stale Content revisions', async () => {
  const f = await fixture();
  try {
    const other = await f.json<{ zone: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-zone-v1', name: 'Another independent site', capabilities: ['zone'], actingSubject: f.actor,
    }), 201);
    await f.grant(`zone:edit:${other.zone}`, 'zone.edit');
    const foreign = await f.save(fromPlainText('Foreign page', 'blocks'), null,
      `urn:rezics:variant:${randomUUID()}`, other.zone);
    const page = f.selection.pages[0]!;
    const initial = (await readZoneConfiguration(f.env, f.zone)).revision;
    for (const selected of [
      { ...page, revisionId: randomUUID() },
      { ...foreign, page: f.zone },
      foreign,
      { ...page, variantId: `urn:rezics:variant:${randomUUID()}` },
      { ...page, byteDigest: '0'.repeat(64) },
      { ...page, contentEpoch: randomUUID() },
    ]) {
      const rejected = await f.publish([selected]);
      expect([400, 404, 409]).toContain(rejected.status);
      expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(initial);
      expect((await f.home()).page).toBeUndefined();
    }
    expect(await isZonePublishedPageRevision(f.env, f.zone, f.zone, page.revisionId)).toBe(false);
  } finally { await f.close(); }
}, 120_000);

test('revocation after the Content pin prevents the final site bundle switch', async () => {
  const f = await fixture();
  try {
    const before = await readZoneConfiguration(f.env, f.zone);
    const page = f.selection.pages[0]!;
    f.revokeBeforeSwitch();
    const key = randomUUID();
    expect((await f.publish(f.selection.pages, key, before.revision)).status).toBe(403);
    expect(f.switchRevocationConsumed()).toBe(true);
    const preparations = await f.pool.query<{ status: string; pin_active: boolean }>(
      'SELECT status, pin_active FROM content.publication_preparation WHERE revision_id = $1', [page.revisionId]);
    expect(preparations.rows).toEqual([{ status: 'rejected', pin_active: false }]);
    const settledPosition = await f.content.ownerPosition();
    expect((await f.publish(f.selection.pages, key, before.revision)).status).toBe(403);
    expect(await f.content.ownerPosition()).toEqual(settledPosition);
    await checkContentErasureTargets(f.pool, f.zone, [page.revisionId]);
    const erasure = { preservationAccess: f.accessPool, erasureId: randomUUID(), erasureEpoch: '1',
      resourceId: f.zone, revisionIds: [page.revisionId] };
    expect(await applyContentErasure(f.pool, erasure)).toEqual({ applied: 1 });
    expect(await applyContentErasure(f.pool, erasure)).toEqual({ applied: 0 });
    const exact = (await f.content.readExactBatch([page.revisionId], async ids => new Set(ids)))[0];
    expect(exact?.status).toBe('erased');
    const after = await readZoneConfiguration(f.env, f.zone);
    expect(after.revision).toBe(before.revision);
    expect(after.publicationRevision).toBe(before.publicationRevision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, f.zone, page.revisionId)).toBe(false);
    expect((await f.home()).page).toBeUndefined();
    const receipts = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:sitePublicationRevision ?publication ;
        rv:structureOwner ${iri(f.zone)} ; rv:outcome rv:Succeeded . }
    } LIMIT 2`, 4096);
    expect(receipts.results?.bindings).toHaveLength(0);
  } finally { await f.close(); }
}, 120_000);

test('an interrupted rejection retains the cancelled receipt and replay releases its pending pin', async () => {
  const f = await fixture();
  try {
    const before = await readZoneConfiguration(f.env, f.zone);
    const page = f.selection.pages[0]!;
    const key = randomUUID();
    f.revokeBeforeSwitch();
    f.failRejection();
    expect((await f.publish(f.selection.pages, key, before.revision)).status).toBe(503);
    const pending = await f.pool.query<{ operation_id: string; status: string; pin_active: boolean }>(
      'SELECT operation_id, status, pin_active FROM content.publication_preparation WHERE revision_id = $1', [page.revisionId]);
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]).toMatchObject({ status: 'pending', pin_active: true });
    await expect(checkContentErasureTargets(f.pool, f.zone, [page.revisionId], true))
      .rejects.toBeInstanceOf(ContentErasureGraphRequired);
    await expect(applyContentErasure(f.pool, { preservationAccess: f.accessPool,
      erasureId: randomUUID(), erasureEpoch: '1', resourceId: f.zone, revisionIds: [page.revisionId] }))
      .rejects.toBeInstanceOf(ContentErasureGraphRequired);
    expect((await f.publish(f.selection.pages, key, before.revision)).status).toBe(403);
    expect(await f.content.readPublicationPreparation(pending.rows[0]!.operation_id))
      .toMatchObject({ status: 'rejected', pinActive: false });
    const settled = await f.content.ownerPosition();
    expect((await f.publish(f.selection.pages, key, before.revision)).status).toBe(403);
    expect(await f.content.ownerPosition()).toEqual(settled);
    await checkContentErasureTargets(f.pool, f.zone, [page.revisionId]);
    expect(await applyContentErasure(f.pool, { preservationAccess: f.accessPool,
      erasureId: randomUUID(), erasureEpoch: '1', resourceId: f.zone, revisionIds: [page.revisionId] }))
      .toEqual({ applied: 1 });
    expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(before.revision);
    expect((await f.home()).page).toBeUndefined();
  } finally { await f.close(); }
}, 120_000);

test('cancellation replay skips erased rejected bytes and releases the remaining page pin', async () => {
  const f = await fixture();
  try {
    const before = await readZoneConfiguration(f.env, f.zone);
    const first = f.selection.pages[0]!;
    const second = await f.save(fromPlainText('Second variant', 'blocks'), null,
      `urn:rezics:variant:${randomUUID()}`, f.zone, 'fr');
    const pages = [first, second];
    const key = randomUUID();
    f.revokeBeforeSwitch();
    f.failSecondRejection();
    expect((await f.publish(pages, key, before.revision)).status).toBe(503);
    const preparations = async () => (await f.pool.query<{ revision_id: string; status: string; pin_active: boolean }>(
      'SELECT revision_id, status, pin_active FROM content.publication_preparation WHERE revision_id = ANY($1::uuid[])',
      [[first.revisionId, second.revisionId]])).rows;
    expect(await preparations()).toEqual(expect.arrayContaining([
      { revision_id: first.revisionId, status: 'rejected', pin_active: false },
      { revision_id: second.revisionId, status: 'pending', pin_active: true },
    ]));
    await expect(checkContentErasureTargets(f.pool, f.zone, [second.revisionId], true))
      .rejects.toBeInstanceOf(ContentErasureGraphRequired);
    const events = await f.content.readOutbox(f.initialContentPosition.dataEpoch, f.initialContentPosition.sequence, 100);
    const rejection = events.find(event => event.revisionId === first.revisionId && event.eventType === 'content.publication.rejected');
    if (!rejection) throw new Error('First page rejection event is missing');
    const proof = await f.content.readProjectionPublication(rejection);
    expect(await applyContentErasure(f.pool, { preservationAccess: f.accessPool,
      erasureId: randomUUID(), erasureEpoch: '1', resourceId: f.zone, revisionIds: [first.revisionId] }))
      .toEqual({ applied: 1 });
    expect((await f.content.readExactBatch([first.revisionId], async ids => new Set(ids)))[0]?.status).toBe('erased');
    expect(await f.content.readPublicationPreparation(proof.preparationId)).toMatchObject({
      status: 'rejected', pinActive: false,
      reference: { resourceId: f.zone, variantId: first.variantId, revisionId: first.revisionId, byteDigest: first.byteDigest },
    });
    await expect(f.content.settlePublication(rejection.operationId, proof.preparationId,
      { ...proof.graph, receipt: `${proof.graph.receipt}:altered` }, proof.preparationPosition.dataEpoch))
      .rejects.toBeInstanceOf(ContentConflict);
    expect((await f.publish(pages, key, before.revision)).status).toBe(403);
    expect(await preparations()).toEqual(expect.arrayContaining(pages.map(page => ({
      revision_id: page.revisionId, status: 'rejected', pin_active: false,
    }))));
    const rejected = await f.pool.query<{ revision_id: string; count: string }>(`SELECT revision_id, count(*)::text
      FROM content.outbox WHERE revision_id = ANY($1::uuid[]) AND event_type = 'content.publication.rejected'
      GROUP BY revision_id`, [[first.revisionId, second.revisionId]]);
    expect(rejected.rows).toEqual(expect.arrayContaining(pages.map(page => ({ revision_id: page.revisionId, count: '1' }))));
    await checkContentErasureTargets(f.pool, f.zone, [second.revisionId]);
    expect(await applyContentErasure(f.pool, { preservationAccess: f.accessPool,
      erasureId: randomUUID(), erasureEpoch: '1', resourceId: f.zone, revisionIds: [second.revisionId] }))
      .toEqual({ applied: 1 });
    const settled = await f.content.ownerPosition();
    expect((await f.publish(pages, key, before.revision)).status).toBe(403);
    expect(await f.content.ownerPosition()).toEqual(settled);
    expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(before.revision);
    expect((await f.home()).page).toBeUndefined();
  } finally { await f.close(); }
}, 120_000);

test('failure pinning the second page rejects the first pin without publishing a partial bundle', async () => {
  const f = await fixture();
  try {
    const before = await readZoneConfiguration(f.env, f.zone);
    const first = f.selection.pages[0]!;
    const second = await f.save(fromPlainText('Second variant', 'blocks'), null,
      `urn:rezics:variant:${randomUUID()}`, f.zone, 'fr');
    const pages = [first, second];
    const key = randomUUID();
    f.failSecondPreparation();
    expect((await f.publish(pages, key, before.revision)).status).toBe(503);
    const preparations = await f.pool.query<{ revision_id: string; status: string; pin_active: boolean }>(
      'SELECT revision_id, status, pin_active FROM content.publication_preparation WHERE revision_id = ANY($1::uuid[])',
      [[first.revisionId, second.revisionId]]);
    expect(preparations.rows).toEqual([{ revision_id: first.revisionId, status: 'rejected', pin_active: false }]);
    expect((await f.publish(pages, key, before.revision)).status).toBe(403);
    expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(before.revision);
    expect((await f.home()).page).toBeUndefined();
    await checkContentErasureTargets(f.pool, f.zone, [first.revisionId, second.revisionId]);
  } finally { await f.close(); }
}, 120_000);

test('a site receipt survives interrupted Content settlement and replay settles its exact pin once', async () => {
  const f = await fixture();
  try {
    const expectedHead = (await readZoneConfiguration(f.env, f.zone)).revision;
    const key = randomUUID();
    f.failSettlement();
    expect((await f.publish(f.selection.pages, key, expectedHead)).status).toBe(503);
    const selected = await f.pool.query<{ operation_id: string; status: string; pin_active: boolean }>(
      `SELECT operation_id, status, pin_active FROM content.publication_preparation WHERE revision_id = $1`,
      [f.selection.pages[0]!.revisionId]);
    expect(selected.rows).toHaveLength(1);
    expect(selected.rows[0]).toMatchObject({ status: 'pending', pin_active: true });
    const replay = await f.json<ZoneSitePublicationReceipt & { replayed: boolean }>(
      await f.publish(f.selection.pages, key, expectedHead), 200);
    expect(replay.replayed).toBe(true);
    expect(boundPages(replay.pages)).toEqual(boundPages(f.selection.pages));
    expect(await f.content.readPublicationPreparation(selected.rows[0]!.operation_id))
      .toMatchObject({ status: 'active', pinActive: true });
    const receipts = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:sitePublicationRevision ?publication ;
        rv:structureOwner ${iri(f.zone)} . }
    } LIMIT 3`, 4096);
    expect(receipts.results?.bindings).toHaveLength(1);
    expect((await f.home()).page?.reference.revisionId).toBe(f.selection.pages[0]!.revisionId);
  } finally { await f.close(); }
}, 120_000);

test('site publication terminal events reconcile without retaining a body-search projection target', async () => {
  const published = await fixture();
  try {
    await published.json(await published.publish(), 201);
    await reconcileSiteEvents(published, 'content.publication.active');
  } finally { await published.close(); }
  const cancelled = await fixture();
  try {
    cancelled.revokeBeforeSwitch();
    expect((await cancelled.publish()).status).toBe(403);
    await reconcileSiteEvents(cancelled, 'content.publication.rejected');
  } finally { await cancelled.close(); }
}, 120_000);

test('public home resolves published Showcase and unknown placeholders while draft presentation and navigation stay private', async () => {
  const f = await fixture();
  try {
    const creation = await readZonePublication(f.env, f.zone);
    const document = structuredClone(fromPlainText('A site without a Realm', 'blocks'));
    const payload = { future: [null, { coordinates: [121.5, 25], preserved: true }], unicode: '雨夜書店' };
    document.doc.content!.push(
      { type: 'extensionBlock', attrs: { id: 'showcase', dir: null, lang: null, definition: 'https://rezics.com/definition/showcase-block-v1',
        version: '1', payload: {}, fallback: 'Highlights' } },
      { type: 'extensionBlock', attrs: { id: 'unknown-map', dir: null, lang: null, definition: 'https://example.org/future-map',
        version: '9', payload, fallback: 'Place map' } },
    );
    const page = await f.save(document, f.selection.pages[0]!.revisionId, f.selection.pages[0]!.variantId);
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    await f.json(await f.call('POST', '/v1/collections', {
      collection, name: 'Mounted references', disclosure: 'public', actingSubject: f.actor,
    }), 201);
    const mount = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST', `${f.path}/mounts`, {
      expectedHead: f.navigationRevision, target: collection, routeSegment: 'published-document',
      disclosure: 'public', actingSubject: f.actor,
    }), 200);
    const publishedPresentation = { ...DEFAULT_ZONE_PRESENTATION,
      slides: [{ id: 'published-slide', href: '/published-document', title: 'Published highlight' }] };
    const presentation = async () => f.json<{ home?: Home['page']; presentation: typeof publishedPresentation;
      name: string | null; revision: string; navigation: Array<{ segment: string }> }>(
      await f.call('GET', `${f.path}/presentation`, undefined, randomUUID(), null), 200);
    await f.json(await f.call('PUT', `${f.path}/configuration`, {
      expectedHead: (await readZoneConfiguration(f.env, f.zone)).revision,
      name: 'Edited site draft', language: 'en', presentation: publishedPresentation, actingSubject: f.actor,
    }), 200);
    const unpublished = await presentation();
    expect(unpublished.presentation.slides).toEqual([]);
    expect(unpublished.navigation).toEqual([]);
    expect(unpublished.home).toBeUndefined();
    expect(unpublished.name).toBe(creation.name);
    expect(unpublished.revision).toBe(creation.revision);
    expect((await f.call('GET', `${f.path}/routes?path=%2Fpublished-document`, undefined, randomUUID(), null)).status).toBe(404);
    const receipt = await f.json<ZoneSitePublicationReceipt>(await f.publish([page], randomUUID(), undefined, mount.revision), 201);
    const home = await f.home();
    expect(home.realm).toBeNull();
    expect(home.page?.document).toEqual(document);
    expect(home.page?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'showcase', status: 'resolved', kind: 'showcase' }),
      expect.objectContaining({ id: 'unknown-map', status: 'placeholder', reason: 'unknown_definition', fallback: 'Place map' }),
    ]));
    expect(home.page?.showcases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '$default', module: null, sources: [] }),
    ]));
    expect(home.page?.showcaseData.slides).toEqual(publishedPresentation.slides);
    const exported = await f.json<{ serializedJson: string; body: { document: DocumentSnapshot } }>(await f.exact(page.revisionId), 200);
    expect(exported.body.document).toEqual(document);
    expect(JSON.parse(exported.serializedJson).document.doc.content.at(-1).attrs.payload).toEqual(payload);
    const before = await presentation();
    expect(before.name).toBe('Edited site draft');
    expect(before.home?.reference.revisionId).toBe(page.revisionId);
    expect(before.presentation.slides).toEqual(publishedPresentation.slides);
    expect(before.navigation.map(item => item.segment)).toEqual(['published-document']);
    expect((await f.call('GET', `${f.path}/routes?path=%2Fpublished-document`, undefined, randomUUID(), null)).status).toBe(200);

    await f.json(await f.call('PUT', `${f.path}/configuration`, {
      expectedHead: receipt.revision, presentation: { ...publishedPresentation,
        slides: [{ id: 'draft-slide', href: '/draft-document', title: 'Unpublished highlight' }] },
      actingSubject: f.actor,
    }), 200);
    const removed = await f.json<{ revision: string }>(await f.call('DELETE',
      `${f.path}/mounts/${shortId(mount.occurrences[0]!)}`, { expectedHead: mount.revision, actingSubject: f.actor }), 200);
    const added = await f.json<{ revision: string }>(await f.call('POST', `${f.path}/mounts`, {
      expectedHead: removed.revision, target: collection, routeSegment: 'draft-document',
      disclosure: 'public', actingSubject: f.actor,
    }), 200);
    const stillPublished = await presentation();
    expect(stillPublished.presentation).toEqual(before.presentation);
    expect(stillPublished.navigation).toEqual(before.navigation);
    expect(stillPublished.home).toEqual(before.home);
    expect((await f.call('GET', `${f.path}/routes?path=%2Fpublished-document`, undefined, randomUUID(), null)).status).toBe(200);
    expect((await f.call('GET', `${f.path}/routes?path=%2Fdraft-document`, undefined, randomUUID(), null)).status).toBe(404);
    await f.json(await f.publish([page], randomUUID(), undefined, added.revision), 201);
    const republished = await presentation();
    expect(republished.presentation.slides[0]?.id).toBe('draft-slide');
    expect(republished.navigation.map(item => item.segment)).toEqual(['draft-document']);
    expect((await f.call('GET', `${f.path}/routes?path=%2Fpublished-document`, undefined, randomUUID(), null)).status).toBe(404);
    expect((await f.call('GET', `${f.path}/routes?path=%2Fdraft-document`, undefined, randomUUID(), null)).status).toBe(200);
  } finally { await f.close(); }
}, 120_000);

test('publication proofs cover the full bounded page set and fail closed on an incomplete receipt', async () => {
  const f = await fixture();
  try {
    const pages: SelectedPage[] = [];
    for (let index = 0; index < ZONE_SITE_PUBLICATION_COST.maxPages; index++) pages.push(await f.save());
    const published = await f.json<ZoneSitePublicationReceipt>(await f.publish(pages), 201);
    expect(published.pages).toHaveLength(pages.length);
    expect(boundPages(published.pages)).toEqual(expect.arrayContaining(boundPages(pages)));
    expect((await readZoneSitePublicationReceipt(f.env, published.receipt))?.pages).toEqual(published.pages);
    for (const page of [pages[0]!, pages.at(-1)!]) {
      expect(await isZonePublishedPageRevision(f.env, f.zone, page.page, page.revisionId)).toBe(true);
    }
    const head = (await readZoneConfiguration(f.env, f.zone)).revision;
    const overflow = [...pages, { ...pages[0]!, revisionId: randomUUID() }];
    expect((await f.publish(overflow)).status).toBe(400);
    expect((await readZoneConfiguration(f.env, f.zone)).revision).toBe(head);
    const removed = pages.at(-1)!;
    await f.env.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(zonePublishedPageBinding(published.revision, removed.page, removed.revisionId))}
        rv:contentRevision ${iri(`urn:rezics:content:revision:${removed.revisionId}`)} . }
    }`);
    expect(await isZonePublishedPageRevision(f.env, f.zone, removed.page, removed.revisionId)).toBe(false);
    await expect(readZoneSitePublicationReceipt(f.env, published.receipt)).rejects.toBeInstanceOf(ZoneUnavailable);
  } finally { await f.close(); }
}, 120_000);

test('concurrent publishers select one bundle and a membership lookup rechecks a republished or private site', async () => {
  const f = await fixture();
  try {
    const before = (await readZoneConfiguration(f.env, f.zone)).revision;
    const replacement = [await f.save(fromPlainText('Concurrent alternative', 'blocks'))];
    const results = await Promise.all([f.publish(f.selection.pages, randomUUID(), before),
      f.publish(replacement, randomUUID(), before)]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const winner = await results.find(result => result.status === 201)!.json() as ZoneSitePublicationReceipt;
    const selected = winner.pages[0]!;
    const original = f.env.fuseki;
    let moved = false;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<typeof target.query>) => {
        if (!moved && args[0].includes('rv:publishedPage <urn:rezics:zone-published-page:')) {
          moved = true;
          const newer = await f.save();
          await f.json(await f.publish([newer]), 201);
        }
        return target.query(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await isZonePublishedPageRevision(f.env, f.zone, selected.page, selected.revisionId)).toBe(false);
    expect(moved).toBe(true);
    f.env.fuseki = original;
    const current = await f.json<ZoneSitePublicationReceipt>(await f.publish(f.selection.pages), 201);
    await f.env.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:disclosure rv:Public } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:disclosure rv:Private } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(f.space)} rv:disclosure rv:Public } }`);
    expect(await isZonePublishedPageRevision(f.env, f.zone,
      f.selection.pages[0]!.page, f.selection.pages[0]!.revisionId)).toBe(false);
    expect((await readZoneSitePublicationReceipt(f.env, current.receipt))?.pages).toEqual(current.pages);
  } finally { await f.close(); }
}, 120_000);

test('lost publish acknowledgement replays one receipt and original page, route, navigation and theme cuts', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const before = await readZoneConfiguration(f.env, f.zone);
    const original = f.env.fuseki;
    let commands = 0, lost = false;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
        const result = await target.commandWithReceipt(...args);
        if (args[0].update.includes('rv:sitePublicationRevision')) {
          commands++;
          if (!lost) { lost = true; throw new Error('lost publish response'); }
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const first = await f.json<ZoneSitePublicationReceipt & { replayed: boolean }>(
      await f.publish(f.selection.pages, key, before.revision), 201);
    expect(lost).toBe(true);
    const replay = await f.json<ZoneSitePublicationReceipt & { replayed: boolean }>(
      await f.publish(f.selection.pages, key, before.revision), 200);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(commands).toBe(1);
    const { replayed: _replayed, ...firstProof } = first;
    expect(await readZoneSitePublicationReceipt(f.env, first.receipt)).toEqual(firstProof);
    const receipts = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?receipt WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:sitePublicationRevision ?publication ;
        rv:structureOwner ${iri(f.zone)} . }
    } LIMIT 3`, 4096);
    expect(receipts.results?.bindings).toHaveLength(1);
    expect((await f.publish([{ ...f.selection.pages[0]!, revisionId: randomUUID() }], key, before.revision)).status).toBe(409);
  } finally { await f.close(); }
}, 120_000);

test('configuration, retirement and recovery retain the bundle; revoked publication and stale cuts do not switch it', async () => {
  const f = await fixture();
  try {
    const first = await f.json<ZoneSitePublicationReceipt>(await f.publish(), 201);
    const { page, revisionId } = f.selection.pages[0]!;
    const change = async (operation: 'retirements' | 'recoveries') =>
      f.json(await f.call('POST', `${f.path}/${operation}`, {
        expectedHead: (await readZoneConfiguration(f.env, f.zone)).revision, actingSubject: f.actor,
      }), 200);
    await f.json(await f.call('PUT', `${f.path}/configuration`, {
      expectedHead: first.revision, budget: { timeMs: 100, rows: 10 }, actingSubject: f.actor,
    }), 200);
    expect((await readZonePublication(f.env, f.zone)).publicationRevision).toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
    expect((await f.home()).page?.reference.revisionId).toBe(revisionId);
    await change('retirements');
    expect((await readZoneConfiguration(f.env, f.zone)).publicationRevision).toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(false);
    expect((await f.call('GET', `${f.path}/routes?path=%2F`, undefined, randomUUID(), null)).status).toBe(404);
    expect((await f.publish()).status).toBe(400);
    expect(await readZoneSitePublicationReceipt(f.env, first.receipt)).not.toBeNull();
    await change('recoveries');
    expect((await readZonePublication(f.env, f.zone)).publicationRevision).toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
    expect((await f.home()).page?.reference.revisionId).toBe(revisionId);
    expect((await f.publish(f.selection.pages, randomUUID(), first.revision)).status).toBe(409);
    expect((await f.publish(f.selection.pages, randomUUID(), undefined, nativeId())).status).toBe(409);
    const editorDraft = await f.save(fromPlainText('Revoked editor draft', 'blocks'), revisionId,
      f.selection.pages[0]!.variantId);
    await f.revokeEditor();
    expect((await f.publish([editorDraft])).status).toBe(403);
    expect((await f.exact(editorDraft.revisionId, true)).status).toBe(404);
    expect((await readZonePublication(f.env, f.zone)).publicationRevision).toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
  } finally { await f.close(); }
}, 120_000);
