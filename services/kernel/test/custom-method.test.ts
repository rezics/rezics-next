import { afterAll, expect, test } from 'bun:test';
import { t } from 'elysia';
import { createPool } from '../src/database/pool.ts';
import { createApp } from '../src/http/app.ts';
import { customMethod } from '../src/http/custom-method.ts';
import { openApiDocument } from '../src/http/openapi.ts';
import { problemSchema } from '../src/http/problem.ts';

const pool = createPool('postgres://kernel.invalid/custom-method');
afterAll(() => pool.end());

const Answer = t.Object({ verb: t.String(), id: t.String() }, { additionalProperties: false });
const detail = (operationId: string) => ({ operationId, 'x-action': 'thing:read', security: [{ bearerAuth: [] }, {}] });
const params = t.Object({ id: t.String() });
const app = createApp({ pool })
  .get('/v1/things/:id', { params, response: { 200: Answer, 404: problemSchema('not_found') }, detail: detail('thing.get') }, ({ params }) => ({
    verb: 'get',
    id: params.id,
  }))
  .post(
    customMethod('/v1/things/:id', 'doThing'),
    { params, response: { 200: Answer, 404: problemSchema('not_found') }, detail: detail('thing.do_thing') },
    ({ params }) => ({ verb: 'doThing', id: params.id }),
  )
  .post(
    customMethod('/v1/things/:id', 'undo'),
    { params, response: { 200: Answer, 404: problemSchema('not_found') }, detail: detail('thing.undo') },
    ({ params }) => ({ verb: 'undo', id: params.id }),
  )
  .post(
    customMethod('/v1/things', 'batchDo'),
    { response: { 200: Answer }, detail: detail('thing.batch_do') },
    () => ({ verb: 'batchDo', id: '' }),
  );

async function call(method: string, path: string, through: 'handle' | 'fetch' = 'handle') {
  const request = new Request(`http://kernel.test${path}`, { method });
  const response = await (through === 'handle' ? app.handle(request) : app.fetch(request));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('a custom method is served at its AIP-136 path and its parameters may contain colons', async () => {
  expect(customMethod('/v1/media/:id', 'complete')).toBe('/v1/media/:id/$complete');
  expect(customMethod('/v1/subjects', 'merge')).toBe('/v1/subjects/$merge');
  for (const [path, verb] of [['/v1/things/:id', 'DoThing'], ['/v1/things/:id', 'do_thing'], ['/v1/things/', 'merge'], ['/v1/things', '']])
    expect(() => customMethod(path!, verb!)).toThrow();
  expect(await call('POST', '/v1/things/a1:doThing')).toEqual({ status: 200, body: { verb: 'doThing', id: 'a1' } });
  expect(await call('POST', '/v1/things/a1:undo', 'fetch')).toEqual({ status: 200, body: { verb: 'undo', id: 'a1' } });
  const digest = `sha256:${'ab12'.repeat(16)}`;
  expect(await call('POST', `/v1/things/${digest}:doThing`)).toEqual({ status: 200, body: { verb: 'doThing', id: digest } });
  expect(await call('POST', `/v1/things/sha256%3A${'ab12'.repeat(16)}:doThing`)).toEqual({
    status: 200,
    body: { verb: 'doThing', id: digest },
  });
  expect(await call('GET', `/v1/things/${digest}`)).toEqual({ status: 200, body: { verb: 'get', id: digest } });
  expect(await call('POST', '/v1/things:batchDo')).toEqual({ status: 200, body: { verb: 'batchDo', id: '' } });
});

test('only registered verbs are custom methods and internal paths are never served', async () => {
  for (const [method, path] of [
    ['POST', '/v1/things/a1/$doThing'],
    ['POST', '/v1/things/$batchDo'],
    ['POST', '/v1/things/a1:merge'],
    ['POST', '/v1/things/a1%3AdoThing'],
    ['POST', '/v1/thingsX:batchDo'],
    ['POST', '/v1/things/a1:doThing/extra'],
    ['GET', '/v1/things/a1:doThing'],
  ] as const) {
    const answer = await call(method, path);
    expect([path, answer.status, answer.body.code]).toEqual([path, 404, 'not_found']);
  }
  expect(await call('GET', '/v1/things/a1:merge')).toEqual({ status: 200, body: { verb: 'get', id: 'a1:merge' } });
});

test('the contract documents custom methods at their AIP-136 paths', () => {
  const paths = openApiDocument(app).paths;
  expect(Object.keys(paths).sort()).toEqual(['/v1/things/{id}', '/v1/things/{id}:doThing', '/v1/things/{id}:undo', '/v1/things:batchDo']);
  expect(paths['/v1/things/{id}:doThing']!.post).toMatchObject({ operationId: 'thing.do_thing' });
  expect(paths['/v1/things/{id}:doThing']!.post!.parameters).toEqual(
    expect.arrayContaining([expect.objectContaining({ in: 'path', name: 'id', required: true })]),
  );
  expect(paths['/v1/things:batchDo']!.post).toMatchObject({ operationId: 'thing.batch_do' });
  expect(JSON.stringify(paths)).not.toContain('$');
});
