import { beforeAll, expect, test } from 'bun:test';
import { Compile, type XSchema } from 'typebox/schema';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { feedVoteResult } from '../../../services/main/src/modules/feed/contract.ts';
import { ratingContextsPage } from '../../../services/main/src/modules/rating/contexts.ts';
import { AnswerRecordValidator, answerPersonas, answerRecord,
  type AnswerContract, type AnswerRecord, type AnswerSample } from '../../../scripts/api/answer-record.ts';
import { buildMainOpenApi, jsonSchema2020Tuples } from '../../../scripts/api/generate.ts';

type Schema = Record<string, unknown>;
const payloadKeys = new Set(['const', 'enum', 'default', 'example', 'examples']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const methods = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
const uuid = '00000000-0000-4000-8000-000000000001';
const id = `https://rezics.com/id/${uuid}`;
let contract: AnswerContract;
let validator: AnswerRecordValidator;
beforeAll(async () => {
  contract = JSON.parse(await buildMainOpenApi()) as AnswerContract;
  validator = new AnswerRecordValidator(contract);
}, 60_000);

function dereference(value: unknown): unknown {
  const seen = new Set<string>();
  while (value && typeof value === 'object' && '$ref' in value) {
    const reference = String(value.$ref);
    if (!reference.startsWith('#/')) throw new Error(`Non-local contract reference: ${reference}`);
    if (seen.has(reference)) throw new Error(`Cyclic contract reference chain: ${reference}`);
    seen.add(reference);
    let result: unknown = contract;
    for (const key of reference.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      result = (result as Schema)[key];
    }
    if (result === undefined) throw new Error(`Unresolved contract reference: ${reference}`);
    value = result;
  }
  return value;
}

function walk(value: unknown, visit: (schema: Schema, path: string) => void,
  path = '', ancestors = new Set<unknown>()) {
  const resolved = dereference(value);
  if (!resolved || typeof resolved !== 'object' || ancestors.has(resolved)) return;
  const next = new Set(ancestors).add(resolved);
  if (Array.isArray(resolved)) resolved.forEach((item, index) => walk(item, visit, `${path}/${index}`, next));
  else {
    visit(resolved as Schema, path);
    for (const [key, item] of Object.entries(resolved)) {
      if (schemaMaps.has(key) && item && typeof item === 'object') {
        for (const [name, child] of Object.entries(item)) walk(child, visit, `${path}/${key}/${name}`, next);
      } else if (!payloadKeys.has(key)) walk(item, visit, `${path}/${key}`, next);
    }
  }
}

function publishedAt(authority: unknown, published: unknown, pointer: string): Schema {
  const keys = pointer.split('/').slice(1);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    const authored = authority as Schema;
    const projected = dereference(published) as Schema;
    // OpenAPI 3.1 expresses a nullable object as a type array with its properties
    // on the object, whereas Elysia authors an anyOf with a separate null branch.
    if (key === 'anyOf' && projected.anyOf === undefined && Array.isArray(authored.anyOf)
      && authored.anyOf.length === 2 && authored.anyOf.some(member => (member as Schema).type === 'null')) {
      authority = authored.anyOf[Number(keys[++index])];
      expect((authority as Schema).type).not.toBe('null');
      continue;
    }
    authority = authored[key];
    published = projected[key === 'items' && Array.isArray(authority) ? 'prefixItems' : key];
    if (published === undefined) throw new Error(`Published schema missing at ${pointer} (${key})`);
  }
  return dereference(published) as Schema;
}

test('every published response primitive agrees with its const and enum members, including local references', () => {
  const contradictions: string[] = [];
  let literals = 0;
  for (const [path, operations] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!methods.has(method)) continue;
      const responses = (operation as { responses: Record<string, unknown> }).responses;
      for (const [status, response] of Object.entries(responses)) {
        walk(response, (schema, pointer) => {
          const values = [...(Object.hasOwn(schema, 'const') ? [schema.const] : []),
            ...(Array.isArray(schema.enum) ? schema.enum : [])];
          const types = Array.isArray(schema.type) ? schema.type : [schema.type];
          for (const value of values) {
            if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) continue;
            literals++;
            if (schema.type === undefined) continue;
            const type = value === null ? 'null' : typeof value;
            if (!types.includes(type) && !(type === 'number' && Number.isInteger(value) && types.includes('integer'))) {
              contradictions.push(`${method} ${path} ${status}${pointer}: ${JSON.stringify(value)} vs ${JSON.stringify(schema.type)}`);
            }
          }
        });
      }
    }
  }
  expect(literals).toBeGreaterThan(83);
  expect(contradictions).toEqual([]);
});

test('installed Main numeric literal unions retain their authoritative sets at every response location', () => {
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'),
    { mcp: { issuer: 'https://account.rezics.test', resource: 'https://rezics.test/mcp' } } as MainWorkDependencies);
  const locations: string[] = [];
  const operations = new Set<string>();
  let literalMembers = 0;
  for (const route of app.routes) {
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const method = route.method.toLowerCase();
    if (!methods.has(method) || !contract.paths[path]) continue;
    const operation = contract.paths[path]![method] as { responses: Record<string, { content?: Record<string, { schema: unknown }> }> };
    for (const [status, authority] of Object.entries(route.hooks.response ?? {})) {
      walk(authority, (schema, pointer) => {
        const members = schema.anyOf as Schema[] | undefined;
        if (!Array.isArray(members) || !members.length || !members.every(member => typeof member.const === 'number')) return;
        const expected = members.map(member => member.const);
        const content = operation.responses[status]?.content;
        const generated = publishedAt(authority, Object.values(content ?? {})[0]?.schema, pointer);
        const location = `${method} ${path} ${status}${pointer}`;
        locations.push(location);
        operations.add(`${method} ${path}`);
        literalMembers += expected.length;
        expect(generated.enum, location).toEqual(expected);
        const authored = Compile(schema as XSchema);
        const published = Compile(generated as XSchema);
        for (const value of [...expected, ...expected.map(String), -2, 0.5, 26, null, true]) {
          expect(published.Check(value), `${location}: ${JSON.stringify(value)}`).toBe(authored.Check(value));
        }
      });
    }
  }
  expect(locations).toHaveLength(36);
  expect(literalMembers).toBe(83);
  expect(operations.size).toBe(18);
});

function record(method: string, path: string, answer: unknown, body?: unknown): AnswerRecord {
  const sample: AnswerSample = { label: 'primitive-contract-input', method, path,
    operationId: validator.operationId(method, path), status: 200, answer,
    ...(body === undefined ? {} : { body }),
    headers: { 'content-type': 'application/json' } };
  // Unit inputs exercise the recorded-answer reader; they are never published as outcome evidence.
  return answerRecord('zone/attached-realm-discussion',
    Object.fromEntries(answerPersonas.map(persona => [persona, [sample]])) as AnswerRecord['personas']);
}

test('recorded feed vote answers retain numeric values and reject strings and out-of-set values', () => {
  const authored = Compile(feedVoteResult);
  for (const value of [-1, 0, 1, '-1', '0', '1', -2, 2, 0.5, null, true]) {
    const answer = { profile: 'feed-vote-receipt-v1', target: id, value, revision: uuid, score: 0, replayed: false };
    const input = record('POST', `/v1/feed/${uuid}/vote`, answer,
      { profile: 'feed-vote-command-v1', actingSubject: id, value: 0, expectedRevision: null });
    if (authored.Check(answer)) expect(validator.validate(input)).toEqual(input);
    else expect(() => validator.validate(input)).toThrow('/answer/value');
  }
});

test('recorded rating contexts retain numeric scale maxima and reject every other primitive value', () => {
  const authored = Compile(ratingContextsPage);
  for (const max of [5, 10, '5', '10', 0, 6, 5.5, null, true]) {
    const answer = { profile: 'standing-rating-contexts-v1', scope: { kind: 'global', realm: null },
      items: [{ context: id, revision: id, question: 'Overall quality', language: 'en',
        displayQuestion: { value: 'Overall quality', language: 'en', direction: 'ltr', basis: 'requested',
          script: null, reviewStatus: 'authored', presentation: null, source: null, licence: null, fallback: null },
        targetGrain: 'main-version', cadence: 'standing', scale: { min: 1, max, step: 1 } }],
      nextCursor: null, sourcePosition: { dataEpoch: 'fixture', sequence: '1' },
      count: { value: 1, kind: 'exact-page', total: null } };
    const input = record('GET', '/v1/rating-contexts', answer);
    if (typeof max === 'number' && [5, 10].includes(max)) {
      expect(authored.Check(answer)).toBe(true);
      expect(validator.validate(input)).toEqual(input);
    } else {
      expect(authored.Check(answer)).toBe(false);
      expect(() => validator.validate(input)).toThrow('/answer/items/0/scale/max');
    }
  }
});

test('recorded reader settings accept exactly the authoritative numeric font sizes', () => {
  for (const fontSize of [15, 17, 19, 22, 25, '15', '17', '19', '22', '25', 16, 26, 19.5, null, true]) {
    const input = record('GET', `/v1/reader/settings?actingSubject=${encodeURIComponent(id)}`, {
      profile: 'reader-settings-v1', fontSize, lineWidth: 'medium', typeface: 'serif', paragraphIndent: true,
      theme: 'system', cjkSpacing: 'auto', cjkPunctuation: 'standard', version: 0,
    });
    if ([15, 17, 19, 22, 25].includes(fontSize as number)) expect(validator.validate(input)).toEqual(input);
    else expect(() => validator.validate(input)).toThrow('/answer/fontSize');
  }
});

test('primitive projection preserves exact mixed and nullable constraints, references, tuples and literal payloads', () => {
  const payload = { type: 'string', enum: [1, true, null], items: [{ const: 7 }] };
  const input = { type: 'object', properties: {
    mixed: { type: 'string', enum: [1, 'one', true, null] },
    boolean: { type: 'string', enum: [true, false] },
    nil: { type: 'string', const: null },
    nullable: { type: 'string', const: 5, nullable: true },
    integer: { type: 'integer', enum: [1, 2] },
    enum: { type: 'string', enum: [5, 10] },
    intersection: { type: 'string', const: 5, enum: [5, 'five'] },
    reference: { $ref: '#/components/schemas/Value' },
    tuple: { type: 'array', items: [{ type: 'string', enum: [5, 10] }], additionalItems: false },
  }, default: payload, example: payload, examples: [payload], const: payload };
  const before = JSON.stringify(input);
  const output = jsonSchema2020Tuples(input) as Schema;
  expect(output).toEqual({ ...input, properties: {
    ...input.properties,
    mixed: { type: ['number', 'string', 'boolean', 'null'], enum: [1, 'one', true, null] },
    boolean: { type: 'boolean', enum: [true, false] },
    nil: { type: 'null', const: null },
    nullable: { type: ['number', 'null'], enum: [5, null], nullable: true },
    enum: { type: 'number', enum: [5, 10] },
    intersection: { type: ['number', 'string'], const: 5, enum: [5, 'five'] },
    tuple: { type: 'array', prefixItems: [{ type: 'number', enum: [5, 10] }], items: false },
  } });
  expect(JSON.stringify(input)).toBe(before);
});
