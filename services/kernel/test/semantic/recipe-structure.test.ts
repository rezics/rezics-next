import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { documentVersion, normalizeDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { readAuthoredField } from '../../src/content/authored-fields.ts';
import { readImportedField } from '../../src/content/imported-fields.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const actions = ['subject:create', 'subject:read', 'statement:propose', 'subject:batch_write'];
const access = await createRealAccess(admin, { editor: newId(0x5100) }, actions);
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: createWriteRateLimiter({
    secret: 'semantic-recipe-structure-test-secret',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 100, seconds: 60 } } }),
  }),
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(31)]]) },
  routeKey: new Uint8Array(32).fill(32),
});
const projection = linkProjection(pool);
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value' as const, content } });
const references = [{ parts: [snak('schema:url', 'https://example.org/stew')] }];
const typedSnak = (part: ReturnType<typeof snak>) => ({
  ...part,
  property: { ...part.property, data_type: bundledRelease.properties[part.property.id]!.datatype },
});
const typedStatement = (entry: ReturnType<typeof statement>) => ({
  ...typedSnak(entry),
  qualifiers: entry.qualifiers.map(typedSnak),
  references: entry.references.map(({ parts }) => ({
    parts: parts.map(typedSnak),
    hash: createHash('sha256')
      .update(canonicalize(parts.map((part) => ({ property: part.property.id, value: part.value })))!)
      .digest('hex'),
  })),
});
const statement = (id: string, content: unknown, qualifiers: ReturnType<typeof snak>[] = []) => ({
  ...snak(id, content),
  qualifiers,
  references,
});
async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        'idempotency-key': `"${randomUUID()}"`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function create(type: string, name: string, statements = {}) {
  const answer = await call('POST', '/v1/subjects', { type, labels: { en: name }, statements });
  expect(answer.status).toBe(201);
  return answer.body.subject;
}
async function catchUp(subject: string) {
  for (let step = 0; step < 100; step++) {
    const result = await projection.run(partitionOf(routeOf(subject)!));
    if (result.status !== 'busy' && result.envelopes === 0) return;
  }
  throw new Error('Link projection did not catch up');
}

let recipe: any;
let ingredients: ReturnType<typeof statement>[];
beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function structuredRecipe() {
  if (recipe) return recipe;
  const targets = [];
  for (let index = 0; index < 40; index++) {
    targets.push(await create(index === 39 ? 'schema:Recipe' : 'wd:Q2095', `Ingredient ${index}`));
  }
  ingredients = targets.map((target, index) =>
    statement('wdt:P186', target.id, [
      snak('schema:position', String(index + 1)),
      snak('wdt:P1114', {
        amount: index === 0 ? '+0.125' : index === 1 ? '+1.5' : '+2',
        unit: index % 2 ? '1' : 'http://www.wikidata.org/entity/Q41803',
        ...(index === 2 ? { lowerBound: '+2', upperBound: '+3' } : {}),
      }),
      snak('rezics:note', { language: 'en', text: `Preparation ${index}` }),
      snak('rezics:listSection', { language: 'en', text: ['For the base', 'For the sauce', 'To finish'][index % 3] }),
    ]),
  );
  recipe = await create('schema:Recipe', 'Stew', {
    'wdt:P186': [...ingredients].reverse(),
    'schema:recipeYield': [statement('schema:recipeYield', { amount: '+4', unit: '1' })],
    'schema:recipeIngredient': [statement('schema:recipeIngredient', { language: 'en', text: 'Source wording' })],
  });
  await catchUp(recipe.id);
  return recipe;
}

test("a recipe's ingredients are ordered statements with exact quantities, units, notes and sections", async () => {
  const subject = await structuredRecipe();
  const page = await call('GET', `/v1/subjects/${subject.id}/relations?property=wdt%3AP186&limit=100`);
  expect(page.status).toBe(200);
  expect(
    page.body.relations.map((entry: any) => ({
      property: entry.statement.property,
      value: entry.statement.value,
      qualifiers: entry.statement.qualifiers,
      references: entry.statement.references,
    })),
  ).toEqual(ingredients.map(typedStatement));
  expect(page.body.next).toBeNull();
  expect(subject.statements['schema:recipeYield'][0].value.content).toEqual({ amount: '+4', unit: '1' });
});

test('an ingredient without a subject keeps its wording', async () => {
  const qualifiers = [snak('wdt:P1932', 'Salt to taste'), snak('schema:position', '1')];
  const subject = await create('schema:Recipe', 'Unresolved recipe', {
    'wdt:P186': [{ property: { id: 'wdt:P186' }, value: { type: 'somevalue' }, qualifiers, references }],
  });
  await catchUp(subject.id);
  const read = await call('GET', `/v1/subjects/${subject.id}/candidates?property=wdt%3AP186`);
  expect(read.status).toBe(200);
  expect(read.body.candidates).toHaveLength(1);
  expect(read.body.candidates[0].statement.value).toEqual({ type: 'somevalue' });
  expect(read.body.candidates[0].statement.qualifiers).toEqual(qualifiers.map(typedSnak));
  const external = 'http://www.wikidata.org/entity/Q11254';
  const proposed = await call('POST', `/v1/subjects/${subject.id}/candidates`, {
    statement: {
      property: { id: 'wdt:P186' },
      value: { type: 'somevalue' },
      qualifiers: [...qualifiers, snak('schema:sameAs', external)],
      references,
    },
  });
  expect(proposed.status).toBe(201);
  const separate = await call(
    'GET',
    `/v1/subjects/${subject.id}/candidates?property=wdt%3AP186&sameAs=${encodeURIComponent(external)}`,
  );
  expect(separate.body.candidates).toHaveLength(1);
  expect(separate.body.candidates[0].id).toBe(proposed.body.candidate);
});

test("a recipe holds more ingredients than one slot's selection limit", async () => {
  const subject = await structuredRecipe();
  const read = await call('GET', `/v1/subjects/${subject.id}`);
  expect(read.status).toBe(200);
  expect(read.body.subject.relationCounts).toEqual({});
  expect(read.body.subject.statements['wdt:P186']).toHaveLength(12);
  const page = await call('GET', `/v1/subjects/${subject.id}/relations?property=wdt%3AP186&limit=100`);
  expect(page.body).not.toHaveProperty('count');
  expect(new Set(page.body.relations.map((entry: any) => entry.target)).size).toBe(40);
});

const instructions: DocumentSnapshot = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { id: 'steps', start: 1 },
        content: [
          {
            type: 'listItem',
            attrs: { id: 'step-1' },
            content: [
              { type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: 'Chop the vegetables.' }] },
            ],
          },
          {
            type: 'listItem',
            attrs: { id: 'step-2' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'p2' },
                content: [
                  { type: 'text', text: 'Simmer for ' },
                  {
                    type: 'extensionInline',
                    attrs: {
                      id: 'duration',
                      definition: 'http://schema.org/timeRequired',
                      version: '1',
                      payload: 'PT30M',
                      fallback: '30 minutes',
                    },
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            attrs: { id: 'step-3' },
            content: [
              { type: 'paragraph', attrs: { id: 'p3' }, content: [{ type: 'text', text: 'Serve.' }] },
              {
                type: 'extensionBlock',
                attrs: {
                  id: 'tip',
                  definition: 'http://schema.org/HowToTip',
                  version: '1',
                  payload: {},
                  fallback: 'Warm the bowls first.',
                },
              },
            ],
          },
        ],
      },
    ],
  },
});

test("a recipe's instructions are a document whose ordered steps carry an optional duration and tip", async () => {
  const subject = await create('schema:Recipe', 'Imported stew');
  const imported = await call('POST', '/v1/subjects:batchWrite', {
    commands: [
      {
        op: 'propose',
        key: randomUUID(),
        subject: subject.id,
        source: {
          source: 'example',
          external_id: subject.id,
          record_revision: '1',
          digest: 'a'.repeat(64),
          converter_revision: 'example@1',
          field_group: 'summary',
        },
        rights: { license: 'CC-BY-4.0', obligations: ['cc:Attribution'], attribution: 'Recipe author' },
        statement: statement('schema:recipeInstructions', { document: instructions, language: 'en' }),
      },
    ],
  });
  expect(imported.status).toBe(200);
  expect(imported.body.results[0].status).toBe(201);
  const read = await call('GET', `/v1/subjects/${subject.id}/candidates?property=schema:recipeInstructions`);
  expect(read.status).toBe(200);
  const reference = read.body.candidates[0].statement.value.content;
  expect(reference).toEqual({
    language: 'en',
    document: expect.any(String),
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const stored = await readImportedField(pool, reference.document);
  expect(stored?.body?.toString()).toBe(serializeDocument(instructions));
  expect(stored?.digest).toBe(reference.digest);
  const authored = await create('schema:Recipe', 'Authored stew', {
    'schema:recipeInstructions': [
      statement('schema:recipeInstructions', { document: instructions, licence: 'CC-BY-4.0', language: 'en' }),
    ],
  });
  const authoredReference = authored.statements['schema:recipeInstructions'][0].value.content;
  const authoredStored = await readAuthoredField(pool, routeOf(authored.id)!, authoredReference.document);
  expect(authoredStored?.body?.toString()).toBe(serializeDocument(instructions));
  expect(authoredStored?.digest).toBe(reference.digest);
});
