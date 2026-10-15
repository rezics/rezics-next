import { expect, test } from 'bun:test';
import { assertProblemPrecision } from './native-contract-pilot.ts';

test('pilot comparison permits literal alternatives and rejects changed Problem media, headers or extensions', () => {
  const envelope = { type: 'object', properties: { code: { type: 'string' }, status: { const: 409 } } };
  const narrow = (code: string) => ({ type: 'object', properties: { code: { type: 'string', const: code }, status: { const: 409 } } });
  const response = (schema: typeof envelope | { anyOf: ReturnType<typeof narrow>[] }) => ({
    headers: { 'Retry-After': { schema: { type: 'string' } } },
    content: { 'application/problem+json': { schema } },
  });
  expect(() => assertProblemPrecision(response(envelope), response({ anyOf: [narrow('stale_head'), narrow('idempotency_conflict')] }))).not.toThrow();
  expect(() => assertProblemPrecision(response(envelope), { content: { 'application/json': { schema: envelope } } })).toThrow();
  expect(() => assertProblemPrecision(response(envelope), { ...response(envelope), headers: {} })).toThrow();
  expect(() => assertProblemPrecision(envelope, { ...envelope, properties: { status: { const: 409 } } })).toThrow();
  expect(() => assertProblemPrecision(narrow('stale_head'), envelope)).toThrow();
});
