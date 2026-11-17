import { afterAll, expect, test } from 'bun:test';
import { Elysia, setupTypebox, t } from 'elysia';
import { createMirror } from 'exact-mirror';

const compiledMembers: unknown[] = [];
setupTypebox({
  exactMirror(schema, options) {
    if (!options?.Compile) return createMirror(schema, options);
    const compile = options.Compile;
    return createMirror(schema, {
      ...options,
      Compile(...args) {
        const validator = compile(...args);
        compiledMembers.push(validator);
        return validator;
      },
    });
  },
});
afterAll(() => setupTypebox({ exactMirror: createMirror }));

const request = (path: string) => new Request(`http://localhost${path}`);
const json = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('response mirrors preserve closed refs, formats and unknown-field normalization', async () => {
  let result: unknown = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    left: { title: ['harbour', 7] },
    right: ['ferry'],
    extra: 'private',
  };
  const app = new Elysia()
    .model(
      'Node',
      t.Union([
        t.String(),
        t.Number(),
        t.Object({ label: t.Union([t.String(), t.Number()]) }),
        t.Array(t.Ref('Node')),
        t.Record(t.String(), t.Ref('Node')),
      ]),
    )
    .get(
      '/refs',
      {
        response: t.Object({ id: t.String({ format: 'uuid' }), left: t.Ref('Node'), right: t.Ref('Node') }),
      },
      () => result,
    );
  compiledMembers.length = 0;
  app.compile();
  expect(compiledMembers.length).toBeGreaterThan(0);
  expect(new Set(compiledMembers).size).toBeLessThan(compiledMembers.length);
  expect(await (await app.handle(request('/refs'))).json()).toEqual({
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    left: { title: ['harbour', 7] },
    right: ['ferry'],
  });
  result = { id: 'invalid', left: 'harbour', right: 7 };
  expect((await app.handle(request('/refs'))).status).toBe(500);
  result = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000001', left: true, right: 7 };
  expect((await app.handle(request('/refs'))).status).toBe(500);
});

test('mirror members retain distinct refinements, codec functions and numeric coercion', async () => {
  const alpha = t.Refine(t.String(), (input) => input === 'alpha');
  const beta = t.Refine(t.String(), (input) => input === 'beta');
  const coded = (prefix: string) =>
    t
      .Codec(t.String())
      .Decode((input) => `${prefix}:${input}`)
      .Encode(String);
  const app = new Elysia()
    .post(
      '/refinements',
      {
        body: t.Object({ left: t.Union([alpha, t.Null()]), right: t.Union([beta, t.Null()]) }),
      },
      ({ body }) => body,
    )
    .post(
      '/codecs',
      {
        body: t.Object({ left: coded('A'), right: coded('B') }),
        query: t.Object({ page: t.Numeric({ minimum: 1 }) }),
      },
      ({ body, query }) => ({ body, page: query.page }),
    );
  expect((await app.handle(json('/refinements', { left: 'alpha', right: 'beta' }))).status).toBe(200);
  expect((await app.handle(json('/refinements', { left: 'beta', right: 'alpha' }))).status).toBe(422);
  expect(await (await app.handle(json('/codecs?page=2', { left: 'x', right: 'y' }))).json()).toEqual({
    body: { left: 'A:x', right: 'B:y' },
    page: 2,
  });
  expect((await app.handle(json('/codecs?page=0', { left: 'x', right: 'y' }))).status).toBe(422);
});

test('mounted snapshots and later separate reference graphs retain independent response checks', async () => {
  const choice = (expected: string) => t.Object({ value: t.Literal(expected) });
  const model = choice('A');
  let first: unknown = { item: { value: 'A' } };
  const a = new Elysia()
    .model('Item', model)
    .get('/item', { response: t.Object({ item: t.Ref('Item') }) }, () => first);
  model.properties.value = t.Literal('B');
  let second: unknown = { item: { value: 'B' } };
  const b = new Elysia()
    .model('Item', t.Object({ ...model.properties }))
    .get('/item', { response: t.Object({ item: t.Ref('Item') }) }, () => second);
  expect((await a.handle(request('/item'))).status).toBe(200);
  expect((await b.handle(request('/item'))).status).toBe(200);
  first = { item: { value: 'B' } };
  second = { item: { value: 'A' } };
  expect((await a.handle(request('/item'))).status).toBe(500);
  expect((await b.handle(request('/item'))).status).toBe(500);
});
