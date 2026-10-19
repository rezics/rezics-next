import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  canonicalHiddenIdReads,
  classifyHiddenIdReads,
  discoverHiddenIdReads,
  hiddenIdDebtGrowth,
  hiddenIdInventoryErrors,
  hiddenIdReadsPath,
  loadHiddenIdReads,
  loadOpenApi,
  registeredHiddenArchiveReads,
  registeredHiddenIdOperations,
  registeredHiddenIdReads,
  registeredHiddenIdWrites,
  type HiddenIdClassification,
  type OpenApiDocument,
} from './hidden-id-equality.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

const id = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
const actingSubject = { type: 'string', pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' };

function document(): OpenApiDocument {
  return {
    paths: {
      '/v1/works/{id}': {
        get: { parameters: [{ in: 'path', name: 'id', schema: id }] },
      },
      '/v1/access/authority-state': {
        get: {
          parameters: [
            { in: 'query', name: 'scopeId', schema: { type: 'string' } },
            { in: 'query', name: 'actingSubject', schema: actingSubject },
          ],
        },
      },
      '/v1/me/sessions': {
        get: { parameters: [{ in: 'query', name: 'actingSubject', schema: actingSubject }] },
      },
      '/v1/resources/summaries': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { resources: { type: 'array', items: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      '/v1/agents/{id}/shelves/status/{status}/works': {
        get: {
          parameters: [
            { in: 'path', name: 'id', schema: id },
            { in: 'path', name: 'status', schema: { type: 'string', enum: ['reading', 'read'] } },
          ],
        },
      },
      '/v1/lexicon/definitions/{key}': {
        get: {
          parameters: [
            { in: 'path', name: 'key', schema: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } },
          ],
        },
      },
      '/v1/statements/{id}': {
        get: {
          parameters: [
            { in: 'path', name: 'id', schema: { type: 'string', pattern: '^[0-9a-f-]{36}$' } },
            { in: 'query', name: 'search', schema: { type: 'string' } },
          ],
        },
      },
      '/v1/recipes/{id}/file-imports': {
        parameters: [{ in: 'path', name: 'id', schema: id }],
        post: { parameters: [
          { in: 'query', name: 'actingSubject', schema: actingSubject },
          { in: 'query', name: 'expectedHead', schema: actingSubject },
        ] },
      },
      '/v1/addresses/resolve': {
        get: {
          parameters: [
            { in: 'query', name: 'scope', schema: { type: 'string', pattern: '^(work|zone:https://rezics\\.com/id/[0-9a-f-]{36})$' } },
            { in: 'query', name: 'key', schema: { type: 'string' } },
          ],
        },
      },
    },
  };
}

test('discovery keeps resource ids and drops enumerations and vocabulary slugs', () => {
  expect(discoverHiddenIdReads(document())).toEqual([
    { operation: 'GET /v1/access/authority-state', ids: ['query:actingSubject', 'query:scopeId'] },
    { operation: 'GET /v1/addresses/resolve', ids: ['query:key', 'query:scope'] },
    { operation: 'GET /v1/agents/{id}/shelves/status/{status}/works', ids: ['path:id'] },
    { operation: 'GET /v1/me/sessions', ids: ['query:actingSubject'] },
    { operation: 'GET /v1/statements/{id}', ids: ['path:id'] },
    { operation: 'GET /v1/works/{id}', ids: ['path:id'] },
    { operation: 'POST /v1/recipes/{id}/file-imports', ids: ['path:id', 'query:actingSubject'] },
    { operation: 'POST /v1/resources/summaries', ids: ['body:resources'] },
  ]);
});

test('posting disclosure ids include the target and Person but exclude observed route and revision coordinates', () => {
  const body = { type: 'object', properties: {
    about: actingSubject, actingSubject, zone: actingSubject,
    routeRevision: actingSubject, targetRevision: actingSubject,
    body: { type: 'string' },
  } };
  const contract: OpenApiDocument = { paths: { '/v1/realms/{realm}/about-posts': { post: {
    parameters: [{ in: 'path', name: 'realm', schema: id }],
    requestBody: { content: { 'application/json': { schema: body } } },
  } } } };
  expect(classifyHiddenIdReads(discoverHiddenIdReads(contract))).toEqual([{
    operation: 'POST /v1/realms/{realm}/about-posts',
    ids: ['body:about', 'body:actingSubject', 'path:realm'], status: 'registered',
  }]);
  contract.paths['/v1/realms/{realm}/about-posts']!.post!.requestBody!.content!['application/json']!.schema = {
    type: 'object', properties: { actingSubject },
  };
  expect(() => discoverHiddenIdReads(contract)).toThrow('declares body:about disclosure but its contract has no resource id there');
});

test('an acting-subject-only read is exempt and other reads stay unregistered until covered', () => {
  const classified = classifyHiddenIdReads(discoverHiddenIdReads(document()), ['GET /v1/works/{id}']);
  expect(classified.find((entry) => entry.operation === 'GET /v1/me/sessions')).toEqual({
    operation: 'GET /v1/me/sessions',
    ids: ['query:actingSubject'],
    status: 'exempt',
    reason: "The only id is the caller's own acting subject.",
  });
  expect(classified.find((entry) => entry.operation === 'GET /v1/works/{id}')?.status).toBe('registered');
  expect(classified.find((entry) => entry.operation === 'POST /v1/resources/summaries')?.status).toBe(
    'unregistered',
  );
});

test('a new id-accepting read fails until classified and stale debt fails until removed', () => {
  const discovered = discoverHiddenIdReads(document());
  const committed = classifyHiddenIdReads(discovered, ['GET /v1/works/{id}']);
  expect(hiddenIdInventoryErrors(discovered, committed, ['GET /v1/works/{id}'])).toEqual([]);
  const added: OpenApiDocument = document();
  added.paths['/v1/widgets/{id}'] = { get: { parameters: [{ in: 'path', name: 'id', schema: id }] } };
  expect(
    hiddenIdInventoryErrors(discoverHiddenIdReads(added), committed, ['GET /v1/works/{id}']).join('\n'),
  ).toContain('GET /v1/widgets/{id} accepts resource ids and is not classified');
  expect(hiddenIdDebtGrowth(['GET /v1/works/{id}'], ['GET /v1/widgets/{id}'])).toEqual([
    'GET /v1/widgets/{id} is new unregistered debt; register or exempt it',
  ]);
  expect(hiddenIdDebtGrowth(['GET /v1/works/{id}', 'GET /v1/gone'], ['GET /v1/works/{id}'])).toEqual([]);
  const stale = committed.filter((entry) => entry.operation !== 'GET /v1/works/{id}');
  expect(hiddenIdInventoryErrors(discovered, stale, ['GET /v1/works/{id}']).join('\n')).toContain(
    'GET /v1/works/{id} accepts resource ids and is not classified',
  );
});

test('marking a covered read unregistered fails and the canonical inventory is stable', () => {
  const discovered = discoverHiddenIdReads(document());
  const committed = classifyHiddenIdReads(discovered, ['GET /v1/works/{id}']).map((entry) =>
    entry.operation === 'GET /v1/works/{id}'
      ? ({ ...entry, status: 'unregistered' } as HiddenIdClassification)
      : entry,
  );
  expect(hiddenIdInventoryErrors(discovered, committed, ['GET /v1/works/{id}']).join('\n')).toContain(
    'classification is registered',
  );
  const rendered = canonicalHiddenIdReads(classifyHiddenIdReads(discovered, ['GET /v1/works/{id}']));
  expect(rendered.endsWith('\n')).toBe(true);
  expect(JSON.parse(rendered)).toEqual(classifyHiddenIdReads(discovered, ['GET /v1/works/{id}']));
});

test('the committed inventory matches the public contract and registered reads have coverage', () => {
  const discovered = discoverHiddenIdReads(loadOpenApi(root));
  const committed = loadHiddenIdReads(`${root}${hiddenIdReadsPath}`);
  expect(hiddenIdInventoryErrors(discovered, committed, registeredHiddenIdOperations)).toEqual([]);
  expect(canonicalHiddenIdReads(committed)).toBe(canonicalHiddenIdReads(classifyHiddenIdReads(discovered)));
  expect(committed.filter((entry) => entry.status === 'registered').map((entry) => entry.operation)).toEqual(
    [...registeredHiddenIdOperations],
  );
  expect(committed.filter((entry) => entry.status === 'registered' && entry.operation.startsWith('POST ')
    && ![...registeredHiddenIdReads, ...registeredHiddenArchiveReads].some((operation) => operation === entry.operation))
    .map((entry) => entry.operation)).toEqual([...registeredHiddenIdWrites]);
});
