import { expect, spyOn, test } from 'bun:test';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionInsufficientScope } from '../src/modules/account/verify-assertion.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { LIBRARY_IMPORT_BODY_BYTES } from '../src/routes/library-imports.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const secret = 'scope-secret-should-not-leak';

function main(verify: (request: Request, scopes: readonly string[]) => Promise<unknown>) {
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  return createMainApp(graph, {
    environment: { fuseki: graph, lineage: { dataEpoch: 'one', routingEpoch: 'one' } },
    account: { verify },
    access: { canReadAsBaselineMember: async () => true },
    libraryFiles: {},
    libraryImport: {},
  } as unknown as MainWorkDependencies);
}

function importRequest(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request('http://main.local/v1/me/library-imports', {
    method: 'POST',
    headers: {
      authorization: 'Bearer reader',
      'content-type': 'application/json',
      'idempotency-key': 'import-file',
      ...headers,
    },
    body,
  });
}

const admitted = async () => ({
  issuer: 'https://account.test', subject: 'reader', accountScopes: ['work:read', 'library:write'],
});

function stalled() {
  return new ReadableStream<Uint8Array>({
    pull() { /* never completes; the transfer deadline refuses it */ },
  }, { highWaterMark: 0 });
}

async function problemBody(response: Response) {
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['code', 'status', 'title', 'type']);
  const text = JSON.stringify(body);
  expect(text).not.toContain(secret);
  expect(text).not.toContain('SELECT');
  expect(text).not.toMatch(/at \//);
  return body;
}

test('library import intake refuses an oversized body with 413 through createMainApp', async () => {
  const app = main(admitted);
  const response = await app.handle(importRequest(stalled(), {
    'content-length': String(LIBRARY_IMPORT_BODY_BYTES + 1),
  }));
  expect(response.status).toBe(413);
  expect(await problemBody(response)).toMatchObject({
    status: 413, code: 'library_import_too_large',
    title: 'Import body exceeds 2 MiB plus the 16 KiB request envelope',
  });
});

test('library import intake refuses a stalled transfer with 408 through createMainApp', async () => {
  const app = main(admitted);
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) =>
    nativeTimeout(callback, typeof delay === 'number' && delay >= 30_000 ? 20 : delay)) as typeof setTimeout);
  try {
    const response = await app.handle(importRequest(stalled()));
    expect(response.status).toBe(408);
    expect(await problemBody(response)).toMatchObject({
      status: 408, code: 'library_import_timeout', title: 'Import transfer timed out',
    });
  } finally {
    timer.mockRestore();
  }
});

test('library import intake refuses read-only consent with 401 through createMainApp', async () => {
  const app = main(async (_request, scopes) => {
    if (scopes.includes('library:write')) throw new AccountAssertionInsufficientScope(secret);
    return admitted();
  });
  const response = await app.handle(importRequest(JSON.stringify({
    actingSubject: agent, format: 'generic-csv', file: 'Title\nBook',
    mapping: { title: 'Title', statuses: {} },
  })));
  // A thrown AccountAssertionInsufficientScope used to become 500 internal_error
  // because the app hook answered before any route hook.
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer');
  expect(await problemBody(response)).toMatchObject({
    status: 401, code: 'account_assertion_denied',
    title: 'Account assertion is invalid or inactive',
  });
});

test('routes that declared a local error hook keep that refusal through createMainApp', async () => {
  const app = main(admitted);
  const cases = [
    {
      route: 'POST /v1/wiki/validations',
      request: new Request('http://main.local/v1/wiki/validations', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer reader' },
        body: '{}',
      }),
      status: 400, code: 'invalid_wiki_extraction',
    },
    {
      route: 'POST /v1/wiki/candidates',
      request: new Request('http://main.local/v1/wiki/candidates', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer reader' },
        body: '{}',
      }),
      status: 400, code: 'invalid_request',
    },
    {
      route: 'POST /v1/me/library-imports',
      request: importRequest(JSON.stringify({
        actingSubject: agent, format: 'other', file: 'Title\nBook',
      })),
      status: 400, code: 'invalid_request',
    },
  ];
  expect(cases.map(item => item.route)).toEqual([
    'POST /v1/wiki/validations',
    'POST /v1/wiki/candidates',
    'POST /v1/me/library-imports',
  ]);
  for (const item of cases) {
    const response = await app.handle(item.request);
    expect({ route: item.route, status: response.status }).toEqual({ route: item.route, status: item.status });
    expect(await problemBody(response)).toMatchObject({ status: item.status, code: item.code });
  }
});
