import { expect, test } from 'bun:test';
import { openapi } from '@elysia/openapi';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';

const absent = '00000000-0000-4000-8000-000000000001';

function mainApp() {
  return createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), {} as MainWorkDependencies);
}

test('Main OpenAPI lists no vertical facts operation', async () => {
  const app = mainApp().use(openapi({
    documentation: { info: { title: 'REZICS Main Public API', version: '1.0.0' } },
    exclude: { paths: /^\/health\//, staticFile: false },
  }));
  const response = await app.handle(new Request('http://localhost/openapi/json'));
  expect(response.status).toBe(200);
  const document = await response.json() as { paths?: Record<string, Record<string, unknown>> };
  const operations = Object.entries(document.paths ?? {}).flatMap(([path, methods]) =>
    Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`));
  expect(operations.some(operation => operation === 'POST /v1/works')).toBe(true);
  expect(operations.filter(operation => operation.includes('-facts/'))).toEqual([]);
});

test('a game or software facts read is the router 404', async () => {
  const app = mainApp();
  for (const path of [`/v1/game-facts/${absent}`, `/v1/software-facts/${absent}`]) {
    const response = await app.handle(new Request(`http://localhost${path}`));
    expect(response.status).toBe(404);
    expect((await response.json() as { code: string }).code).toBe('not_found');
  }
});
