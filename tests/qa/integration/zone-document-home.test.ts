import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { readZoneConfiguration, readZoneSitePublicationReceipt, ZoneUnavailable,
  type ZoneSitePublicationReceipt } from '../../../services/main/src/modules/zone/configuration.ts';
import { isZonePublishedPageRevision, readZonePublication } from '../../../services/main/src/modules/zone/publication.ts';
import { ZONE_SITE_PUBLICATION_COST, zonePublishedPageBinding } from '../../../services/main/src/modules/zone/config-format.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-document-home-${randomUUID()}`),
    'openid work:create work:read space:create zone:edit semantic:read');
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    await f.grant('space:create:root', 'space.create');
    const created = await f.json<{ space: string; zone: string; navigationRevision: string }>(
      await f.call('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Independent site',
        capabilities: ['zone'], actingSubject: f.actor }), 201);
    const zoneGrant = await f.grant(`zone:edit:${created.zone}`, 'zone.edit');
    const path = `/v1/zones/${shortId(created.zone)}`;
    const selection = { routesRevision: created.navigationRevision,
      navigationRevision: created.navigationRevision, pages: [{ page: nativeId(),
        variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID() }] };
    const publish = async (pages = selection.pages, key = randomUUID(),
      expectedHead?: string, navigationRevision = selection.navigationRevision) =>
      f.call('POST', `${path}/site-publications`, { ...selection, pages,
        routesRevision: navigationRevision, navigationRevision,
        expectedHead: expectedHead ?? (await readZoneConfiguration(f.env, created.zone)).revision,
        actingSubject: f.actor }, key);
    return { ...f, ...created, zoneGrant, path, selection, publish };
  } catch (error) { await f.close(); throw error; }
}

test('Realm-less site binds exact revisions; drafts stay outside and republishing moves public membership', async () => {
  const f = await fixture();
  try {
    const { page, revisionId } = f.selection.pages[0]!;
    const draftRevision = randomUUID();
    expect((await readZonePublication(f.env, f.zone)).realm).toBeNull();
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(false);
    const before = await readZoneConfiguration(f.env, f.zone);
    const first = await f.json<ZoneSitePublicationReceipt & { replayed: boolean }>(await f.publish(), 201);
    expect(first).toMatchObject({ zone: f.zone, pages: f.selection.pages,
      routesRevision: f.navigationRevision, navigationRevision: f.navigationRevision,
      themeRevision: before.revision, outcome: 'succeeded' });
    const { replayed: _replayed, ...firstProof } = first;
    expect(await readZoneSitePublicationReceipt(f.env, first.receipt)).toEqual(firstProof);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, draftRevision)).toBe(false);
    expect(await isZonePublishedPageRevision(f.env, f.zone, nativeId(), revisionId)).toBe(false);

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

    const publishedDraft = [{ ...f.selection.pages[0]!, revisionId: draftRevision }];
    const second = await f.json<ZoneSitePublicationReceipt>(await f.publish(publishedDraft), 201);
    expect(second.revision).not.toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(false);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, draftRevision)).toBe(true);
    expect((await readZoneSitePublicationReceipt(f.env, first.receipt))?.pages).toEqual(f.selection.pages);
  } finally { await f.close(); }
}, 120_000);

test('publication proofs cover the full bounded page set and fail closed on an incomplete receipt', async () => {
  const f = await fixture();
  try {
    const pages = Array.from({ length: ZONE_SITE_PUBLICATION_COST.maxPages }, () => ({
      page: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID(),
    }));
    const published = await f.json<ZoneSitePublicationReceipt>(await f.publish(pages), 201);
    expect(published.pages).toHaveLength(pages.length);
    expect(published.pages).toEqual(expect.arrayContaining(pages));
    expect((await readZoneSitePublicationReceipt(f.env, published.receipt))?.pages).toEqual(published.pages);
    for (const page of [pages[0]!, pages.at(-1)!]) {
      expect(await isZonePublishedPageRevision(f.env, f.zone, page.page, page.revisionId)).toBe(true);
    }
    const head = (await readZoneConfiguration(f.env, f.zone)).revision;
    const overflow = [...pages, { page: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID() }];
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
    const replacement = [{ ...f.selection.pages[0]!, revisionId: randomUUID() }];
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
          await f.json(await f.publish([{ ...selected, revisionId: randomUUID() }]), 201);
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
    await change('retirements');
    expect((await readZoneConfiguration(f.env, f.zone)).publicationRevision).toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(false);
    expect((await f.publish()).status).toBe(400);
    expect(await readZoneSitePublicationReceipt(f.env, first.receipt)).not.toBeNull();
    await change('recoveries');
    expect((await readZonePublication(f.env, f.zone)).publicationRevision).toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
    expect((await f.publish(f.selection.pages, randomUUID(), first.revision)).status).toBe(409);
    expect((await f.publish(f.selection.pages, randomUUID(), undefined, nativeId())).status).toBe(409);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [f.zoneGrant]);
    expect((await f.publish([{ ...f.selection.pages[0]!, revisionId: randomUUID() }])).status).toBe(403);
    expect((await readZonePublication(f.env, f.zone)).publicationRevision).toBe(first.revision);
    expect(await isZonePublishedPageRevision(f.env, f.zone, page, revisionId)).toBe(true);
  } finally { await f.close(); }
}, 120_000);
