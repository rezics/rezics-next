import { expect, test } from 'bun:test';
import { inspectHandler, schemaCodeKind } from './boundary-audit.ts';
import { Elysia, t } from 'elysia';

test('raw Response bypasses the declared status and body validation in the pinned framework', async () => {
  const app = new Elysia().get('/type-probe', {
    response: { 200: t.Object({ ok: t.Boolean() }) },
  }, () => Response.json({ wrong: 'shape' }, { status: 418 }));
  const response = await app.handle(new Request('http://localhost/type-probe'));
  expect(response.status).toBe(418);
  expect(await response.json()).toEqual({ wrong: 'shape' });
});

test('status inventory follows local helpers, preserves codes and reports unresolved status expressions', () => {
  const source = `const reply = () => Response.json({}, { status: replay ? 200 : 201 });
function refuse() { return problem(409, 'moved', 'Moved'); }
new Elysia()
  .post('/v1/example', { response: {} }, async () => {
    if (bad) return refuse();
    if (other) return Response.json({}, { status: result.status });
    return reply();
  });`;
  const facts = inspectHandler(source, 4)!;
  expect(facts.responses.map(value => value.status).sort()).toEqual([200, 201, 409]);
  expect(facts.responses.find(value => value.status === 409)?.code).toBe('moved');
  expect(facts.dynamicStatuses).toEqual(['result.status']);
  expect(facts.rawConstructors).toBe(2);
  expect(inspectHandler(source, 4, false)?.responses).toEqual([]);
  expect(inspectHandler(source, 100)).toBeUndefined();
});

test('defaults, named status returns, raw helpers and set.status remain distinct', () => {
  const source = `new Elysia().get('/v1/a', {}, ({ set, status }) => {
    set.status = 202;
    if (bad) return commandError(error);
    if (missing) return status(404, {});
    if (cached) return new Response(null, { status: 304 });
    return Response.json({});
  });`;
  const facts = inspectHandler(source, 1)!;
  expect(facts.responses.map(value => value.status)).toEqual([202, 404, 304, 200]);
  expect(facts.sharedRawHelpers).toEqual(['commandError']);
  expect(facts.rawConstructors).toBe(2);
});

test('unions containing a broad code stay broad, while concrete variants are recognized', () => {
  const broad = { type: 'object', properties: { code: { type: 'string' } } };
  const exact = { type: 'object', properties: { code: { const: 'moved', type: 'string' } } };
  expect(schemaCodeKind(broad)).toBe('string');
  expect(schemaCodeKind(exact)).toBe('literal');
  expect(schemaCodeKind({ anyOf: [exact, broad] })).toBe('string');
  expect(schemaCodeKind({ oneOf: [exact] })).toBe('literal');
  expect(schemaCodeKind(undefined)).toBe('absent');
});

test('handler factories contribute local status candidates without pretending to infer domain reachability', () => {
  const source = `const write = (run) => async () => { if (bad) return problem(410, 'expired', 'Expired'); return Response.json(await run()); };
new Elysia().post('/v1/a', { response: {} }, write(() => owner.change()));`;
  expect(inspectHandler(source, 2)?.responses.map(value => value.status)).toEqual([410, 200]);
  expect(inspectHandler(source, 2, false)?.responses).toEqual([]);
});

test('named response options resolve, while unknown options do not fabricate a 200 response', () => {
  const source = `const noStore = { headers: { 'cache-control': 'no-store' } };
const accepted = { status: 202 };
new Elysia().get('/v1/a', {}, () => {
  if (a) return Response.json({}, noStore);
  if (b) return Response.json({}, accepted);
  return Response.json({}, unknownOptions);
});`;
  const facts = inspectHandler(source, 3)!;
  expect(facts.responses.map(value => value.status)).toEqual([200, 202]);
  expect(facts.dynamicStatuses).toEqual(['ResponseInit: unknownOptions']);
});
