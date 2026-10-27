import { afterAll, expect, spyOn, test } from 'bun:test';
import { parseExposure } from '../../../src/access/gates/declaration.ts';
import { createPool } from '../../../src/database/pool.ts';
import * as appModule from '../../../src/http/app.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { CONTRACT, kernelContract } from '../../../scripts/openapi.ts';

const pool = createPool('postgres://kernel.invalid/exposure');
const dependencies = { pool, routeKey: new Uint8Array(32) };
afterAll(() => pool.end());

const invalid = [
  undefined,
  null,
  false,
  1,
  {},
  [],
  '',
  'PUBLIC',
  'public ',
  'gate:',
  'gate:Any',
  'gate:any',
  'gate:open',
  'gate:close',
  'gate:_feature',
  'gate:feature1',
  'gate:feature-name',
  'gate:feature:other',
  'gate:feature\n',
  'gate:feature ',
  `gate:${'a'.repeat(64)}`,
];

test('parseExposure accepts public and gate groups and refuses missing malformed and reserved values', () => {
  expect(parseExposure({ 'x-exposure': 'public' })).toEqual({ kind: 'public' });
  for (const group of [
    'a',
    'catalogue_import',
    'realm_appeals',
    'any_feature',
    'open_feature',
    'agent_verification',
    'a'.repeat(63),
  ]) {
    expect(parseExposure({ 'x-exposure': `gate:${group}` })).toEqual({ kind: 'gate', group });
  }
  for (const value of invalid) {
    expect(() => parseExposure({ operationId: 'thing.read', 'x-exposure': value })).toThrow('thing.read');
  }
  for (const detail of [undefined, null, false, 1, 'public', [], {}]) expect(() => parseExposure(detail)).toThrow();
});

test('a hyphenated gate group is refused', () => {
  expect(() => parseExposure({ 'x-exposure': 'gate:two-words' })).toThrow();
});

test('createKernel refuses to build with a visible route that has no valid x-exposure', () => {
  const original = appModule.createApp;
  for (const value of invalid) {
    const compose = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
      const app = original(dependencies);
      const detail = { operationId: 'thing.read', 'x-action': 'thing:read', security: [{}], 'x-exposure': value };
      app.get('/v1/undeclared', { detail }, () => 'ok');
      return app;
    });
    try {
      expect(() => createKernel(dependencies)).toThrow('GET /v1/undeclared');
    } finally {
      compose.mockRestore();
    }
  }

  // Standalone apps retain their existing declaration contract.
  const detail = { operationId: 'thing.read', 'x-action': 'thing:read', security: [{}] };
  const standalone = original({ pool }).get('/v1/standalone', { detail }, () => 'ok');
  expect(actionCatalogue(standalone).has('thing:read')).toBe(true);

  const compose = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    app.get('/hidden', { detail: { hide: true } }, () => 'ok');
    return app;
  });
  try {
    expect(() => createKernel(dependencies)).not.toThrow();
  } finally {
    compose.mockRestore();
  }
});

test('every route of the production kernel declares a valid x-exposure', () => {
  const routes = createKernel(dependencies).routes;
  expect(routes.length).toBeGreaterThan(0);
  const exposures = new Set<string>();
  for (const route of routes) {
    if (route.hooks.detail?.hide === true) continue;
    const exposure = parseExposure(route.hooks.detail);
    exposures.add(exposure.kind === 'public' ? 'public' : exposure.group);
  }
  expect(exposures).toContain('public');
  expect(exposures).toContain('personal_library');
  expect(exposures).toContain('reading_progress');
  expect(exposures).toContain('collections');
  expect(exposures).toContain('agent_verification');
});

test('the generated OpenAPI contract carries x-exposure on every operation', async () => {
  const generated = await kernelContract();
  expect(await Bun.file(CONTRACT).text()).toBe(generated);
  const document = JSON.parse(generated) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const operations = Object.values(document.paths).flatMap((path) => Object.values(path));
  expect(operations.length).toBeGreaterThan(0);
  const exposures = new Set<string>();
  for (const operation of operations) {
    const exposure = parseExposure(operation);
    exposures.add(exposure.kind === 'public' ? 'public' : exposure.group);
  }
  expect(exposures).toContain('public');
  expect(exposures).toContain('personal_library');
  expect(exposures).toContain('reading_progress');
  expect(exposures).toContain('collections');
  expect(exposures).toContain('agent_verification');
});
