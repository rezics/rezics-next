import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { disclosureContent } from '../src/modules/disclosure/assembly.ts';
import { hash, RV } from '../src/modules/work/activate.ts';
import { contentRoutes } from '../src/routes/content.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const resource = () => `https://rezics.com/id/${randomUUID()}`;

/** Exercise the route and existing Zone authority bridge with transport doubles.
 * The saved home resource is distinct from the Zone receiving the mandate. */
function fixture() {
  const zone = resource(), home = resource(), actor = resource(), otherActor = resource();
  const revisionId = randomUUID(), principalId = randomUUID();
  const principal = { issuer: 'https://account.test', subject: 'operator', emailVerified: true };
  const state = { mandate: `zone:edit:${zone}`, grantLive: true, administrator: true,
    controllers: new Set([actor, otherActor]), recovery: true, erased: false, disclosed: true };
  const probes = { reads: 0, authority: 0, work: 0 };
  const body = { body: 'Saved private home with original credit' };
  const serializedJson = JSON.stringify(body);
  const exact: Extract<ExactReadResult, { status: 'available' }> = {
    revisionId, status: 'available', body, serializedJson,
    reference: { owner: 'content', resourceId: home, revisionId,
      variantId: `urn:rezics:variant:${randomUUID()}`, format: 'rezics-content-json-v1',
      model: 'content-shape-v1', byteDigest: hash(serializedJson), byteLength: Buffer.byteLength(serializedJson),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      sourceRevision: null, predecessor: null, provenance: { author: resource() } },
  };
  const uri = (value: string) => ({ type: 'uri' as const, value });
  const graph = new class extends FusekiClient {
    constructor() { super('http://zone-preview.invalid'); }
    override async query(query: string): Promise<SparqlResult> {
      if (query.includes('SELECT DISTINCT ?type')) {
        expect(query).toContain(`rv:homeDocument <${home}>`);
        return { results: { bindings: [{ type: uri(`${RV}ZoneHomeDocument`), zone: uri(zone) }] } };
      }
      if (query.includes('SELECT ?space ?navigation ?head')) {
        expect(query).toContain(`<${zone}>`);
        return { results: { bindings: [] } };
      }
      if (query.includes('SELECT ?admission ?receipt ?digest')) return { results: { bindings: [] } };
      if (query.includes('rv:ErasedRevision')) return { results: { bindings: state.erased
        ? [{ target: uri(`urn:rezics:content:revision:${revisionId}`) }] : [] } };
      if (query.includes('ASK')) return { boolean: !query.includes('rv:owner') };
      throw new Error(`Unexpected preview query: ${query.slice(0, 100)}`);
    }
  }();
  const client = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('access.scope_gate')) return { rows: [{ id: 'platform:access' }] };
    if (sql.includes('read_platform_permissions')) return { rows: [
      ...(state.administrator ? [{ id: randomUUID(), action: 'platform:use:platform-admin',
        scope_id: 'platform:access', generation: '1', witness: 'admin', valid_until: null }] : []),
      // The broad grant precedes the exact mandate and cannot shadow it.
      { id: randomUUID(), action: 'platform:resource:zone.edit', scope_id: 'zone:edit:*',
        generation: '1', witness: 'broad', valid_until: null },
      ...(state.grantLive ? [{ id: randomUUID(), action: 'platform:resource:zone.edit',
        scope_id: state.mandate, generation: '1', witness: 'exact', valid_until: null }] : []),
    ] };
    if (sql.includes('SELECT $3::text AS receipt')) return { rows: state.controllers.has(String(values[1]))
      ? [{ receipt: values[2], representation_id: randomUUID(), representation_generation: '1',
        subject_generation: '1', principal_epoch: '1' }] : [] };
    throw new Error(`Unexpected preview authority SQL: ${sql.slice(0, 100)}`);
  } } as unknown as PoolClient;
  let afterRead: () => void = () => undefined;
  const deps = {
    environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account: { verify: async (_request: Request, scopes: string[]) => {
      expect(scopes).toEqual(['zone:edit']);
      return principal;
    } },
    access: {
      activePrincipalId: async () => principalId,
      canReadWork: async () => { probes.work++; return false; },
      withOwnerAuthority: async (authority: unknown, operation: (client: PoolClient) => Promise<unknown>) => {
        probes.authority++;
        expect(authority).toMatchObject({ principal, action: 'content.draft',
          scope: `content:draft:${zone}`, resolvedZonePage: zone });
        return operation(client);
      },
      assertRecoveryOpen: async () => {
        if (!state.recovery) throw new AdmissionUnavailable('Recovery is held');
      },
    },
    content: {
      owningResourceForRevision: async (wanted: string) => wanted === revisionId ? home : null,
      readExactBatch: async (wanted: string[], authorize: Parameters<ContentCore['readExactBatch']>[1]) => {
        expect(wanted).toEqual([revisionId]);
        expect(await authorize(wanted)).toEqual(new Set(wanted));
        probes.reads++;
        afterRead();
        return [exact];
      },
    },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, () => undefined);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets =>
    targets.map(() => state.disclosed ? 'visible' : 'hidden')));
  // Production composes this owner adapter before the route's own disclosure check.
  deps.content = disclosureContent(deps.content!, deps.environment);
  const app = contentRoutes(graph, deps);
  const read = (subject: string | null = actor, wanted = revisionId) => app.handle(new Request(
    `http://main.local/v1/content-revisions/${wanted}${subject ? `?actingSubject=${encodeURIComponent(subject)}` : ''}`,
    { headers: { authorization: 'Bearer operator' } },
  ));
  return { zone, home, actor, otherActor, state, probes, exact, read,
    afterRead: (operation: () => void) => { afterRead = operation; } };
}

test('a live exact Zone mandate previews its saved home cut with unchanged bytes and saving Agent credit', async () => {
  const f = fixture();
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ reference: f.exact.reference,
    serializedJson: f.exact.serializedJson, body: f.exact.body });
  expect(f.probes).toEqual({ reads: 1, authority: 2, work: 0 });
});

for (const refusal of ['wrong-zone', 'home-scope', 'broad-only', 'revoked', 'expired', 'no-admin', 'no-controller'] as const) {
  test(`${refusal} authority cannot preview saved private Zone bytes`, async () => {
    const f = fixture();
    if (refusal === 'wrong-zone') f.state.mandate = `zone:edit:${resource()}`;
    if (refusal === 'home-scope') f.state.mandate = `zone:edit:${f.home}`;
    if (['broad-only', 'revoked', 'expired'].includes(refusal)) f.state.grantLive = false;
    if (refusal === 'no-admin') f.state.administrator = false;
    if (refusal === 'no-controller') f.state.controllers.delete(f.actor);
    const response = await f.read();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'revision_unavailable' });
    expect(f.probes.reads).toBe(0);
  });
}

test('unknown cuts and missing named Agent remain unavailable under an exact mandate', async () => {
  const f = fixture();
  expect((await f.read(f.actor, randomUUID())).status).toBe(404);
  expect((await f.read(null)).status).toBe(404);
  expect(f.probes.reads).toBe(0);
});

test('an independent named Agent path reads only while its own controller and mandate remain live', async () => {
  const f = fixture();
  f.state.controllers.delete(f.actor);
  expect((await f.read()).status).toBe(404);
  expect((await f.read(f.otherActor)).status).toBe(200);
  f.state.grantLive = false;
  expect((await f.read(f.otherActor)).status).toBe(404);
  f.state.grantLive = true;
  f.state.controllers.delete(f.otherActor);
  expect((await f.read(f.otherActor)).status).toBe(404);
});

for (const withdrawal of ['mandate', 'controller', 'disclosure', 'erasure', 'recovery'] as const) {
  test(`${withdrawal} withdrawal during hydration withholds saved Zone bytes`, async () => {
    const f = fixture();
    f.afterRead(() => {
      if (withdrawal === 'mandate') f.state.grantLive = false;
      if (withdrawal === 'controller') f.state.controllers.delete(f.actor);
      if (withdrawal === 'disclosure') f.state.disclosed = false;
      if (withdrawal === 'erasure') f.state.erased = true;
      if (withdrawal === 'recovery') f.state.recovery = false;
    });
    const response = await f.read();
    expect(response.status).toBe(withdrawal === 'recovery' ? 503 : 404);
    expect(await response.text()).not.toContain(f.exact.serializedJson);
    expect(f.probes.reads).toBe(1);
  });
}
