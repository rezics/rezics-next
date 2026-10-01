import { expect, test } from 'bun:test';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';

const removed = ['POST /v1/translation-links', 'POST /v1/work-derivations'] as const;

function mainApp() {
  return createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), {} as MainWorkDependencies);
}

test('G-844: translation and derivation each keep one declared write', async () => {
  const app = mainApp();
  const routes = app.routes.map(route => `${route.method} ${route.path}`);
  for (const route of removed) expect(routes).not.toContain(route);
  expect(routes).toContain('GET /v1/main-versions/:mainVersion/revisions/:revision/translation-links');
  expect(routes).toContain('GET /v1/main-versions/:mainVersion/revisions/:revision/work-derivations');
  expect(routes).toContain('POST /v1/resources/:resource/derivations');
  expect(routes).toContain('PUT /v1/works/:id/realizations/:realization');
  for (const path of ['/v1/translation-links', '/v1/work-derivations']) {
    const response = await app.handle(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'g-844-retired-write' },
      body: '{}',
    }));
    expect(response.status).toBe(404);
  }
});

test('G-844: generated operations omit the retired writes', async () => {
  const document = JSON.parse(await buildMainOpenApi()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  expect(document.paths['/v1/translation-links']?.post).toBeUndefined();
  expect(document.paths['/v1/work-derivations']?.post).toBeUndefined();
  expect(document.paths['/v1/main-versions/{mainVersion}/revisions/{revision}/translation-links']?.get)
    .toBeDefined();
  expect(document.paths['/v1/main-versions/{mainVersion}/revisions/{revision}/work-derivations']?.get)
    .toBeDefined();
  expect(document.paths['/v1/resources/{resource}/derivations']?.post).toBeDefined();
  expect(document.paths['/v1/works/{id}/realizations/{realization}']?.put).toBeDefined();
});
