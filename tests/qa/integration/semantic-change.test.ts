import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { ACTIVE_GENERATION } from '../../../services/main/src/modules/semantic/command.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { SemanticStageStore } from '../../../services/main/src/modules/semantic/staging.ts';
import { readCurrentComponent } from '../../../services/main/src/modules/semantic/change.ts';

// Compare the complete response surface, including any future rate-limit headers.
const volatileHeaders = new Set(['date', 'request-id', 'x-request-id', 'trace-id', 'x-trace-id']);
const comparableHeaders = (response: Response) => Object.fromEntries(
  [...response.headers].filter(([name]) => !volatileHeaders.has(name)),
);

const RV = 'https://rezics.com/vocab/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
type Write = { component: string; revision: string; predecessor: string | null; receipt: string; replayed: boolean;
  sourcePosition: { sequence: string } };
type Read = { component: string; revision: string; predecessor: string | null; modelGeneration: string;
  state: { component: 'resource'; types: string[]; lifecycle: string;
    properties: { predicate: string; value: Record<string, unknown>; node?: string }[] };
  references: Record<string, { state: string }>; export: Record<string, unknown> };

/** Probe the submitted identity before its product command commits, then retain
 * the same identity as a hidden Resource. No graph deletion or reconstruction
 * can change the head, immutable values or receipt used by the later read. */
async function createAfterAbsentProbe(f: Awaited<ReturnType<typeof authorCreditFixture>>,
  create: () => Promise<Response>, probe: (component: string) => Promise<Response>) {
  const native = f.env.fuseki;
  let component: string | undefined;
  let absent: Response | undefined;
  let probeFailure: unknown;
  f.env.fuseki = new Proxy(native, { get(target, property) {
    if (property === 'commandWithReceipt') return async (
      envelope: Parameters<typeof target.commandWithReceipt>[0]) => {
      if (!component && envelope.update.includes('a rv:SemanticRevision, rv:RevisionAnchor ;')) {
        try {
          const components = new Set([...envelope.update.matchAll(/rv:component <(https:\/\/rezics\.com\/id\/[0-9a-f-]{36})>/g)]
            .map(match => match[1]!));
          expect(components.size).toBe(1);
          component = [...components][0]!;
          expect(await readCurrentComponent(f.env, component, 'resource')).toBeNull();
          absent = await probe(component);
        } catch (error) {
          probeFailure = error;
          throw error;
        }
      }
      return target.commandWithReceipt(envelope);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const response = await create();
    if (probeFailure) throw probeFailure;
    const created = await f.json<Write>(response, 201);
    expect(created.component).toBe(component!);
    expect(absent).toBeDefined();
    expect((await readCurrentComponent(f.env, created.component, 'resource'))?.head).toBe(created.revision);
    return { created, absent: absent! };
  } finally { f.env.fuseki = native; }
}

const values = {
  huge: { kind: 'integer', lexical: `${2n ** 256n}` },
  fraction: { kind: 'quantity', lexical: '1/3', value: { kind: 'rational', lexical: '1/3' },
    unit: 'http://qudt.org/vocab/unit/M' },
  mass: { kind: 'quantity', lexical: '1.50', value: { kind: 'decimal', lexical: '1.5' },
    unit: 'http://qudt.org/vocab/unit/KiloGM', uncertainty: { kind: 'decimal', lexical: '0.05' } },
  month: { kind: 'temporal', lexical: '2026-03', precision: 'month', calendar: 'gregorian' },
  instant: { kind: 'temporal', lexical: '2026-03-08T10:00+09:00', precision: 'minute', calendar: 'gregorian',
    timeZone: 'Asia/Tokyo' },
  arabic: { kind: 'language-string', lexical: 'مرحبا', language: 'ar', direction: 'rtl' },
  zero: { kind: 'integer', lexical: '0' },
} as const;

test('MODEL01/MODEL03/MODEL04/MODEL08/MODEL10/MODEL14: semantic change write, exact read, denial, stale and references', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `semantic-${randomUUID()}`));
  try {
    const change = (body: object, key = randomUUID(), token?: string) =>
      f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: f.actor, ...body }, key, token);
    const read = (resource: string, revision?: string, token?: string) => f.call('GET',
      `/v1/semantic/resources/${shortId(resource)}${revision ? `/revisions/${shortId(revision)}` : ''}?actingSubject=${encodeURIComponent(f.actor)}`,
      undefined, randomUUID(), token);
    const resource = (types: string[], properties: object[] = []) =>
      ({ expectedHead: null, state: { component: 'resource', types, properties } });

    // Denial: the create scope needs its own Access grant; the OAuth scope alone is not authority.
    const person = resource(['https://schema.org/Person', 'https://schema.org/Patient']);
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', ['semantic:create:root']);
    expect((await change(person, randomUUID(), f.account.noScope)).status).toBe(401);
    expect((await change(person)).status).toBe(403);
    await f.grant('semantic:create:root', 'semantic.change');

    // MODEL01: one identity with several semantic types; same key replays one receipt.
    const key = `semantic-${randomUUID()}`;
    const created = await f.json<Write>(await change(person, key), 201);
    expect(created).toMatchObject({ predecessor: null, replayed: false });
    const semanticEvent = await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?event a ?kind ; rv:receipt ${iri(created.receipt)} } }`);
    expect(semanticEvent.results?.bindings.map(row => row.kind!.value)).toEqual([`${RV}SemanticChangedEvent`]);
    const replay = await f.json<Write>(await change(person, key), 201);
    expect(replay).toMatchObject({ component: created.component, revision: created.revision, receipt: created.receipt,
      replayed: true });
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      <urn:rezics:model:product> a rv:ModelComponent ; rv:generationHead ${iri(ACTIVE_GENERATION)} } }`)).boolean)
      .toBe(true);
    expect((await change(resource(Array.from({ length: 33 }, (_, index) =>
      `https://example.org/vocab/Type${index}`)))).status).toBe(400);
    expect((await change(resource(['https://schema.org/Person'], Array.from({ length: 257 }, (_, index) =>
      ({ predicate: `https://example.org/vocab/property${index}`,
        value: { kind: 'integer', lexical: String(index) } }))))).status).toBe(422);
    expect((await change(resource(['https://schema.org/Person'], Array.from({ length: 65 }, (_, index) =>
      ({ predicate: `https://example.org/vocab/reference${index}`,
        value: { kind: 'external', provider: 'example', namespace: 'item', key: String(index) } }))))).status)
      .toBe(422);
    expect((await change(resource(['https://schema.org/Person']), key)).status).toBe(409);
    expect((await read(created.component)).status).toBe(404);
    await f.grant(`semantic:read:${created.component}`, 'semantic.read');
    const first = await f.json<Read>(await read(created.component), 200);
    expect(first).toMatchObject({ component: created.component, revision: created.revision, modelGeneration: ACTIVE_GENERATION,
      state: { types: ['https://schema.org/Patient', 'https://schema.org/Person'], lifecycle: 'active', properties: [] } });
    expect(first.export).toEqual({ '@id': created.component, '@type': ['https://schema.org/Patient', 'https://schema.org/Person'] });
    expect((await read(created.component, undefined, f.account.tokenB)).status).toBe(404);

    // Edits need the Resource's edit grant; types carry no authority (MODEL08).
    const edit = (expectedHead: string, types: string[], properties: object[] = []) =>
      ({ target: created.component, expectedHead, state: { component: 'resource', types, properties } });
    const privileged = ['https://schema.org/Person', 'https://schema.org/SoftwareApplication',
      'https://example.org/vocab/Administrator'];
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`semantic:edit:${created.component}`]);
    expect((await change(edit(created.revision, privileged))).status).toBe(403);
    await f.grant(`semantic:edit:${created.component}`, 'semantic.change');
    const grantsBefore = (await f.accessPool.query('SELECT id FROM access.permission_grant WHERE recipient_subject = $1',
      [f.actor])).rowCount;
    const typed = await f.json<Write>(await change(edit(created.revision, privileged)), 200);
    expect(typed).toMatchObject({ component: created.component, predecessor: created.revision, replayed: false });
    expect((await f.accessPool.query('SELECT id FROM access.permission_grant WHERE recipient_subject = $1',
      [f.actor])).rowCount).toBe(grantsBefore);
    expect((await f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: f.actor,
      ...resource(['https://schema.org/Thing']) }, randomUUID(), f.account.tokenB)).status).toBe(403);
    for (const [types, predicate, code] of [
      [['https://rezics.com/vocab/MainVersion'], undefined, 'reserved_owner'],
      [['https://schema.org/CreativeWork'], undefined, 'reserved_owner'],
      [['http://www.w3.org/2004/02/skos/core#Concept'], undefined, 'reserved_owner'],
      [['http://www.w3.org/2002/07/owl#Class'], undefined, 'schema_axiom'],
      [['http://www.w3.org/2002/07/owl#FunctionalProperty'], undefined, 'identity_axiom'],
      [['https://schema.org/Person'], 'http://www.w3.org/2002/07/owl#sameAs', 'identity_axiom'],
      [['https://schema.org/Person'], `${RV}scalarValue`, 'reserved_owner'],
    ] as const) {
      const properties = predicate ? [{ predicate, value: { kind: 'resource', ref: created.component } }] : [];
      const rejected = await change(edit(typed.revision, [...types], properties));
      expect(rejected.status).toBe(422);
      expect((await rejected.json() as { code: string }).code).toBe(code);
    }

    // MODEL14: an unrelated type and property join; the prior types survive and each revision stays exact.
    const properties = Object.entries(values).map(([name, value]) => ({ predicate: `https://example.org/vocab/${name}`, value }));
    const rich = await f.json<Write>(await change(edit(typed.revision,
      [...privileged, 'https://example.org/vocab/Unrelated'], properties)), 200);
    // The Resource envelope is open, but an unknown predicate on its owned revision is rejected by SHACL.
    const nativeFuseki = f.env.fuseki;
    let polluted = false;
    f.env.fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return async (
        envelope: Parameters<typeof target.commandWithReceipt>[0]) => {
        if (!polluted && envelope.update.includes('a rv:SemanticRevision, rv:RevisionAnchor ;')) {
          polluted = true;
          return target.commandWithReceipt({ ...envelope, update: envelope.update.replace(
            'a rv:SemanticRevision, rv:RevisionAnchor ;',
            'a rv:SemanticRevision, rv:RevisionAnchor ; <https://example.org/illegalAnchorField> "x" ;') });
        }
        return target.commandWithReceipt(envelope);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      expect((await change(edit(rich.revision, privileged))).status).toBe(400);
      expect(polluted).toBe(true);
    } finally { f.env.fuseki = nativeFuseki; }
    const current = await f.json<Read>(await read(created.component), 200);
    expect(current.revision).toBe(rich.revision);
    expect(current.state.types).toEqual([...privileged, 'https://example.org/vocab/Unrelated'].sort());
    expect(current.state.properties.map(item => item.value)).toEqual(expect.arrayContaining(Object.values(values)));
    expect(await f.json<Read>(await read(created.component, typed.revision), 200)).toMatchObject({
      revision: typed.revision, predecessor: created.revision, state: { types: [...privileged].sort(), properties: [] } });
    expect(await f.json<Read>(await read(created.component, created.revision), 200)).toMatchObject(
      { state: first.state, export: first.export });
    const typeRows = await f.env.fuseki.query(`SELECT ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.component)} a ?type } }`);
    expect(typeRows.results?.bindings.map(row => row.type!.value).sort())
      .toEqual(['http://www.w3.org/2000/01/rdf-schema#Resource', ...privileged, 'https://example.org/vocab/Unrelated'].sort());
    // The component revision anchor owns only anchor fields; values live in immutable nodes.
    const anchor = await f.env.fuseki.query(`SELECT DISTINCT ?p WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(rich.revision)} ?p ?o } }`);
    expect(anchor.results?.bindings.map(row => row.p!.value).filter(p => p.startsWith('https://example.org/'))).toEqual([]);

    // MODEL03/MODEL04: exact lexicals, precision, offset and direction survive graph storage and export.
    const term = async (name: string) => (await f.env.fuseki.query(`SELECT ?o WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(created.component)} <https://example.org/vocab/${name}> ?o } }`)).results?.bindings[0]?.o;
    expect(await term('huge')).toMatchObject({ type: 'literal', value: values.huge.lexical, datatype: `${XSD}integer` });
    expect(await term('zero')).toMatchObject({ type: 'literal', value: '0', datatype: `${XSD}integer` });
    const node = async (name: string) => {
      const iriValue = (await term(name))!.value;
      const rows = await f.env.fuseki.query(`SELECT ?p ?o WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(iriValue)} ?p ?o } }`);
      return Object.fromEntries((rows.results?.bindings ?? []).map(row => [row.p!.value.split(/[#/]/).at(-1), row.o!]));
    };
    const fraction = await node('fraction');
    expect(fraction.value).toMatchObject({ value: '1/3', datatype: 'http://www.w3.org/2002/07/owl#rational' });
    const mass = await node('mass');
    expect(mass.value).toMatchObject({ value: '1.5', datatype: `${XSD}decimal` });
    expect(mass.lexicalForm?.value).toBe('1.50');
    expect(mass.decimalPlaces?.value).toBe('2');
    expect(mass.uncertainty).toMatchObject({ value: '0.05', datatype: `${XSD}decimal` });
    const month = await node('month');
    expect(month.unitType?.value).toBe('http://www.w3.org/2006/time#unitMonth');
    expect(month.lexicalForm?.value).toBe('2026-03');
    expect(month.earliest).toBeUndefined();
    const instant = await node('instant');
    expect(instant).toMatchObject({ lexicalForm: { value: '2026-03-08T10:00+09:00' }, utcOffset: { value: '+09:00' },
      timeZoneName: { value: 'Asia/Tokyo' }, earliest: { value: '2026-03-08T01:00:00Z' } });
    expect(instant.latest?.value).toMatch(/^2026-03-08T01:00:59\.9+Z$/);
    expect(await node('arabic')).toMatchObject({ value: { value: 'مرحبا' }, language: { value: 'ar' },
      direction: { value: 'rtl' } });
    expect(current.export['https://example.org/vocab/huge']).toEqual([{ '@value': values.huge.lexical, '@type': `${XSD}integer` }]);
    expect(current.export['https://example.org/vocab/arabic']).toEqual([{ '@value': 'مرحبا', '@language': 'ar', '@direction': 'rtl' }]);
    expect(JSON.stringify(current)).not.toMatch(/"lexical":\d/);
    // An unchanged structured value keeps its immutable node; a changed one gets a fresh node.
    const moved = await f.json<Write>(await change(edit(rich.revision, [...privileged, 'https://example.org/vocab/Unrelated'],
      properties.map(item => item.predicate.endsWith('/month')
        ? { ...item, value: { ...values.month, lexical: '2026-04' } } : item))), 200);
    const after = await f.json<Read>(await read(created.component), 200);
    const nodeOf = (state: Read['state'], name: string) => state.properties.find(item => item.predicate.endsWith(`/${name}`))!.node;
    expect(nodeOf(after.state, 'mass')).toBe(nodeOf(current.state, 'mass')!);
    expect(nodeOf(after.state, 'month')).not.toBe(nodeOf(current.state, 'month')!);
    expect((await f.json<Read>(await read(created.component, rich.revision), 200)).state).toEqual(current.state);
    for (const bad of [{ kind: 'integer', lexical: 7 }, { kind: 'decimal', lexical: '1.50' },
      { kind: 'temporal', lexical: '2026-02-30', precision: 'day', calendar: 'gregorian' },
      { kind: 'temporal', lexical: '1447', precision: 'year', calendar: 'islamic' }]) {
      expect((await change(edit(moved.revision, privileged, [{ predicate: 'https://example.org/vocab/bad', value: bad }]))).status)
        .toBe(400);
    }

    // Stale: an old expected head records one terminal rejection for its key.
    const staleKey = randomUUID();
    const stale = await change(edit(rich.revision, privileged), staleKey);
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_head');
    expect((await change(edit(rich.revision, privileged), staleKey)).status).toBe(409);
    expect((await f.json<Read>(await read(created.component), 200)).revision).toBe(moved.revision);

    // MODEL10: private and missing targets are refused alike, before any admission or fabricated identity.
    const missing = nativeId();
    const admissions = async () => Number((await f.accessPool.query(
      "SELECT count(*) FROM access.admission WHERE action = 'semantic.change'")).rows[0]!.count);
    let before = 0;
    const { created: hidden, absent } = await createAfterAbsentProbe(f,
      () => change(resource(['https://schema.org/Person']), randomUUID()), async ref => {
        before = await admissions();
        return change(edit(moved.revision, privileged, [{ predicate: 'https://schema.org/knows',
          value: { kind: 'resource', ref } }]));
      });
    const refused = await Promise.all([hidden.component, missing].map(async ref => {
      const response = await change(edit(moved.revision, privileged, [{ predicate: 'https://schema.org/knows',
        value: { kind: 'resource', ref } }]));
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text), text, headers: comparableHeaders(response) };
    }));
    for (const [index, ref] of [hidden.component, missing].entries()) {
      expect(refused[index]!.status).toBe(422);
      expect(refused[index]!.body).toEqual({ type: 'https://rezics.com/problems/unavailable_reference',
        title: 'Semantic change is not admitted', status: 422, code: 'unavailable_reference',
        itemIndex: 0, pointer: '/properties/0/value/ref', reference: ref });
    }
    expect(absent.status).toBe(refused[0]!.status);
    expect(comparableHeaders(absent)).toEqual(refused[0]!.headers);
    expect(await absent.text()).toBe(refused[0]!.text);
    expect(await admissions()).toBe(before);
    expect(await readCurrentComponent(f.env, missing, 'resource')).toBeNull();
    const readGrant = await f.grant(`semantic:read:${hidden.component}`, 'semantic.read');
    const linked = await f.json<Write>(await change(edit(moved.revision, privileged, [
      { predicate: 'https://schema.org/knows', value: { kind: 'resource', ref: hidden.component } },
      { predicate: 'https://schema.org/sameAs', value: { kind: 'external', provider: 'wikidata', namespace: 'entity', key: 'Q42' } },
    ])), 200);
    expect((await f.json<Read>(await read(created.component), 200)).references)
      .toEqual({ [hidden.component]: { state: 'available' } });
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [readGrant]);
    const withdrawn = await f.json<Read>(await read(created.component), 200);
    expect(withdrawn.revision).toBe(linked.revision);
    expect(withdrawn.references).toEqual({});
    expect(withdrawn.state.properties.find(item => item.predicate === 'https://schema.org/knows')?.value)
      .toEqual({ kind: 'unavailable-reference' });
    expect(JSON.stringify(withdrawn)).not.toContain(hidden.component);
    expect(JSON.stringify(withdrawn)).not.toContain('schema.org/Person"]}');
    const externalRows = await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?node ?same WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(created.component)} <https://schema.org/sameAs> ?node }
      GRAPH ${iri(GRAPHS.revisions)} { ?node a rv:ExternalReference ; rv:externalKey "Q42" .
        OPTIONAL { ?node <http://www.w3.org/2002/07/owl#sameAs> ?same } } }`);
    expect(externalRows.results?.bindings).toHaveLength(1);
    expect(externalRows.results?.bindings[0]?.same).toBeUndefined();
    expect(externalRows.results?.bindings[0]?.node?.value).not.toMatch(/Q42/);

    // Exact history never substitutes the head: missing or corrupt bytes are unavailable.
    const manifest = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?m WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(typed.revision)} rv:manifest ?m } }`)).results?.bindings[0]?.m?.value!;
    const path = join(f.env.objectDirectory, manifest.slice(-64));
    const saved = readFileSync(path);
    renameSync(path, `${path}.held`);
    try { expect((await read(created.component, typed.revision)).status).toBe(503); }
    finally { renameSync(`${path}.held`, path); }
    writeFileSync(path, 'corrupt');
    try { expect((await read(created.component, typed.revision)).status).toBe(503); }
    finally { writeFileSync(path, saved); }
    expect((await read(created.component, typed.revision)).status).toBe(200);
    expect((await read(created.component, nativeId())).status).toBe(404);
  } finally { await f.close(); }
}, 180_000);

test('Bulk semantic reference refusals echo only the first submitted reference and preserve hidden/absent body and complete header equality', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `semantic-bulk-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/stage/' });
  try {
    await objects.initialize();
    const grant = (scope: string, action: string) => grantFixtureAuthority(f.accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId: f.principalId, actor: f.actor, action, lifetime: '8 hours' }],
      grant: { actor: f.actor, action, lifetime: '8 hours' },
    });
    await grant('semantic:create:root', 'semantic.change');
    await grant('semantic:create:root', 'semantic.change.bulk');
    const state = { component: 'resource', types: ['https://schema.org/Person'], properties: [] };
    const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
      access: f.access, semanticStages: new SemanticStageStore(f.pool, objects) });
    const second = nativeId();
    const bodyFor = (component: string) => ({ profile: 'semantic-change-bulk-v1', actingSubject: f.actor, items: [state, {
      ...state, properties: [
        { predicate: 'https://schema.org/knows', value: { kind: 'resource', ref: component } },
        { predicate: 'https://schema.org/about', value: { kind: 'resource', ref: second } },
      ],
    }] });
    const key = randomUUID();
    const bulk = (input: object, idempotencyKey = key) => app.handle(new Request('http://main.local/v1/semantic/changes/bulk', {
      method: 'POST', headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
        'idempotency-key': idempotencyKey }, body: JSON.stringify(input),
    }));
    const { created: hidden, absent } = await createAfterAbsentProbe(f,
      () => f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null, state }),
      component => bulk(bodyFor(component)));
    const body = bodyFor(hidden.component);
    const refused = await bulk(body);
    expect(refused.status).toBe(422);
    const hiddenHeaders = comparableHeaders(refused);
    const hiddenText = await refused.text();
    expect(JSON.parse(hiddenText)).toEqual({ type: 'https://rezics.com/problems/unavailable_reference',
      title: 'Semantic change is not admitted', status: 422, code: 'unavailable_reference',
      itemIndex: 1, pointer: '/properties/0/value/ref', reference: hidden.component });
    expect(absent.status).toBe(422);
    expect(comparableHeaders(absent)).toEqual(hiddenHeaders);
    expect(await absent.text()).toBe(hiddenText);
    expect((await f.accessPool.query('SELECT 1 FROM access.admission WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM semantic.change_stage WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
    await grant(`semantic:read:${hidden.component}`, 'semantic.read');
    const availableBody = { ...body, items: [state, { ...state, properties: [body.items[1]!.properties[0]!] }] };
    const availableKey = randomUUID();
    const accepted = await f.json<{ itemCount: number; items: { component: string; revision: string }[]; receipt: string }>(
      await bulk(availableBody, availableKey), 201);
    expect(accepted.itemCount).toBe(2);
    expect(accepted.items).toHaveLength(2);
    expect(await (await bulk(availableBody, availableKey)).json()).toMatchObject({
      itemCount: 2, items: accepted.items, receipt: accepted.receipt, replayed: true,
    });
  } finally { await f.close(); }
}, 180_000);
