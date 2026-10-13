import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { ZoneSitePublicationReceipt } from '../../../services/main/src/modules/zone/configuration.ts';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';

type Page = { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
type Receipt = ZoneSitePublicationReceipt & { replayed: boolean };
const reads: Array<{ consumer: 'request' | 'relay'; admissionId: string; revisions: string[] }> = [];
let sessions: PersonaSessions;
const query = FusekiClient.prototype.query;
const stackLimit = Error.stackTraceLimit;
beforeAll(async () => {
  sessions = await personaSessions('public');
  Error.stackTraceLimit = 60;
  FusekiClient.prototype.query = async function(...args) {
    const stack = new Error().stack ?? '';
    const result = await query.apply(this, args);
    if (args[0].includes('SELECT ?zone ?revision ?routesRevision')) {
      const rows = result.results?.bindings ?? [];
      const admissionId = rows[0]?.admissionId?.value;
      const consumer = stack.includes('sitePublicationProof') ? 'relay'
        : stack.includes('publishZoneSite') ? 'request' : undefined;
      if (admissionId && consumer) reads.push({ consumer, admissionId,
        revisions: rows.map(row => row.contentRevision?.value ?? '') });
    }
    return result;
  };
}, 180_000);
afterAll(async () => {
  FusekiClient.prototype.query = query;
  Error.stackTraceLimit = stackLimit;
  await sessions?.close();
});
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('8, 16 and 32 exact site selections publish complete receipts with linear request and relay reads', async () => {
  const owner = sessions.owner;
  const created = await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(
    owner.main('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Site publication cost',
      language: 'en', visibility: 'public', capabilities: ['zone'], actingSubject: owner.actingSubject }), 201);
  const path = `/v1/zones/${created.zone.slice(-36)}`;
  const prepared = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
    expectedHead: created.zoneRevision, prepareHomeDocument: true, actingSubject: owner.actingSubject,
  }));
  const configuration = await answer<{ configuration: { homeDocument: string } }>(owner.main('GET',
    `${path}/configuration?actingSubject=${encodeURIComponent(owner.actingSubject!)}`));
  const homeDocument = configuration.configuration.homeDocument;
  const preparationStarted = performance.now(), pages: Page[] = [];
  for (let index = 0; index < 32; index += 4) {
    pages.push(...await Promise.all(Array.from({ length: 4 }, async (_, offset) => {
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const saved = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
        owner.main('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: homeDocument,
          variantId, expectedHead: null, document: fromPlainText(`Site page ${index + offset + 1}`, 'blocks'),
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
          actingSubject: owner.actingSubject }, randomUUID()), 201);
      return { page: homeDocument, variantId, revisionId: saved.revisionId,
        byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch };
    })));
  }
  expect(pages).toHaveLength(32);
  expect(performance.now() - preparationStarted).toBeLessThan(600_000);
  let head = prepared.revision;
  for (const count of [8, 16, 32]) {
    const selected = pages.slice(0, count), key = randomUUID();
    const body = { expectedHead: head, actingSubject: owner.actingSubject,
      routesRevision: created.navigationRevision, navigationRevision: created.navigationRevision, pages: selected };
    const receipt = await answer<Receipt>(owner.main('POST', `${path}/site-publications`, body, key), 201);
    expect(receipt.pages).toHaveLength(count);
    expect(receipt.pages).toEqual(expect.arrayContaining(selected.map(({ page, variantId, revisionId, byteDigest }) => ({ page, variantId, revisionId, byteDigest, language: 'en' }))));
    expect(receipt.homeDocument).toBe(homeDocument);
    expect(receipt.homeRevision).toBeDefined();
    const requestReads = reads.filter(read => read.consumer === 'request' && read.admissionId === receipt.admissionId);
    expect(requestReads.reduce((total, read) => total + read.revisions.length, 0)).toBe(2 * count);
    const deadline = Date.now() + 60_000;
    const relayRevisions = () => reads.filter(read => read.consumer === 'relay' && read.admissionId === receipt.admissionId)
      .flatMap(read => read.revisions);
    while (new Set(relayRevisions()).size < count && Date.now() < deadline) await Bun.sleep(100);
    expect(new Set(relayRevisions()).size).toBe(count);
    expect(relayRevisions().length).toBeLessThanOrEqual(2 * count);
    console.info(`Site publication reads: ${JSON.stringify({ pages: count, requestRows: 2 * count,
      relayRows: relayRevisions().length })}`);
    const replay = await answer<Receipt>(owner.main('POST', `${path}/site-publications`, body, key), 200);
    expect(replay).toEqual({ ...receipt, replayed: true });
    head = receipt.revision;
  }
}, 300_000);
