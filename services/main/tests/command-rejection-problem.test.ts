import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { problemResult } from '../src/api-contract.ts';
import { CommandRejected } from '../src/infrastructure/fuseki.ts';
import { typedRefusal } from '../src/routes/problems.ts';

const nativeReason = 'populated ItemList requires completed membership preparation';
const privateFocus = 'https://internal.example/private-focus';
const privateValue = 'private-personal-value';

function responseFor(error: unknown) {
  const app = new Elysia().get('/command', {
    response: { 400: problemResult(400), 409: problemResult(409), 503: problemResult(503) },
  }, async ({ set }) => {
    const mapped = typedRefusal(error);
    if (!mapped) throw new Error('Expected a typed command refusal');
    set.status = mapped.status as 400 | 409 | 503;
    set.headers['content-type'] = mapped.headers.get('content-type') ?? 'application/problem+json';
    set.headers['cache-control'] = mapped.headers.get('cache-control') ?? 'no-store';
    return await mapped.json();
  });
  return app.handle(new Request('http://main.test/command'));
}

test('invalid command refusal preserves bounded native reason through problem schema', async () => {
  const response = await responseFor(new CommandRejected({ status: 'invalid', report: nativeReason }));
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(await response.json()).toEqual({
    type: 'https://rezics.com/problems/invalid_request',
    title: 'Command validation rejected the request',
    status: 400,
    code: 'invalid_request',
    detail: nativeReason,
    validation: { path: null, constraint: nativeReason },
  });
});

test('SHACL command refusal keeps only path and constraint, omitting focus and value data', async () => {
  const report = [
    'sh:resultPath <https://rezics.com/vocab/profileHandle>',
    'sh:sourceConstraintComponent <http://www.w3.org/ns/shacl#MinCountConstraintComponent>',
    `sh:focusNode <${privateFocus}>`,
    `sh:value "${privateValue}"`,
  ].join('\n');
  const response = await responseFor(new CommandRejected({ status: 'invalid', report }));
  const body = await response.text();
  expect(response.status).toBe(400);
  expect(body).toContain('https://rezics.com/vocab/profileHandle');
  expect(body).toContain('http://www.w3.org/ns/shacl#MinCountConstraintComponent');
  expect(body).not.toContain(privateFocus);
  expect(body).not.toContain(privateValue);
  expect(JSON.parse(body)).toMatchObject({
    detail: 'https://rezics.com/vocab/profileHandle http://www.w3.org/ns/shacl#MinCountConstraintComponent',
    validation: { path: 'https://rezics.com/vocab/profileHandle',
      constraint: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent' },
  });
});

test('missing, non-string, and unrecognized reports retain the generic invalid response', async () => {
  const reports: unknown[] = [undefined, { conforms: false }, `sh:focusNode <${privateFocus}> sh:value "${privateValue}"`];
  for (const report of reports) {
    const response = await responseFor(new CommandRejected({ status: 'invalid', report }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toEqual({
      type: 'https://rezics.com/problems/invalid_request',
      title: 'Command validation rejected the request',
      status: 400,
      code: 'invalid_request',
    });
  }
});

test('conflict and unavailable command refusals keep their existing problem responses', async () => {
  const conflict = await responseFor(new CommandRejected({ status: 'conflict' }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    type: 'https://rezics.com/problems/idempotency_conflict',
    title: 'Idempotency key conflicts with an earlier request',
    status: 409,
    code: 'idempotency_conflict',
  });

  const unavailable = await responseFor(new CommandRejected({ status: 'unknown-profile' }));
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    type: 'https://rezics.com/problems/dependency_unavailable',
    title: 'Command profile or storage is unavailable',
    status: 503,
    code: 'dependency_unavailable',
  });
});
