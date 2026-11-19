import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('../../../contracts/openapi.json', import.meta.url), 'utf8'));
const inventory = contract.paths['/v1/accounts/{accountId}/watches'].get;
const schema = inventory.responses['200'].content['application/json'].schema;

test('published watch pages distinguish available kinds and retain only personal removal metadata when unavailable', () => {
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required.slice().sort()).toEqual(['actions', 'items', 'next', 'viewer']);
  expect(schema.properties.items.maxItems).toBe(20);
  expect(schema.properties.next.maxLength).toBe(4096);
  expect(schema.properties.viewer.required.slice().sort()).toEqual(['accountId', 'state']);
  expect(schema.properties.actions.required).toEqual(['remove']);
  const variants = schema.properties.items.items.anyOf;
  expect(
    variants.map((row: any) => [row.properties.state.const, row.properties.kind.const ?? row.properties.kind.enum]),
  ).toEqual([
    ['available', 'thread'],
    ['available', 'board'],
    ['unavailable', ['thread', 'board']],
  ]);
  for (const row of variants) expect(row.additionalProperties).toBe(false);
  expect(Object.keys(variants[2].properties).sort()).toEqual([
    'command',
    'createdAt',
    'id',
    'kind',
    'revision',
    'state',
  ]);
  expect(variants[2].required.slice().sort()).toEqual(['command', 'createdAt', 'id', 'kind', 'revision', 'state']);
  for (const row of variants.slice(0, 2))
    expect(row.required).toEqual(expect.arrayContaining(['resourceId', 'title', 'place', 'command']));
});

test('published watch selection, removal and board CAS inputs remain explicit', () => {
  const selection = inventory.parameters.find((parameter: any) => parameter.name === 'kind');
  expect(selection).toMatchObject({ in: 'query', required: true, schema: { enum: ['thread', 'board'] } });
  const removal = contract.paths['/v1/accounts/{accountId}/watches/{watchId}'].delete;
  expect(removal.requestBody.content['application/json'].schema).toMatchObject({
    additionalProperties: false,
    required: ['expectedRevision'],
  });
  const board = contract.paths['/v1/boards/{id}/watch'];
  expect(board.get.responses['200'].content['application/json'].schema.required).toEqual(['watching', 'revision']);
  expect(board.put.requestBody.content['application/json'].schema).toMatchObject({
    additionalProperties: false,
    required: ['watching', 'expectedRevision'],
  });
});
