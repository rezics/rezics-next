import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fusekiImageTag } from '../../../scripts/dev/fuseki-image.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { compositionReceiptIri } from '../src/modules/structure/change.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readZoneSitePublicationReceipt, readZoneSitePublishedPageReceipt, ZoneUnavailable } from '../src/modules/zone/configuration.ts';
import { ZONE_SITE_PUBLICATION_COST, zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';

import type { ContentCore, ContentOutboxEvent, ProjectionPublication } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { settleZonePageContentPublication } from '../src/modules/content-publication/publish.ts';
import { relayContentProjectionOnce } from '../src/modules/content-publication/relay.ts';

const root = resolve(import.meta.dir, '../../..');
const resource = () => `https://rezics.com/id/${randomUUID()}`;
let directory: string, dockerEnvironment: NodeJS.ProcessEnv, image: string, serverJar: string;

beforeAll(() => {
  directory = mkdtempSync(join(root, '.temp/zone-site-receipt-'));
  dockerEnvironment = loadDockerEnvironment();
  image = fusekiImageTag(root);
  const version = /^ARG FUSEKI_VERSION=(\S+)$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!version) throw new Error('The native receipt test requires the pinned Fuseki version');
  serverJar = `/opt/apache-jena-fuseki-${version}/fuseki-server.jar`;
}, 30_000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function fixture(count: number, erased = false) {
  const zone = resource(), revision = resource(), themeRevision = resource(), homeDocument = resource(), homeRevision = resource();
  const admissionId = randomUUID(), receipt = compositionReceiptIri(admissionId, 'zone.edit');
  const dataEpoch = randomUUID(), routesRevision = resource(), navigationRevision = resource();
  const publishedThemeRevision = resource(), publishedThemeActivation = resource();
  const pages = Array.from({ length: count }, (_, index) => ({ page: homeDocument,
    variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID(), byteDigest: hash(`Page ${index}`),
    language: `en-x-${Array.from({ length: 10 }, () => 'abcdefgh').join('-')}-abcde`,
  }));
  const bindings = pages.map(page => zonePublishedPageBinding(revision, page.page, page.revisionId));
  const data = `PREFIX rv: <${RV}>
    ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:structureOwner ${iri(zone)} ; rv:structureRevision ${iri(revision)} ;
        rv:sitePublicationRevision ${iri(revision)} ; rv:routesRevision ${iri(routesRevision)} ;
        rv:navigationRevision ${iri(navigationRevision)} ; rv:themeRevision ${iri(themeRevision)} ;
        rv:publishedPageCount ${count} ; rv:admissionId ${lit(admissionId)} ;
        rv:requestDigest ${lit('a'.repeat(64))} ; rv:authorityEpoch "1" ; rv:admittedScope ${lit(`zone:edit:${zone}`)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence 9 ;
        rv:homeDocument ${iri(homeDocument)} ; rv:homeRevision ${iri(homeRevision)} ;
        rv:publishedThemeRevision ${iri(publishedThemeRevision)} ; rv:publishedThemeActivation ${iri(publishedThemeActivation)}
        ${erased ? '.' : `; rv:publishedPage ${bindings.map(iri).join(', ')} .`}
    }
    ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a rv:ZoneRevision ; rv:component ${iri(zone)} ; rv:predecessor ${iri(themeRevision)} ;
        rv:sitePublicationReceipt ${iri(receipt)} ; rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence 9 ;
        rv:homeDocument ${iri(homeDocument)} ; rv:homeRevision ${iri(homeRevision)} .
      ${erased ? `${iri(homeRevision)} a rv:ErasedRevision .` : `
      ${iri(homeRevision)} a rv:ZoneHomeRevision, rv:RevisionAnchor ; rv:component ${iri(homeDocument)} ;
        rv:publishedPageCount ${count} ; rv:publishedPage ${bindings.map(iri).join(', ')} .
      ${pages.map((page, index) => `${iri(bindings[index]!)} rv:sitePublicationRevision ${iri(revision)} ;
        rv:page ${iri(page.page)} ; rv:variant ${iri(page.variantId)} ;
        rv:contentRevision ${iri(`urn:rezics:content:revision:${page.revisionId}`)} ;
        rv:byteDigest ${lit(page.byteDigest)} ; rv:contentLanguage ${lit(page.language)} .`).join('\n')}`}
    }`;
  const expected = { outcome: 'succeeded' as const, receipt, zone, revision, themeRevision, homeDocument, homeRevision,
    routesRevision, navigationRevision, publishedThemeRevision, publishedThemeActivation,
    admissionId, requestDigest: 'a'.repeat(64), authorityEpoch: '1', scope: `zone:edit:${zone}`, dataEpoch, sequence: '9' };
  const environment = (fuseki: FusekiClient) => ({ fuseki, lineage: { dataEpoch, routingEpoch: randomUUID() } }) as WorkActivationEnvironment;
  return { data, receipt, pages, expected, environment };
}

async function nativeProjection(f: ReturnType<typeof fixture>, allowErasedHome = false, pin?: Parameters<typeof readZoneSitePublishedPageReceipt>[2]) {
  const read = (fuseki: FusekiClient) => pin
    ? readZoneSitePublishedPageReceipt(f.environment(fuseki), f.receipt, pin)
    : readZoneSitePublicationReceipt(f.environment(fuseki), f.receipt, allowErasedHome);
  let query = '';
  class Capture extends FusekiClient {
    override async query(sparql: string, limit?: number): Promise<SparqlResult> {
      query = sparql;
      expect(limit).toBe(65_536);
      return { results: { bindings: [] } };
    }
  }
  await read(new Capture('http://receipt.invalid'));
  const prefix = randomUUID();
  writeFileSync(join(directory, `${prefix}.trig`), f.data);
  writeFileSync(join(directory, `${prefix}.rq`), query);
  const result = spawnSync('docker', ['run', '--rm', '--pull=never', '--network', 'none',
    '--memory', '768m', '--memory-swap', '768m', '--pids-limit', '256', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,size=32m,mode=1777', '--volume', `${directory}:/artifacts:ro,Z`,
    '--entrypoint', 'java', image, '-Xmx384m', '-cp', serverJar, 'arq.arq',
    '--data', `/artifacts/${prefix}.trig`, '--query', `/artifacts/${prefix}.rq`, '--results', 'JSON'],
  { env: preserveReapEnvironment(dockerEnvironment), encoding: 'utf8', timeout: 60_000, maxBuffer: 1_048_576 });
  expect(result.status, result.stderr).toBe(0);
  const wire = JSON.parse(result.stdout) as SparqlResult;
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(await request.text()).toBe(query);
    calls++;
    return new Response(result.stdout, { headers: { 'content-type': 'application/sparql-results+json' } });
  } });
  try {
    const receipt = await read(new FusekiClient(server.url.href));
    expect(calls).toBe(1);
    return { receipt, wire, bytes: Buffer.byteLength(result.stdout) };
  } finally { await server.stop(true); }
}

test('8, 16 and all 32 selections retain one campaign projection within the fixed receipt byte budget', async () => {
  expect(ZONE_SITE_PUBLICATION_COST).toMatchObject({ maxPages: 32, receiptRows: 33, receiptResponseBytes: 65_536 });
  const costs: Array<{ pages: number; receiptRows: number; receiptBytes: number }> = [];
  for (const count of [8, 16, 32]) {
    const f = fixture(count), { receipt, wire, bytes } = await nativeProjection(f);
    const rows = wire.results!.bindings;
    expect(rows).toHaveLength(count);
    expect(rows.filter(row => row.zone)).toHaveLength(1);
    expect(bytes).toBeLessThanOrEqual(65_536);
    expect(receipt).toMatchObject(f.expected);
    expect(receipt!.pages).toHaveLength(count);
    expect(receipt!.pages).toEqual(expect.arrayContaining(f.pages));
    costs.push({ pages: count, receiptRows: rows.length, receiptBytes: bytes });
  }
  console.info(`Zone receipt projection: ${JSON.stringify(costs)}`);
}, 180_000);

test('compaction still refuses missing campaign authority, conflicting metadata and foreign or invalid selections', async () => {
  const f = fixture(8), { wire } = await nativeProjection(f);
  for (const defect of ['missing-scope', 'conflicting-scope', 'conflicting-home', 'foreign-page', 'invalid-digest'] as const) {
    const altered = structuredClone(wire);
    const rows = altered.results!.bindings;
    if (defect === 'missing-scope') delete rows[0]!.scope;
    if (defect === 'conflicting-scope') rows[1]!.scope = { type: 'literal', value: `zone:edit:${resource()}` };
    if (defect === 'conflicting-home') rows[1]!.homeRevision = { type: 'uri', value: resource() };
    if (defect === 'foreign-page') rows[1]!.page = { type: 'uri', value: resource() };
    if (defect === 'invalid-digest') rows[1]!.byteDigest = { type: 'literal', value: 'invalid' };
    class AlteredProof extends FusekiClient {
      override async query(): Promise<SparqlResult> { return altered; }
    }
    await expect(readZoneSitePublicationReceipt(f.environment(new AlteredProof('http://receipt.invalid')), f.receipt))
      .rejects.toBeInstanceOf(ZoneUnavailable);
  }
}, 60_000);

test('the extra receipt row still refuses an overfull retained selection', async () => {
  const f = fixture(33);
  await expect(nativeProjection(f)).rejects.toBeInstanceOf(ZoneUnavailable);
}, 60_000);

test('an erased home retains campaign proof even after its page links are removed', async () => {
  const f = fixture(32, true);
  expect((await nativeProjection(f)).receipt).toBeNull();
  const { receipt, wire } = await nativeProjection(f, true);
  expect(wire.results!.bindings).toHaveLength(1);
  expect(receipt).toEqual({ ...f.expected, homeErased: true, pages: [] });
}, 120_000);


test('request settlement and relay recovery read one retained row per exact pin, including replay', async () => {
  for (const count of [8, 16, 32]) {
    const f = fixture(count), full = await nativeProjection(f);
    const first = f.pages[0]!;
    const nativePin = await nativeProjection(f, false, { resourceId: first.page, ...first });
    expect(nativePin.wire.results!.bindings).toHaveLength(1);
    expect(nativePin.receipt!.pages).toEqual([first]);
    const header = full.wire.results!.bindings[0]!;
    const retained = full.wire.results!.bindings.map(row => ({ ...header, ...row }));
    const contentEpoch = randomUUID();
    const position = (sequence: string) => ({ owner: 'content' as const, dataEpoch: contentEpoch, sequence });
    const publications = f.pages.map((page, index): ProjectionPublication => ({
      preparationId: `content-site-pin:${f.expected.admissionId}:${page.revisionId}`,
      preparationPosition: position(String(index + 1)), status: 'active',
      reference: { resourceId: page.page, variantId: page.variantId, revisionId: page.revisionId,
        format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest: page.byteDigest, byteLength: 12,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', sourceRevision: null,
        predecessor: null, provenance: {} },
      graph: { outcome: 'active', revisionId: page.revisionId, receipt: f.receipt,
        dataEpoch: f.expected.dataEpoch, sequence: f.expected.sequence },
    }));
    const events = publications.map((p, index): ContentOutboxEvent => ({ id: `terminal-${index}`,
      position: position(String(index + 1)), operationId: `settle-${index}`,
      eventType: 'content.publication.active', recipe: 'content-body-v1', revisionId: p.reference.revisionId, payload: {} }));
    let rows = 0, settlements = 0, custodyOpen = true, epoch = contentEpoch;
    class RetainedProof extends FusekiClient {
      override async query(query: string): Promise<SparqlResult> {
        if (query.includes('SELECT ?zone ?revision')) {
          // The native projections above verify the selected query. Count actual
          // returned rows here: a former full-receipt loop returns count² rows.
          const selected = query.includes('FILTER(?page =')
            ? retained.filter(row => query.includes(`?contentRevision = <${row.contentRevision!.value}>`)) : retained;
          rows += selected.length;
          return { results: { bindings: selected } };
        }
        return { boolean: custodyOpen };
      }
    }
    const env = f.environment(new RetainedProof('http://receipt.invalid'));
    const content = { ownerPosition: async () => ({ ...position(String(count)), dataEpoch: epoch }),
      readPublicationPreparation: async (id: string) => {
        const p = publications.find(p => p.preparationId === id);
        return p ? { operationId: id, reference: p.reference, position: p.preparationPosition,
          status: 'pending', pinActive: true, replayed: false } : null;
      },
      settlePublication: async (_id: string, pin: string, proof: unknown, expectedEpoch: string) => {
        const p = publications.find(p => p.preparationId === pin)!;
        expect(proof).toEqual(p.graph); expect(expectedEpoch).toBe(contentEpoch); settlements++;
        return { position: position(String(count)), replayed: false };
      },
      readProjectionPublication: async (event: ContentOutboxEvent) => publications[events.indexOf(event)],
      readPublicationErasureSupersession: async () => null,
      readOutbox: async () => [], sequencePending: async () => false,
    } as unknown as ContentCore;
    for (let replay = 0; replay < 2; replay++) {
      rows = 0;
      for (const p of publications) await settleZonePageContentPublication(env, content, p.preparationId, f.receipt);
      expect(rows).toBe(count);
    }
    expect(settlements).toBe(2 * count);
    for (let recovery = 0; recovery < 2; recovery++) {
      rows = 0; let finished = 0;
      const cursor = { retries: async () => events, readScan: async () => position(String(count)),
        finishRetry: async (_consumer: string, _event: unknown, succeeded: boolean) => {
          expect(succeeded).toBe(true); finished++;
        },
      } as unknown as ContentProjectionCursor;
      expect((await relayContentProjectionOnce(env, content, cursor, 'public-search'))?.disposition).toBe('ignored');
      expect(finished).toBe(count); expect(rows).toBe(count);
    }
    // A later invocation must recheck authority, rather than reuse success.
    custodyOpen = false;
    let refused = 0;
    const cursor = { retries: async () => events, readScan: async () => position(String(count)),
      finishRetry: async (_consumer: string, _event: unknown, succeeded: boolean) => {
        expect(succeeded).toBe(false); refused++;
      },
    } as unknown as ContentProjectionCursor;
    await relayContentProjectionOnce(env, content, cursor, 'public-search', randomUUID());
    expect(refused).toBe(count);
    epoch = randomUUID();
    await expect(settleZonePageContentPublication(env, content, publications[0]!.preparationId, f.receipt)).rejects.toThrow();
    await expect(settleZonePageContentPublication(env, content, 'absent-pin', f.receipt)).rejects.toThrow();
    expect(settlements).toBe(2 * count);
  }
}, 300_000);
