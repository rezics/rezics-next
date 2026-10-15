import { expect, test } from 'bun:test';
import { buildMainOpenApi } from './generate.ts';
import { buildOperationIndex } from './operation-index.ts';
import { handlerResponseGaps, responseCoverage } from './response-coverage.ts';

test('every documented handler and applicable transport policy status is declared', async () => {
  const document = JSON.parse(await buildMainOpenApi());
  const coverage = responseCoverage(await buildOperationIndex(), document.paths);
  expect(coverage.checked).toBeGreaterThan(750);
  expect(coverage.gaps).toEqual([]);
}, 30_000);

test('a planted undeclared response status fails the guard', () => {
  const source = "app.get('/probe', { response: {} }, () => new Response(null, { status: 418 }));";
  expect(handlerResponseGaps(source, 1, { responses: { 200: {} } })).toEqual([418]);
  expect(handlerResponseGaps(source, 1, { responses: { 200: {}, 418: {} } })).toEqual([]);
});

test('conditional status branches, problem returns and typed status returns are checked', () => {
  const source = `app.post('/probe', {}, ({ status, set }) => {
    if (missing) return problem(404, 'not_found', 'Absent');
    if (pending) return status(202, {});
    set.status = replayed ? 200 : 201;
    return Response.json({}, { status: changed ? 409 : 422 });
  });`;
  expect(handlerResponseGaps(source, 1, { responses: { 200: {} } })).toEqual([201, 202, 404, 409, 422]);
});
