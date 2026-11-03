import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('../../../contracts/openapi.json', import.meta.url), 'utf8'));
const inventory = contract.paths['/v1/accounts/{accountId}/watches'].get;
const schema = inventory.responses['200'].content['application/json'].schema;

test('published watch pages close both disclosure variants and retain only personal removal metadata when unavailable', () => {
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual(['items', 'next']);
  expect(schema.properties.items.maxItems).toBe(20);
  expect(schema.properties.next.maxLength).toBe(4096);
  const variants = schema.properties.items.items.anyOf;
  expect(variants.map((row: any) => row.properties.state.const)).toEqual(['available', 'unavailable']);
  for (const row of variants) expect(row.additionalProperties).toBe(false);
  expect(Object.keys(variants[1].properties).sort()).toEqual(['createdAt', 'id', 'kind', 'revision', 'state']);
  expect(variants[1].required.slice().sort()).toEqual(['createdAt', 'id', 'kind', 'revision', 'state']);
  expect(variants[0].properties.kind.enum).toEqual(['thread', 'board']);
  expect(variants[0].required).toContain('resourceId');
  expect(variants[0].required).toContain('title');
});

test('published watch selection, removal and board CAS inputs remain explicit', () => {
  const selection = inventory.parameters.find((parameter: any) => parameter.name === 'kind');
  expect(selection).toMatchObject({ in: 'query', required: true, schema: { enum: ['thread', 'board'] } });
  const removal = contract.paths['/v1/accounts/{accountId}/watches/{watchId}'].delete;
  expect(removal.requestBody.content['application/json'].schema).toMatchObject({
    additionalProperties: false, required: ['expectedRevision'],
  });
  const board = contract.paths['/v1/boards/{id}/watch'];
  expect(board.get.responses['200'].content['application/json'].schema.required).toEqual(['watching', 'revision']);
  expect(board.put.requestBody.content['application/json'].schema).toMatchObject({
    additionalProperties: false, required: ['watching', 'expectedRevision'],
  });
});
