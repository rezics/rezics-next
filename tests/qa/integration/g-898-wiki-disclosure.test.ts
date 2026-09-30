import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

test('G-898: candidate HTTP responses are identical with private members present or absent, including public alias collisions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-898-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read space:create zone:edit collection:edit semantic:read wiki:propose');
  f.access.configureBaseline(f.env.fuseki);
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier, access: f.access,
    structureObjects: objects, catalogueIntake: new CatalogueIntakeStore(f.accessPool, f.env) });
  const call = (path: string, body: object) => app.handle(new Request(`http://main.local${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
      'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
  async function json<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }
  const originalQuery = f.nativeFuseki.query.bind(f.nativeFuseki);
  try {
    const { candidateReceipt } = await json<{ candidateReceipt: string }>(await call('/v1/catalogue/candidates', {
      profile: 'catalogue-candidates-v1', originalTitle: { value: 'Disclosure wiki', language: 'en' },
      aliases: [], romanizations: [], creators: [], dates: [], identifiers: [] }));
    const work = await json<{ work: string }>(await call('/v1/works', {
      profile: 'metadata-only-v1', grain: 'new-creative-scope', candidateReceipt,
      title: 'Disclosure wiki', language: 'en', semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }), 201);
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant('semantic:create:root', 'semantic.change');
    const character = async (name: string, publicWork = false) => {
      const created = await json<{ component: string }>(await call('/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor, state: { component: 'resource',
          types: [`${RV}Character`], properties: [
            { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
            { predicate: 'https://schema.org/alternateName', value: { kind: 'language-string', lexical: 'Shared alias', language: 'en' } },
            ...(publicWork ? [{ predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: work.work } }] : []),
          ] } }), 201);
      const grant = await f.grant(`semantic:read:${created.component}`, 'semantic.read');
      return { ...created, grant };
    };
    const publicMember = await character('Public character', true);
    const privateMember = await character('Secret character');
    const collection = async (name: string, targets: string[]) => {
      const collection = nativeId();
      await f.grant(`collection:edit:${collection}`, 'collection.edit');
      await f.grant(`semantic:read:${collection}`, 'semantic.read');
      const made = await json<{ structure: string; revision: string }>(await call('/v1/collections', {
        collection, name, language: 'en', disclosure: 'public', actingSubject: f.actor }), 201);
      const inserted = await json<{ revision: string; occurrences: string[] }>(
        await call(`/v1/collections/${shortId(collection)}/changes`, { expectedHead: made.revision,
          actingSubject: f.actor, operations: targets.map(target => ({
            op: 'insert', role: 'member', parent: made.structure, position: 'last', target })) }));
      return { collection, ...inserted };
    };
    const franchise = await collection('Franchise', [work.work]);
    const characters = await collection('Characters', [publicMember.component, privateMember.component]);
    await f.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(await call('/v1/spaces', { profile: 'space-realm-v1',
      name: 'Disclosure wiki', capabilities: ['realm'], actingSubject: f.actor }), 201);
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    let navigation = await json<{ revision: string }>(await call('/v1/zones', { zone, space: space.space,
      disclosure: 'public', actingSubject: f.actor }), 201);
    for (const [segment, target] of [['franchise', franchise.collection], ['characters', characters.collection]]) {
      navigation = await json(await call(`/v1/zones/${shortId(zone)}/mounts`, { expectedHead: navigation.revision,
        target, routeSegment: segment, position: 'last', disclosure: 'public', actingSubject: f.actor }));
    }
    // Both stored name sources are probed; a hidden name record also collides with a public record.
    const publicName = nativeId(), privateName = nativeId(), secretName = nativeId();
    await f.nativeFuseki.update(`INSERT DATA { GRAPH <${GRAPHS.current}> {
      <${publicMember.component}> <${RV}nameRecord> <${publicName}> .
      <${privateMember.component}> <${RV}nameRecord> <${privateName}>, <${secretName}> .
      <${publicName}> <http://www.w3.org/2008/05/skos-xl#literalForm> "Shared record"@en .
      <${privateName}> <http://www.w3.org/2008/05/skos-xl#literalForm> "Shared record"@fr .
      <${secretName}> <http://www.w3.org/2008/05/skos-xl#literalForm> "Secret record"@fr .
    } }`);
    const request = { target: work.work, zone, actingSubject: f.actor,
      names: ['Secret character', 'Secret record', 'Shared alias', 'Shared record', 'Unknown']
        .map(value => ({ value, language: 'fr' })) };
    const response = async () => {
      const result = await call('/v1/wiki/candidates', request);
      const body = await result.text();
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toBe('no-store');
      return body;
    };
    expect(JSON.parse(await response()).items.map((item: { status: string }) => item.status))
      .toEqual(['matched', 'matched', 'ambiguous', 'ambiguous', 'new']);
    // Public Work disclosure must continue to work without an explicit semantic grant.
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = ANY($1::uuid[])',
      [[publicMember.grant, privateMember.grant]]);
    const scanned: string[] = [];
    f.nativeFuseki.query = async (query, maxBytes) => {
      if (query.includes('SELECT ?resource ?manifest') || query.includes('rv:nameRecord')) scanned.push(query);
      return originalQuery(query, maxBytes);
    };
    const present = await response();
    expect(JSON.parse(present).items).toEqual([
      { index: 0, status: 'new', candidates: [] }, { index: 1, status: 'new', candidates: [] },
      { index: 2, status: 'matched', candidates: [publicMember.component] },
      { index: 3, status: 'matched', candidates: [publicMember.component] },
      { index: 4, status: 'new', candidates: [] },
    ]);
    expect(scanned.length).toBeGreaterThan(0);
    for (const query of scanned) expect(query).not.toContain(`<${privateMember.component}>`);
    // Revoke after names were read to exercise the final disclosure fence.
    await f.accessPool.query('UPDATE access.permission_grant SET active = true WHERE id = $1', [privateMember.grant]);
    f.nativeFuseki.query = async (query, maxBytes) => {
      const result = await originalQuery(query, maxBytes);
      if (query.includes('rv:nameRecord') && query.includes('skos-xl#literalForm')) {
        await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [privateMember.grant]);
      }
      return result;
    };
    expect(await response()).toBe(present);
    f.nativeFuseki.query = originalQuery;
    await json(await call(`/v1/collections/${shortId(characters.collection)}/changes`, {
      expectedHead: characters.revision, actingSubject: f.actor,
      operations: [{ op: 'remove', occurrence: characters.occurrences[1] }] }));
    expect(await response()).toBe(present);
  } finally {
    f.nativeFuseki.query = originalQuery;
    await f.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
