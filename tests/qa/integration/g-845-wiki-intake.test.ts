import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { WikiQuotationStore, extractionQuotationUses } from '../../../services/main/src/modules/wiki/quotation.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

test('G-845: Pride and Prejudice API matches scoped names and previews bounded, aligned holder evidence', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-845-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read space:create zone:edit collection:edit semantic:read wiki:propose');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier, access: f.access,
    structureObjects: objects, wikiQuotations: new WikiQuotationStore(f.pool) });
  const call = (path: string, body: object, token = f.account.tokenA) => app.handle(new Request(`http://main.local${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
  async function json<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }
  const createWork = async (title: string) => {
    const work = await json<{ work: string; mainVersion: string }>(await call('/v1/works', {
      profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }), 201);
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    return work;
  };
  const collection = async (name: string, targets: string[]) => {
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const created = await json<{ structure: string; revision: string }>(await call('/v1/collections', {
      collection, name, language: 'en', disclosure: 'public', actingSubject: f.actor }), 201);
    if (targets.length) await json(await call(`/v1/collections/${shortId(collection)}/changes`, {
      expectedHead: created.revision, actingSubject: f.actor, operations: targets.map(target => ({
        op: 'insert', role: 'member', parent: created.structure, position: 'last', target })) }));
    return collection;
  };
  try {
    const work = await createWork('Pride and Prejudice');
    const elsewhere = await createWork('Sense and Sensibility');
    const structure = await json<{ structure: string; revision: string }>(await call('/v1/compositions', {
      profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: f.actor }), 201);
    const chapter = await json<{ occurrences: string[] }>(await call(`/v1/compositions/${shortId(structure.structure)}/changes`, {
      profile: 'book-composition', expectedHead: structure.revision, actingSubject: f.actor, operations: [{
        op: 'insert', parent: structure.structure, position: 'last', role: 'chapter',
        target: 'https://schema.org/DigitalDocument', label: { value: 'Chapter one', language: 'en' } }] }));
    await f.grant('semantic:create:root', 'semantic.change');
    const character = async (name: string, aliases: string[] = []) => {
      const created = await json<{ component: string; revision: string }>(await call('/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor, state: { component: 'resource',
          types: ['https://rezics.com/vocab/Character'], properties: [name, ...aliases].map((value, index) => ({
            predicate: `https://schema.org/${index === 0 ? 'name' : 'alternateName'}`,
            value: { kind: 'language-string', lexical: value, language: 'en' } })) } }), 201);
      const grant = await f.grant(`semantic:read:${created.component}`, 'semantic.read');
      return { ...created, grant };
    };
    const elizabeth = await character('Elizabeth', ['Miss Bennet']);
    const jane = await character('Jane', ['Miss Bennet']);
    const hidden = await character('Restricted Character');
    const outside = await character('Lizzy');
    const predicate = await json<{ component: string }>(await call('/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
      state: { component: 'definition', kind: 'property' } }), 201);
    await f.grant(`semantic:read:${predicate.component}`, 'semantic.read');
    const relation = await json<{ component: string }>(await call('/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
      state: { component: 'definition', kind: 'relation', roles: [
        { key: 'subject', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'object', minParticipants: 1, maxParticipants: 1, ordered: false }] } }), 201);
    await f.grant(`semantic:read:${relation.component}`, 'semantic.read');
    const franchise = await collection('Pride and Prejudice franchise', [work.work]);
    const characters = await collection('Characters', [elizabeth.component, jane.component, hidden.component]);
    await collection('Other franchise characters', [outside.component]);
    await f.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(await call('/v1/spaces', { profile: 'space-realm-v1',
      name: 'Pride and Prejudice wiki', capabilities: ['realm'], actingSubject: f.actor }), 201);
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    let navigation = await json<{ revision: string }>(await call('/v1/zones', { zone, space: space.space,
      disclosure: 'public', actingSubject: f.actor }), 201);
    for (const [segment, target] of [['franchise', franchise], ['characters', characters]]) {
      navigation = await json(await call(`/v1/zones/${shortId(zone)}/mounts`, { expectedHead: navigation.revision,
        target, routeSegment: segment, position: 'last', disclosure: 'public', actingSubject: f.actor }));
    }
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [hidden.grant]);
    const candidateRequest = { target: work.work, zone, actingSubject: f.actor,
      names: ['Elizabeth', 'Lizzy', 'Miss Bennet', 'Restricted Character', 'Ｅｌｉｚａｂｅｔｈ'].map(value => ({ value, language: 'en' })) };
    const candidates = await json<{ items: Array<{ index: number; status: string; candidates: string[] }> }>(
      await call('/v1/wiki/candidates', candidateRequest));
    expect(candidates.items.map(item => item.status)).toEqual(['matched', 'new', 'ambiguous', 'unavailable', 'matched']);
    expect(candidates.items[0]!.candidates).toEqual([elizabeth.component]);
    expect(candidates.items[2]!.candidates.sort()).toEqual([elizabeth.component, jane.component].sort());
    expect(candidates.items[3]).toEqual({ index: 3, status: 'unavailable', candidates: [] });
    expect(JSON.stringify(candidates)).not.toContain('Restricted Character');
    expect(JSON.stringify(candidates)).not.toContain(hidden.component);
    expect(JSON.stringify(candidates)).not.toContain(outside.component);
    const bundle: WikiExtraction = { profile: 'wiki-extraction-v1', target: work.work, zone, continuity: work.work,
      source: { representationSha256: 'a'.repeat(64), mediaType: 'text/plain', language: 'en', rightsBasis: 'public_domain',
        method: { agent: 'Holder agent', model: 'Local extraction model', inference: 'local' } },
      units: [{ id: 'chapter-1', ordinal: 1, label: 'Chapter one', occurrence: chapter.occurrences[0]! },
        { id: 'unmapped', ordinal: 2, label: 'Unmapped appendix', occurrence: null }],
      entities: [{ id: 'elizabeth', type: 'https://rezics.com/vocab/Character', match: elizabeth.component,
        names: [{ value: 'Elizabeth', language: 'en', kind: 'primary', revealedAt: 'chapter-1' }] },
      { id: 'darcy', type: 'https://rezics.com/vocab/Character', names: [{ value: 'Darcy', language: 'en',
        kind: 'primary', revealedAt: 'chapter-1' }] }],
      claims: [{ subject: 'elizabeth', predicate: predicate.component, object: { kind: 'literal', value: 'Bennet' },
        modality: 'narrated', continuity: work.work, revealedAt: 'chapter-1', evidence: [{ quote: 'a'.repeat(200), locator: {
          version: 'rezics-locator-v1', source: { type: 'external', representationSha256: 'a'.repeat(64), mediaType: 'text/plain' },
          selector: { type: 'ByteRangeSelector', unit: 'byte', start: 0, end: 200 } } }] }] };
    const validate = (value: object, token?: string) => call('/v1/wiki/validations', { actingSubject: f.actor, bundle: value }, token);
    const accepted = await json<{ entities: Array<{ id: string; action: string; revision: string | null }>;
      claims: object[]; relations: object[]; alignment: Array<{ status: string }>; quotations: { addedCodePoints: number } }>(await validate(bundle));
    expect(accepted.entities).toMatchObject([{ id: 'elizabeth', action: 'reuse', revision: elizabeth.revision },
      { id: 'darcy', action: 'create', revision: null }]);
    expect(accepted.claims).toHaveLength(1);
    expect(accepted.alignment.map(item => item.status)).toEqual(['aligned', 'unaligned']);
    expect(accepted.quotations.addedCodePoints).toBe(200);
    expect((await f.pool.query('SELECT * FROM wiki.quotation WHERE work = $1', [work.work])).rows).toHaveLength(0);
    const related = structuredClone(bundle);
    related.claims[0]!.predicate = relation.component;
    related.claims[0]!.object = { kind: 'entity', ref: 'darcy' };
    expect(await json(await validate(related))).toMatchObject({ claims: [], relations: [{ predicate: relation.component }] });
    const rejected = async (value: object, code: string, status = 422) => {
      expect(await json(await validate(value), status)).toMatchObject({ code });
    };
    const long = structuredClone(bundle);
    long.claims[0]!.evidence[0]!.quote = '😀'.repeat(201);
    await rejected(long, 'wiki_passage_limit');
    const unaligned = structuredClone(bundle);
    unaligned.claims[0]!.revealedAt = 'unmapped';
    await rejected(unaligned, 'wiki_unaligned_unit');
    const otherContinuity = structuredClone(bundle);
    otherContinuity.continuity = elsewhere.work;
    otherContinuity.claims[0]!.continuity = elsewhere.work;
    await rejected(otherContinuity, 'wiki_continuity_mismatch');
    const wrongSource = structuredClone(bundle);
    wrongSource.claims[0]!.evidence[0]!.locator.source = { type: 'external', representationSha256: 'b'.repeat(64), mediaType: 'text/plain' };
    await rejected(wrongSource, 'wiki_locator_source');
    const unknown = structuredClone(bundle);
    unknown.claims[0]!.predicate = 'https://example.test/Unregistered';
    await rejected(unknown, 'wiki_predicate');
    await rejected({ ...bundle, body: 'The full source novel' }, 'invalid_wiki_extraction', 400);
    await rejected({ ...bundle, target: elsewhere.work }, 'wiki_target_mismatch');
    expect((await call('/v1/wiki/candidates', candidateRequest, f.account.noScope)).status).toBe(401);
    expect((await validate(bundle, f.account.noScope)).status).toBe(401);
    // Applied by another holder/account, realization and Zone: the ledger has
    // no such partitions, and validation never reads pending proposal records.
    await f.pool.query(`INSERT INTO wiki.quotation(work,representation_sha256,locator_digest,quote_digest,
      code_points,policy_version,applied_receipt) SELECT $1, repeat('b',64), lpad(to_hex(n),64,'0'), repeat('c',64),
      CASE WHEN n = 50 THEN 1 ELSE 200 END, 1, 'urn:receipt:other-account:other-zone'
      FROM generate_series(1,50) AS n`, [work.work]);
    await rejected(bundle, 'wiki_work_quotation_budget');
    // An identical already-applied quotation is reusable without charging it twice.
    await f.pool.query('DELETE FROM wiki.quotation WHERE work = $1', [work.work]);
    const use = extractionQuotationUses(bundle)[0]!;
    await f.pool.query(`INSERT INTO wiki.quotation(work,representation_sha256,locator_digest,quote_digest,
      code_points,policy_version,applied_receipt) VALUES ($1,$2,$3,$4,$5,1,'urn:receipt:other-account')`,
    [work.work, use.representationSha256, use.locatorDigest, use.quoteDigest, use.codePoints]);
    expect(await json(await validate(bundle))).toMatchObject({ quotations: { appliedCodePoints: 200, addedCodePoints: 0 } });
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [elizabeth.grant]);
    await rejected(bundle, 'resource_unavailable', 404);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
