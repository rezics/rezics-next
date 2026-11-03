import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const contract = JSON.parse(
  readFileSync(new URL('../../../../contracts/openapi.json', import.meta.url), 'utf8'),
);

test('Subject thread OpenAPI exposes the closed contextual card envelope', () => {
  const operation = contract.paths['/v1/subjects/{id}/threads'].get;
  const response = operation.responses['200'].content['application/json'].schema;
  const fields = response.properties;
  const entry = fields.threads.items;
  const context = fields.context;

  expect(operation.operationId).toBe('subject_threads.list');
  expect(response.additionalProperties).toBe(false);
  expect(response.required).toEqual(['threads', 'next', 'reactionsAsOf', 'context']);
  expect(Object.keys(fields).sort()).toEqual(['context', 'next', 'reactionsAsOf', 'threads']);
  expect(context.additionalProperties).toBe(false);
  expect(context.required).toEqual(['subject', 'place', 'kind']);
  expect(entry.additionalProperties).toBe(false);
  expect(entry.properties).toHaveProperty('card');
  expect(entry.properties).toHaveProperty('reviewContext');
  expect(entry.properties).toHaveProperty('reactions');
  expect(entry.properties).toHaveProperty('viewerReaction');
});
