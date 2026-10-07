import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied, AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { hash, prepareComponent, RV } from '../src/modules/work/activate.ts';
import { ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { contentRoutes } from '../src/routes/content.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const nativeId = () => `https://rezics.com/id/${randomUUID()}`;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function gate() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, pause: async () => { entered(); await released; } };
}

function fixture(input: { published?: boolean; phase?: 'rights' | 'delivery'; post?: boolean } = {}) {
  const id = nativeId(), actor = nativeId(), space = nativeId(), head = nativeId(), navigation = nativeId();
  const revisionId = randomUUID(), variantId = `urn:rezics:variant:${randomUUID()}`;
  const principal = { issuer: 'https://account.test', subject: 'editor', emailVerified: true };
  const state = { published: input.published ?? true, authority: true, steward: true,
    rights: true, recovery: true, erased: false, restore: false };
  const probes = { membership: 0, authority: 0, content: 0, work: 0, recovery: 0, rights: 0 };
  const paused = gate();
  const text = 'Exact Zone bytes withheld after a late owner withdrawal';
  const serializedJson = `{ "body" : ${JSON.stringify(text)} }`;
  const exact: Extract<ExactReadResult, { status: 'available' }> = { revisionId, status: 'available', serializedJson, body: { body: text },
    reference: { owner: 'content', resourceId: id, variantId, revisionId,
      format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest: hash(serializedJson),
      byteLength: Buffer.byteLength(serializedJson), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr', sourceRevision: null, predecessor: null,
      provenance: input.phase === 'rights'
        ? { kind: 'admitted-public-domain-v1', rightsAssessmentId: randomUUID() } : {} } };
  const root = resolve('.temp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(`${root}/content-zone-delivery-`);
  directories.push(directory);
  const manifest = `urn:rezics:sha256:${prepareComponent(directory, id, { name: 'Home', language: 'en' }, ZONE_PROFILE)}`;
  const uri = (value: string) => ({ type: 'uri' as const, value });
  const graph = new class extends FusekiClient {
    constructor() { super('http://zone-delivery.invalid'); }
    override async query(query: string): Promise<SparqlResult> {
      if (query.includes('SELECT DISTINCT ?type')) return { results: { bindings: [
        { type: uri(`${RV}${input.post ? 'Post' : 'Zone'}`) },
      ] } };
      if (query.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [{
        space: uri(space), navigation: uri(navigation), head: uri(head), manifest: uri(manifest),
        state: uri(`${RV}Active`), disclosure: uri(`${RV}Public`), spaceDisclosure: uri(`${RV}Public`),
        ...(state.published ? { publication: uri(head) } : {}),
      }] } };
      if (query.includes('rv:publishedPage <urn:rezics:zone-published-page:')) {
        probes.membership++;
        expect(query).toContain(`<${id}> a rv:Zone`);
        expect(query).toContain(`rv:page <${id}>`);
        expect(query).toContain(`rv:contentRevision <urn:rezics:content:revision:${revisionId}>`);
        return { boolean: state.published && !state.restore };
      }
      if (query.includes('SELECT ?admission ?receipt ?digest')) return { results: { bindings: state.steward ? [{
        admission: { type: 'literal', value: randomUUID() }, receipt: uri(`urn:rezics:receipt:${'a'.repeat(64)}`),
        digest: { type: 'literal', value: 'b'.repeat(64) },
      }] : [] } };
      if (query.includes('rv:ErasedRevision')) return { results: { bindings: state.erased
        ? [{ target: uri(`urn:rezics:content:revision:${revisionId}`) }] : [] } };
      if (query.includes('ASK')) return { boolean: !state.restore };
      throw new Error(`Unexpected exact Zone delivery query: ${query.slice(0, 100)}`);
    }
  }();
  const deps = {
    environment: { fuseki: graph, objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account: { verify: async (_request: Request, scopes: string[]) => {
      expect(scopes).toEqual(input.post ? ['work:read'] : state.published ? [] : ['zone:edit']);
      return principal;
    } },
    access: {
      activePrincipalId: async () => randomUUID(),
      canReadWork: async (_principal: unknown, subject: string, resource: string) => {
        probes.work++;
        return state.authority && subject === actor && resource === id;
      },
      assertRecoveryOpen: async () => {
        if (++probes.recovery === 1 && input.phase === 'delivery') await paused.pause();
        if (!state.recovery) throw new AdmissionUnavailable('Access recovery is held');
      },
      withOwnerAuthority: async (authority: Record<string, unknown>, operation: (client: PoolClient) => Promise<unknown>) => {
        probes.authority++;
        expect(authority).toMatchObject({ principal, actingSubject: actor,
          action: 'content.draft', scope: `content:draft:${id}`, resolvedZonePage: id });
        if (!state.authority) throw new AdmissionDenied('Controller withdrawn');
        return operation({ query: async (sql: string) => ({ rows: [],
          rowCount: sql.includes('SELECT a.id FROM access.admission a') && state.steward ? 1 : 0,
        }) } as unknown as PoolClient);
      },
    },
    content: { owningResourceForRevision: async () => id,
      readExactBatch: async (wanted: string[], authorize: Parameters<ContentCore['readExactBatch']>[1]) => {
        expect(wanted).toEqual([revisionId]);
        expect(await authorize(wanted)).toEqual(new Set(wanted));
        probes.content++;
        return [exact];
      } },
    rights: { store: { currentPublicDomainAssessment: async () => {
      probes.rights++;
      await paused.pause();
      return state.rights;
    } } },
  } as unknown as MainWorkDependencies;
  const app = contentRoutes(graph, deps);
  const read = (bearer = !state.published || input.post) => app.handle(new Request(
    `http://main.local/v1/content-revisions/${revisionId}${bearer ? `?actingSubject=${encodeURIComponent(actor)}` : ''}`,
    { headers: bearer ? { authorization: 'Bearer editor' } : {} },
  ));
  const wait = (pending: Promise<Response>) => Promise.race([paused.reached,
    pending.then(response => { throw new Error(`Exact read finished before paused ${input.phase}: ${response.status}`); })]);
  return { read, wait, release: paused.release, state, probes, exact, text };
}

for (const phase of ['rights', 'delivery'] as const) {
  for (const published of [false, true]) {
    test(`exact ${published ? 'public bundle' : 'Zone editor'} bytes stay unchanged after awaited ${phase}`, async () => {
      const f = fixture({ phase, published });
      const pending = f.read();
      try { await f.wait(pending); } finally { f.release(); await pending; }
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ reference: f.exact.reference,
        serializedJson: f.exact.serializedJson, body: { body: f.text } });
      expect(f.probes.content).toBe(1);
      expect(published ? f.probes.membership : f.probes.authority).toBe(2);
    });
  }

  for (const withdrawal of ['bundle', 'controller', 'owner'] as const) {
    test(`${withdrawal} withdrawal during exact Zone ${phase} refuses before Response`, async () => {
      const f = fixture({ phase, published: withdrawal === 'bundle' });
      const pending = f.read();
      try {
        await f.wait(pending);
        if (withdrawal === 'bundle') f.state.published = false;
        if (withdrawal === 'controller') f.state.authority = false;
        if (withdrawal === 'owner') f.state.steward = false;
      } finally { f.release(); await pending; }
      const response = await pending;
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain(f.text);
      expect(body).not.toContain('serializedJson');
      expect(f.probes.content).toBe(1);
    });
  }
}

for (const fence of ['rights', 'recovery', 'erased', 'restore'] as const) {
  test(`exact Zone ${fence} refusal still suppresses bytes at delivery`, async () => {
    const f = fixture({ phase: 'rights' });
    const pending = f.read();
    try {
      await f.wait(pending);
      if (fence === 'rights') f.state.rights = false;
      if (fence === 'recovery') f.state.recovery = false;
      if (fence === 'erased') f.state.erased = true;
      if (fence === 'restore') f.state.restore = true;
    } finally { f.release(); await pending; }
    const response = await pending;
    expect(response.status).toBe(['recovery', 'restore'].includes(fence) ? 503 : 404);
    expect(await response.text()).not.toContain(f.text);
  });
}

test('native Post exact reads remain private and retain their original Work authority path', async () => {
  const f = fixture({ post: true, published: false });
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ serializedJson: f.exact.serializedJson });
  expect(f.probes.work).toBe(1);
  expect(f.probes.authority).toBe(0);
  expect((await f.read(false)).status).toBe(404);
  f.state.authority = false;
  expect((await f.read()).status).toBe(404);
});

test('public Zone exact bytes accept optional bearer; an unpublished Zone never gains anonymous preview', async () => {
  const published = fixture();
  expect((await published.read(true)).status).toBe(200);
  expect(published.probes.authority).toBe(0);
  const draft = fixture({ published: false });
  expect((await draft.read(false)).status).toBe(404);
  expect(draft.probes.content).toBe(0);
});
