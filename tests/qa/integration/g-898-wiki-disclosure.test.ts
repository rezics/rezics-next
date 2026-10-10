import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { validationsFor } from '../../../services/main/src/modules/semantic/command.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
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
    // The product assembler admits guarded commands, not raw SPARQL Update.
    const publicName = nativeId(), privateName = nativeId(), secretName = nativeId();
    await plantNameRecords(f.env, [
      [publicMember.component, publicName, 'Shared record', 'en'],
      [privateMember.component, privateName, 'Shared record', 'fr'],
      [privateMember.component, secretName, 'Secret record', 'fr'],
    ]);
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

/** Current-graph name records, through the guarded command the product assembler admits. */
async function plantNameRecords(env: Parameters<typeof validationsFor>[0],
  records: readonly (readonly [string, string, string, string])[]): Promise<void> {
  const receipt = `urn:rezics:receipt:${hash(randomUUID())}`;
  const digest = hash(receipt);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const resources = [...new Set(records.map(([resource]) => resource))];
  const heads = new Map<string, string>();
  for (const row of (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?resource ?head WHERE {
    VALUES ?resource { ${resources.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?resource rv:semanticHead ?head }
  }`)).results?.bindings ?? []) {
    if (row.resource?.value && row.head?.value) heads.set(row.resource.value, row.head.value);
  }
  if (resources.some(resource => !heads.get(resource))) throw new Error('name record resource has no semantic head');
  // A current-graph subject needs a registry type. The label stays a SKOS-XL
  // name and also a Resource so the open semantic envelope can carry it.
  const triples = records.map(([resource, label, lexical, language]) =>
    `${iri(resource)} <${RV}nameRecord> ${iri(label)} .
     ${iri(label)} a <http://www.w3.org/2008/05/skos-xl#Label>, <http://www.w3.org/2000/01/rdf-schema#Resource> ;
       <${RV}semanticHead> ${iri(heads.get(resource)!)} ;
       <http://www.w3.org/2008/05/skos-xl#literalForm> ${JSON.stringify(lexical)}@${language} .`).join('\n');
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${triples}
      }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(randomUUID())} ;
        rv:authorityEpoch ${lit('0')} ; rv:admittedScope ${lit('semantic.change')} ;
        rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:SemanticChangedEvent ; rv:ordinal 0 ; rv:action ${lit('semantic.change')} ;
          rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = [
    ...await validationsFor(env, 'semantic-annotation-v1', [
      { role: 'label', focus: records.map(([, label]) => label) },
    ]),
    ...await validationsFor(env, 'semantic-resource-v1', [
      { role: 'resource', focus: [...new Set(records.map(([resource]) => resource))] },
    ]),
  ];
  const result = await env.fuseki.commandWithReceipt({
    receipt, digest, update, validations, deadlineMs: 10_000,
  });
  if (result.status !== 'committed') {
    throw new Error(`name records were not planted: ${result.status} ${JSON.stringify('report' in result ? result.report : undefined)}`);
  }
}
