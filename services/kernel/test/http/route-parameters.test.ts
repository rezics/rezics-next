import { afterAll, expect, spyOn, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import * as appModule from '../../src/http/app.ts';
import { createKernel } from '../../src/http/kernel.ts';

const pool = createPool('postgres://kernel.invalid/route-parameters');
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

test('createKernel refuses differently shaped routes with different names below one static prefix', () => {
  expect(() => {
    withRoutes((app) => {
      app.get('/x/:id/a', { detail: { hide: true } }, () => 'ok');
      app.post('/x/:other/b/c', { detail: { hide: true } }, () => 'ok');
    });
  }).toThrow(/GET \/x\/:id\/a and POST \/x\/:other\/b\/c: inconsistent path parameter name at position 2/);
});

test('createKernel checks parameter names below earlier parameters', () => {
  expect(() => {
    withRoutes((app) => {
      app.get('/x/:id/children/:child/a', { detail: { hide: true } }, () => 'ok');
      app.post('/x/:id/children/:other/b/c', { detail: { hide: true } }, () => 'ok');
    });
  }).toThrow(
    /GET \/x\/:id\/children\/:child\/a and POST \/x\/:id\/children\/:other\/b\/c: inconsistent path parameter name at position 4/,
  );
});

test('createKernel allows different prefixes and a shared parameter name below one prefix', () => {
  expect(() => {
    withRoutes((app) => {
      app.get('/x/threads/:id/a', { detail: { hide: true } }, () => 'ok');
      app.post('/x/posts/:postId/b/c', { detail: { hide: true } }, () => 'ok');
      app.get('/x/shared/:subjectId/a', { detail: { hide: true } }, () => 'ok');
      app.post('/x/shared/:subjectId/b/c', { detail: { hide: true } }, () => 'ok');
    });
  }).not.toThrow();
});
