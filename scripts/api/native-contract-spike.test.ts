import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measureSpike, prepareSpike, probeSpike, spikeVersions, type SpikeRelease } from './native-contract-spike.ts';

// An explicit scratch dependency installation can run this same evidence against next.
const supplied = process.env.API_NATIVE_SPIKE_ROOT;
const installed = JSON.parse(readFileSync('node_modules/elysia/package.json', 'utf8')) as { version: string };
const release: SpikeRelease = process.env.API_NATIVE_SPIKE_RELEASE === 'pinned' ? 'pinned'
  : process.env.API_NATIVE_SPIKE_RELEASE === 'next' || installed.version === spikeVersions.next.elysia ? 'next' : 'pinned';
mkdirSync('.temp', { recursive: true });
const root = supplied ? resolve(supplied) : mkdtempSync(resolve('.temp/native-contract-test-'));
let probe: Awaited<ReturnType<typeof probeSpike>>;
beforeAll(async () => {
  prepareSpike(root, release);
  probe = await probeSpike(root);
}, 30_000);
afterAll(() => { if (!supplied) rmSync(root, { recursive: true, force: true }); });

test('native schemas check separate handlers and preserve literal status/code unions in Eden', () => {
  expect(probe.positive.exitCode).toBe(0);
  expect(probe.diagnostics.success).toMatchObject({ exitCode: 1, diagnostics: expect.stringContaining('TS2345') });
  expect(probe.diagnostics.code).toMatchObject({ exitCode: 1, diagnostics: expect.stringContaining('TS2322') });
  expect(probe.diagnostics.status).toMatchObject({ exitCode: 1, diagnostics: expect.stringContaining("'418'") });
  expect(probe.diagnostics.input).toMatchObject({ exitCode: 1, diagnostics: expect.stringContaining("Property 'missing'") });
  expect(probe.diagnostics.binding).toMatchObject({ exitCode: 1, diagnostics: expect.stringContaining('TS2345') });
});

test('native Problem serialization, auth, exposure, limits, and 202 survive real requests', () => {
  expect(probe.runtime).toMatchObject({
    returned: { status: 409, contentType: 'application/problem+json', body: { code: 'OUT_OF_STOCK', status: 409 } },
    thrown: { status: 409, body: { code: 'OUT_OF_STOCK' } },
    problem: { contentType: 'application/problem+json' },
    status: { contentType: 'application/json;charset=utf-8' },
    read: { status: 200, body: { id: 'abc' } }, unauthorized: { status: 401 },
    hidden: { status: 404 }, command: { status: 200, body: { id: 'abcnamemember' } },
    readLimited: [{ status: 200 }, { status: 429 }],
    commandLimited: [{ status: 200 }, { status: 429 }],
    failures: [{ status: 409, body: { code: 'OUT_OF_STOCK' } },
      { status: 409, body: { code: 'LOCKED' } }, { status: 404, body: { code: 'MISSING' } }],
    accepted: { status: 202, body: { state: 'pending' } },
    invalidInput: { status: 422 },
    unknown: { status: 500, body: { code: 'internal-server-error' } },
  });
  expect(JSON.stringify(probe.runtime.unknown)).not.toContain('secret implementation detail');
});

test('OpenAPI needs runtime response schemas and still replaces authored per-status details', () => {
  const document = probe.runtime.openapi as { paths: Record<string, Record<string, Record<string, unknown>>> };
  for (const path of ['/returned', '/thrown', '/status', '/problem', '/mapped-returned'])
    expect(document.paths[path]!.get).not.toHaveProperty('responses');
  expect(document.paths['/command/{id}']!.post).toMatchObject({
    operationId: 'spikeCommand', security: [{ bearerAuth: [] }],
    'x-exposure': 'platform:test', 'x-rate-limit-family': 'write',
    responses: { 409: { content: { 'application/json': { schema: { anyOf: [
      { properties: { code: { const: 'OUT_OF_STOCK' } } }, { properties: { code: { const: 'LOCKED' } } },
    ] } } } } },
  });
  const overlay = document.paths['/overlay']!.get!.responses as Record<string, unknown>;
  expect(Object.keys(overlay).sort()).toEqual(['200', '409']);
  expect(overlay['409']).not.toHaveProperty('headers');
  expect(overlay['409']).not.toHaveProperty('content.application/problem+json');
  expect(overlay['409']).toHaveProperty('description', 'Response for status 409');
  expect(document.paths['/one-declaration']!.get).toMatchObject({ responses: {
    409: { content: { 'application/json': { schema: { properties: { code: { const: 'OUT_OF_STOCK' } } } } } },
  } });
  expect(document.paths['/command/{id}']!.post!.responses).not.toHaveProperty('422');
});

test('captures escape hatches and version-specific API changes without assuming a closed contract', () => {
  expect(probe.runtime).toMatchObject({
    raw: { status: 409, body: { leaked: 'raw bypass' } },
    'undeclared-success': { status: 200, body: { id: 7 } },
    'wrong-schema': { status: 500 }, unhandledForeign: { status: 410, body: 'foreign message' },
  });
  expect(probe.diagnostics.missingResponse!.exitCode).toBe(0);
  expect(probe.diagnostics.classModel!.diagnostics).toContain('TS2345');
  if (release === 'next') {
    expect(probe.diagnostics.classMismatch!.exitCode).toBe(0);
    expect(probe.runtime['class-mismatch']).toMatchObject({ status: 409, body: { code: 'LOCKED' } });
    expect(probe.diagnostics.error!.diagnostics).toContain('TS2551');
    expect(probe.diagnostics.detailMethod!.diagnostics).toContain('TS2416');
  } else {
    expect(probe.diagnostics.classSchema!.diagnostics).toContain('TS2345');
    expect(probe.diagnostics.onError!.diagnostics).toContain('TS2551');
    expect(probe.diagnostics.detailProperty!.diagnostics).toContain('TS2416');
  }
});

test('measures separate server and exercised Eden consumers with compiler diagnostics', async () => {
  const measurementRoot = prepareSpike(join(root, 'test-measurement'), release);
  const measurements = await measureSpike(measurementRoot, 1, [1]);
  expect(measurements).toHaveLength(6);
  for (const sample of measurements) {
    expect(sample.exitCode).toBe(0);
    expect(sample.instantiations).toBeGreaterThan(0);
    expect(sample.wallMs).toBeGreaterThan(0);
    expect(sample.checkSeconds).not.toBeNull();
  }
}, 30_000);
