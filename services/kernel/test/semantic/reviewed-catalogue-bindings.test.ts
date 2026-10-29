import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BatchCommand, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import type { HttpResponse, StatementInput } from '../../../../specs/semantic-driver.ts';
import pinned from '../../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json';
import type { Item } from '../../src/semantic/item.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let f: ReleasedDiscoveryFixture;
const schemeKey = 'https://rezics.com/schemes/bangumi/public-tags';
const qHarem = 'http://www.wikidata.org/entity/Q690342';
const qForm = 'http://www.wikidata.org/entity/Q747381';
const subjectURL = 'https://bgm.tv/subject/498';
const archiveURL = 'https://github.com/bangumi/Archive/releases/download/archive/dump-2026-10-20.210332Z.zip';
const fixturePath = new URL('../../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json', import.meta.url);

beforeAll(async () => {
  f = await createReleasedDiscoveryFixture();
  await f.grant('editor', ['subject:batch_write'], GLOBAL_CONTEXT);
  await f.grant('acceptor', ['subject:batch_write'], GLOBAL_CONTEXT);
}, 120_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body;
}
async function read(subject: CreatedSubject): Promise<Item> {
  return status(await f.read(subject), 200).subject as Item;
}
function values(item: Item, property: string) {
  return (item.statements[property] ?? []).map((s) => (s.value.type === 'value' ? s.value.content : s.value.type));
}
function statement(
  property: string,
  content: string,
  urls = [subjectURL, archiveURL],
): Omit<StatementInput, 'rank' | 'references'> & {
  rank: 'preferred';
  references: NonNullable<StatementInput['references']>;
} {
  return {
    property: { id: property },
    value: { type: 'value', content },
    rank: 'preferred',
    references: urls.map((url) => ({
      parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }],
    })),
  };
}
async function graph() {
  // Independent controlled graph, deliberately not the shared classification() or a reviewed producer.
  const scheme = await f.createSubject('skos:ConceptScheme', 'Public Bangumi tag scheme control');
  const source = await f.createSubject('skos:Concept', 'Source-scoped 后宫 control');
  const canonicalScheme = await f.createSubject('skos:ConceptScheme', 'Canonical media classification control');
  const canonical = await f.createSubject('skos:Concept', 'Canonical media-harem control');
  const schemeIdentity = await f.adopt(scheme, statement('schema:sameAs', schemeKey));
  const sourceMembership = await f.adopt(source, statement('skos:inScheme', scheme.id));
  const canonicalMembership = await f.adopt(canonical, statement('skos:inScheme', canonicalScheme.id));
  const canonicalIdentity = await f.adopt(
    canonical,
    statement('schema:sameAs', qHarem, ['https://www.wikidata.org/w/index.php?title=Q690342&oldid=2554335445']),
  );
  return {
    scheme,
    source,
    canonicalScheme,
    canonical,
    schemeIdentity,
    sourceMembership,
    canonicalMembership,
    canonicalIdentity,
  };
}

// This alias is isolated test configuration, NEVER a proposed production namespace or provider registration.
function testSource(external_id: string): Source {
  return {
    source: 'binding_mechanism_test',
    external_id,
    record_revision: 'unversioned',
    digest: createHash('sha256').update(readFileSync(fixturePath)).digest('hex'),
    converter_revision: 'controlled-native-binding-test',
    field_group: 'facts',
  };
}
async function batch(command: BatchCommand, persona: DiscoveryPersona = 'editor') {
  return f.request(persona, 'POST', '/v1/subjects:batchWrite', { commands: [command] });
}
function created(response: HttpResponse, expected: number) {
  const body = status(response, 200) as BatchWriteResult;
  const result = body.results[0]!;
  expect(result.status, JSON.stringify(result)).toBe(expected);
  if (!('value' in result) || !('id' in result.value)) throw new Error('Actual create-or-resolve ID required');
  return result.value;
}

test('reviewed public tag and form bindings require actual native Concept scheme and accepted correspondence receipts with same claim replay', async () => {
  // Claim mechanism proof only: the operational vocabulary namespace still needs coowner review.
  const source = testSource(`controlled-claim/${randomUUID()}`);
  const command: BatchCommand = {
    op: 'create',
    key: randomUUID(),
    source,
    subject: { type: 'skos:Concept', labels: { en: 'Claim-backed source category control' } },
  };
  const first = created(await batch(command), 201);
  const replay = created(await batch({ ...command, key: randomUUID() }), 200);
  const otherActor = created(await batch({ ...command, key: randomUUID() }, 'acceptor'), 200);
  expect(replay).toEqual(first);
  expect(otherActor).toEqual(first);
  const durable = await f.inspect<{ subject_id: string }>(
    'SELECT subject_id FROM semantic.external_claim WHERE route = $1 AND source = $2 AND external_id = $3',
    [routeOf(first.id), source.source, source.external_id],
  );
  expect(durable.rows).toEqual([{ subject_id: first.id }]);
  const actual = status(await f.request('anonymous', 'GET', `/v1/subjects/${first.id}`), 200).subject as Item;
  expect(actual.type).toBe('skos:Concept');
  expect(actual.release).toBe(f.release.digest);
  const scheme = await f.createSubject('skos:ConceptScheme', 'Claim-backed scheme membership control');
  const holder = { id: first.id, revision: first.revision, release: actual.release };
  const membership = await f.adopt(holder, statement('skos:inScheme', scheme.id));
  expect(membership).toMatchObject({
    subject: first.id,
    candidate: expect.any(String),
    release: actual.release,
    acceptanceHead: expect.any(Number),
    adoptionHead: expect.any(Number),
    revision: expect.any(Number),
  });
  expect(values(await read(holder), 'skos:inScheme')).toEqual([scheme.id]);
  const canonical = await f.createSubject('skos:Concept', 'Separate canonical harem control');
  const canonicalPin = 'https://www.wikidata.org/w/index.php?title=Q690342&oldid=2554335445';
  await f.adopt(canonical, statement('schema:sameAs', qHarem, [canonicalPin]));
  expect(canonical.id).not.toBe(first.id);
  // Required standard native edge: expected proposal 201, acceptance/adoption 200, then public read.
  // Current bundled release lacks skos:closeMatch. Never accept its 400/422 as a producer pass.
  const correspondence = await f.adopt(
    holder,
    statement('skos:closeMatch', canonical.id, [subjectURL, archiveURL, canonicalPin]),
  );
  expect(correspondence.candidate).toBeString();
  expect(values(await read(holder), 'skos:closeMatch')).toEqual([canonical.id]);
  expect(values(await read(holder), 'schema:sameAs')).not.toContain(qHarem);
}, 120_000);

test('Bangumi exact public meta_tags harem is source scoped and never exact canonical harem or inferred light novel', async () => {
  expect(pinned).toEqual({
    id: 498,
    type: 1,
    name: 'BASTARD!! -暗黒の破壊神-',
    meta_tags: ['日本', '后宫', '漫画', '战斗', '少年', '奇幻', '原创', '系列'],
  });
  expect(createHash('sha256').update(readFileSync(fixturePath)).digest('hex')).toBe(
    '3b8382649610aa4c783cea2ffff319ccd0d80aad10f3147152d98a3c131debf5',
  );
  expect(Object.keys(pinned).sort()).toEqual(['id', 'meta_tags', 'name', 'type']);
  const g = await graph();
  const book = await f.createSubject('schema:Book', 'Observed type-1 manga row controlled assertion');
  const adopted = await f.adopt(book, statement('schema:keywords', g.source.id));
  const actual = await read(book);
  expect(values(actual, 'schema:keywords')).toEqual([g.source.id]);
  expect(values(actual, 'schema:keywords')).not.toContain(g.canonical.id);
  expect(values(actual, 'wdt:P7937')).toEqual([]);
  expect(values(actual, 'schema:wordCount')).toEqual([]);
  expect(values(await read(g.scheme), 'schema:sameAs')).toEqual([schemeKey]);
  expect(values(await read(g.source), 'skos:inScheme')).toEqual([g.scheme.id]);
  expect(values(await read(g.source), 'schema:sameAs')).toEqual([]);
  expect(values(await read(g.canonical), 'schema:sameAs')).toEqual([qHarem]);
  expect(g.source.id).not.toBe(g.canonical.id);
  const fact = actual.statements['schema:keywords']![0]!;
  expect(fact.id).toBe(adopted.candidate);
  expect(fact.rezics.release).toBe(f.release.digest);
  expect(fact.references.map((r) => r.parts[0]!.value)).toEqual([
    { type: 'value', content: subjectURL },
    { type: 'value', content: archiveURL },
  ]);
  // No source date, native revision, word measurement, edition or form is supplied by this projection.
}, 120_000);

test('independent native work-form and diet graph controls retain exact reviewed external meanings and real receipts', async () => {
  const scheme = await f.createSubject('skos:ConceptScheme', 'Reviewed meaning mechanism control');
  for (const [meaning, property, holderType, citation] of [
    [qForm, 'wdt:P7937', 'schema:Book', 'https://www.wikidata.org/w/index.php?title=Q747381&oldid=2548853139'],
    [
      'https://schema.org/VegetarianDiet',
      'schema:suitableForDiet',
      'schema:Recipe',
      'https://schema.org/VegetarianDiet',
    ],
  ] as const) {
    const concept = await f.createSubject('skos:Concept', `Meaning control ${meaning}`);
    const member = await f.adopt(concept, statement('skos:inScheme', scheme.id, [citation]));
    const identity = await f.adopt(concept, statement('schema:sameAs', meaning, [citation]));
    const holder = await f.createSubject(holderType, 'Independent explicit cited classification');
    const binding = await f.adopt(holder, statement(property, concept.id, [citation]));
    expect(values(await read(concept), 'skos:inScheme')).toEqual([scheme.id]);
    expect(values(await read(concept), 'schema:sameAs')).toEqual([meaning]);
    expect(values(await read(holder), property)).toEqual([concept.id]);
    for (const receipt of [member, identity, binding]) {
      expect(receipt.acceptanceHead).toBeGreaterThan(0);
      expect(receipt.adoptionHead).toBeGreaterThan(0);
      expect(receipt.release).toBe(f.release.digest);
    }
    expect(concept.id).not.toBe(meaning);
  }
  expect(f.release.definition.properties['wdt:P7937']!.mappings).toContain('http://www.wikidata.org/entity/P7937');
}, 120_000);

test('unselected and hidden correspondence cannot be disclosed as current reviewed binding evidence', async () => {
  const holder = await f.createSubject('skos:Concept', 'Current correspondence control');
  const proposed = status(
    await f.request(
      'editor',
      'POST',
      `/v1/subjects/${holder.id}/candidates`,
      {
        statement: statement('schema:sameAs', qForm),
      },
      discoveryKey(),
    ),
    201,
  );
  expect(values(await read(holder), 'schema:sameAs')).toEqual([]);
  status(
    await f.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}/candidates/${proposed.candidate}:accept`,
      {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      },
      discoveryKey(),
    ),
    200,
  );
  expect(values(await read(holder), 'schema:sameAs')).toEqual([]);
  status(
    await f.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}:adopt`,
      {
        context: GLOBAL_CONTEXT,
        property: 'schema:sameAs',
        mode: 'replace',
        selection: [{ candidate: proposed.candidate, rank: 'preferred' }],
        expected_head: null,
      },
      discoveryKey(),
    ),
    200,
  );
  expect(values(await read(holder), 'schema:sameAs')).toEqual([qForm]);
  await f.grant('steward', ['moderation:hide'], GLOBAL_CONTEXT);
  status(
    await f.request(
      'steward',
      'POST',
      `/v1/subjects/${holder.id}/candidates/${proposed.candidate}:hide`,
      {
        reason: 'Current correspondence disclosure control',
      },
      discoveryKey(),
    ),
    200,
  );
  expect(values(await read(holder), 'schema:sameAs')).toEqual([]);
}, 120_000);

test('native claim replay checks current authority before returning an existing binding', async () => {
  const command: BatchCommand = {
    op: 'create',
    key: randomUUID(),
    source: testSource(`authority/${randomUUID()}`),
    subject: { type: 'skos:Concept', labels: { en: 'Replay authority control' } },
  };
  created(await batch(command), 201);
  // Ordinary standing editorial grants do not include trusted batch authority.
  const denied = status(await batch(command, 'outsider'), 403);
  expect(denied.effect_status).toBe('not_applied');
  const revoked = await batch(command, 'suspended');
  status(revoked, 401);
  expect(created(await batch({ ...command, key: randomUUID() }), 200).id).toBeString();
}, 120_000);

test('retracted claim-backed correspondence is absent from current public binding evidence', async () => {
  const holder = await f.createSubject('skos:Concept', 'Terminal correspondence control');
  const source = testSource(`retraction/${randomUUID()}`);
  const proposal: BatchCommand = {
    op: 'propose',
    key: randomUUID(),
    source,
    subject: holder.id,
    statement: statement('schema:sameAs', qForm),
  };
  const result = (status(await batch(proposal), 200) as BatchWriteResult).results[0]!;
  expect(result.status, JSON.stringify(result)).toBe(201);
  if (!('value' in result) || !('candidate' in result.value)) throw new Error('Native proposal receipt required');
  const candidate = result.value.candidate;
  status(
    await f.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}/candidates/${candidate}:accept`,
      {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      },
      discoveryKey(),
    ),
    200,
  );
  status(
    await f.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}:adopt`,
      {
        context: GLOBAL_CONTEXT,
        property: 'schema:sameAs',
        mode: 'replace',
        selection: [{ candidate, rank: 'preferred' }],
        expected_head: null,
      },
      discoveryKey(),
    ),
    200,
  );
  expect(values(await read(holder), 'schema:sameAs')).toEqual([qForm]);
  const retraction: BatchCommand = {
    op: 'retract',
    key: randomUUID(),
    source,
    subject: holder.id,
    candidate,
    references: proposal.statement.references,
  };
  const retracted = (status(await batch(retraction), 200) as BatchWriteResult).results[0]!;
  expect(retracted.status, JSON.stringify(retracted)).toBe(200);
  expect(values(await read(holder), 'schema:sameAs')).toEqual([]);
}, 120_000);

test('first-party vocabulary seeding requires a native source metadata ACK before any external claim bootstrap', async () => {
  const source = testSource(`metadata/${randomUUID()}`);
  // Only the existing metadata contract is exercised. No registration option, fabricated ACK or bootstrap fallback.
  const response = await f.request(
    'editor',
    'POST',
    '/v1/source-records:setMetadata',
    {
      source: source.source,
      external_id: source.external_id,
      metadata: { name: 'Controlled native vocabulary evidence', url: schemeKey },
      expected_metadata_revision: null,
    },
    discoveryKey(),
  );
  status(response, 201);
  expect(response.body).toMatchObject({ metadata_revision: 1, effect: 'filled' });
}, 120_000);
