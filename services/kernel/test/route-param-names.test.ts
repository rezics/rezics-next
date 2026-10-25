import { afterAll, expect, spyOn, test } from 'bun:test';
import { createPool } from '../src/database/pool.ts';
import * as appModule from '../src/http/app.ts';
import { createKernel } from '../src/http/kernel.ts';

const pool = createPool('postgres://kernel.invalid/route-param-names');
const dependencies = { pool, routeKey: new Uint8Array(32) };
afterAll(() => pool.end());

function withRoutes(mount: (app: ReturnType<typeof appModule.createApp>) => void) {
  const original = appModule.createApp;
  const compose = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    mount(app);
    return app;
  });
  try {
    return createKernel(dependencies);
  } finally {
    compose.mockRestore();
  }
}

test('createKernel refuses routes that use different parameter names at the same position and static prefix', () => {
  expect(() => {
    withRoutes((app) => {
      app.get('/v1/parameter-check/:id', { detail: { hide: true } }, () => 'ok');
      app.post('/v1/parameter-check/:threadId/reaction', { detail: { hide: true } }, () => 'ok');
    });
  }).toThrow(/GET \/v1\/parameter-check\/:id.*POST \/v1\/parameter-check\/:threadId\/reaction/);
});

test('routes with different static prefixes or the same parameter name build', () => {
  expect(() => {
    withRoutes((app) => {
      app.get('/v1/parameter-check/threads/:id', { detail: { hide: true } }, () => 'ok');
      app.post('/v1/parameter-check/posts/:postId/reaction', { detail: { hide: true } }, () => 'ok');
      app.get('/v1/parameter-check/shared/:subjectId', { detail: { hide: true } }, () => 'ok');
      app.post('/v1/parameter-check/shared/:subjectId/reaction', { detail: { hide: true } }, () => 'ok');
    });
  }).not.toThrow();
});

test('the production createKernel builds', () => {
  expect(() => createKernel(dependencies)).not.toThrow();
});
