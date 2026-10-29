import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { publicationLimits, releaseDigest, validateRelease } from '@rezics/definitions';
import { constructionFixture } from '../../../../packages/definitions/test/support/publication-construction.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';
import { effectsSnapshot } from './support/definition-publication-work.ts';

let driver: SemanticOutcomeDriver;
let directory: string;
let script: string;
const root = resolve(import.meta.dir, '../../../..');
const key = () => ({ 'Idempotency-Key': JSON.stringify(randomUUID()) });
beforeAll(async () => {
  driver = await createSemanticDriver();
  await driver.projection('paused');
  const temporary = join(root, '.temp/publication-construction');
  mkdirSync(temporary, { recursive: true });
  directory = mkdtempSync(join(temporary, 'http-'));
  script = join(directory, 'cold.ts');
  // Both historical creation and current cold reads use the mounted kernel with
  // real Auth/Access and this driver's actual pool. Only the historical creator
  // loads the unchanged old code; current verification runs the delivered core.
  writeFileSync(
    script,
    `
const input = await Bun.stdin.json();
if (input.original) {
  const paths = new Map([
    ['${root}/packages/definitions/src/index.ts', 'packages/definitions/src/index.ts'],
    ['${root}/packages/filter/src/filter.ts', 'packages/filter/src/filter.ts'],
    ['${root}/services/kernel/src/semantic/definitions.ts', 'services/kernel/src/semantic/definitions.ts'],
  ]);
  Bun.plugin({ name: 'historical-implementation', setup(build) {
    build.onLoad({ filter: /\\.ts$/ }, ({ path }) => {
      const source = paths.get(path);
      if (!source) return;
      const result = Bun.spawnSync(['git', 'show', '2c86ce30ef:' + source], { cwd: '${root}' });
      if (result.exitCode) throw new Error(result.stderr.toString());
      return { contents: result.stdout.toString(), loader: 'ts' };
    });
  }});
}
const { createPool } = await import('${root}/services/kernel/src/database/pool.ts');
const { createKernel } = await import('${root}/services/kernel/src/http/kernel.ts');
const { createKernelRuntimeDefaults } = await import('${root}/services/kernel/src/server.ts');
const { validateRelease, releaseDigest } = await import('${root}/packages/definitions/src/index.ts');
const runtime = input.runtime;
const pool = createPool(runtime.databaseUrl);
let points = 0;
const query = pool.query.bind(pool);
pool.query = function(...args) {
  const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  if (/SELECT digest\\s+FROM semantic.definition_release\\s+WHERE route/.test(text)) points++;
  return query(...args);
};
try {
  const defaults = createKernelRuntimeDefaults({ env: {
    ...process.env, KERNEL_SESSION_KEYS: runtime.sessionKeys,
    KERNEL_WRITE_RATE_SECRET: 'construction-cold-http-secret-with-at-least-32-bytes',
  }, auth: { issuer: runtime.authIssuer, audience: runtime.authAudience, jwksUrl: runtime.authJwksUrl } });
  const kernel = createKernel({ ...defaults, pool, routeKey: Buffer.from(runtime.routeKey, 'base64url') });
  const headers = new Headers(input.headers);
  if (input.bearer) headers.set('authorization', 'Bearer ' + input.bearer);
  if (input.body !== undefined) headers.set('content-type', 'application/json');
  const validation = input.original ? validateRelease(input.body.release) : undefined;
  const digest = input.original ? releaseDigest(input.body.release) : undefined;
  const response = await kernel.handle(new Request('http://kernel.test' + input.path, {
    method: input.method, headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  }));
  console.log(JSON.stringify({ status: response.status, body: await response.json(),
    etag: response.headers.get('etag'), session: response.headers.get('rezics-session-token'),
    validation, digest, points }));
} finally { await pool.end(); }
`,
  );
}, 180_000);
afterAll(async () => {
  await driver?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function cold(options: {
  method: string;
  path: string;
  bearer?: string;
  headers?: Record<string, string>;
  body?: unknown;
  original?: boolean;
}) {
  const child = Bun.spawn([process.execPath, script], {
    cwd: resolve(root, 'services/kernel'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ runtime: driver.fixtures.runtime, ...options }));
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr + stdout).toBe(0);
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines.at(-1)!) as {
    status: number;
    body: Record<string, any>;
    etag: string | null;
    session: string | null;
    validation?: unknown;
    digest?: string;
    points: number;
  };
}

// Parent integration obligation: there is still no production callable HTTP work
// producer for the exact same-pattern reached-defect 400 before excess 422 tie.
// The original CPU HTTP test and package checkpoint schedule remain unchanged.
test('new publication shape boundaries are accepted exactly and refused without effects', async () => {
  const author = await driver.fixtures.person('construction-boundary-author');
  await driver.fixtures.grantAccount(author, ['definitions:publish']);
  const boundary = constructionFixture(4096, 4096);
  const mappings = Array.from({ length: 256 }, (_, i) => `grow:M${String(i).padStart(4, '0')}`);
  boundary.types['grow:Root']!.mappings = mappings;
  boundary.properties['grow:code']!.mappings = [...mappings];
  expect(validateRelease(boundary)).toEqual([]);
  expect(publicationLimits(boundary)).toEqual([]);
  const before = await effectsSnapshot(driver.fixtures.pool);
  const headers = key();
  const publish = (release: unknown, requestHeaders = key()) =>
    driver.fixtures.send(author, 'POST', '/v1/definitions/releases', { release }, requestHeaders);
  const first = await publish(boundary, headers);
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toEqual({ digest: releaseDigest(boundary) });
  const applied = await effectsSnapshot(driver.fixtures.pool);
  for (const table of ['semantic.definition_release', 'core.receipt', 'core.outbox', 'editorial.write_basis'])
    expect((applied[table] as unknown[]).length - (before[table] as unknown[]).length, table).toBe(1);
  expect((await publish(boundary, headers)).status).toBe(201);
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(applied);
  for (const member of ['bases', 'type-mappings', 'property-mappings', 'qualifiers']) {
    const excess = structuredClone(boundary);
    let pointer: string;
    if (member === 'bases') {
      excess.types['grow:Root']!.bases.push('grow:Zlast');
      pointer = '/types/grow:Root/bases';
    } else if (member === 'type-mappings') {
      excess.types['grow:Root']!.mappings.push('grow:Zlast');
      pointer = '/types/grow:Root/mappings';
    } else if (member === 'property-mappings') {
      excess.properties['grow:code']!.mappings.push('grow:Zlast');
      pointer = '/properties/grow:code/mappings';
    } else {
      excess.properties['grow:code']!.qualifiers.push('zzgrow:Zlast');
      pointer = '/properties/grow:code/qualifiers';
    }
    const snapshot = await effectsSnapshot(driver.fixtures.pool);
    const refused = await publish(excess);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'invalid_request',
      effect_status: 'not_applied',
      errors: [{ pointer: '/release' + pointer, code: 'out_of_range' }],
    });
    expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(snapshot);
  }
  const conflict = structuredClone(boundary);
  conflict.catalogue.version += '-conflict';
  const refused = await publish(conflict, headers);
  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe('idempotency_conflict');
}, 180_000);

test('a native historically accepted over-cap pin is cold-readable byte-identically and retains replay/new-key/current-denial behavior', async () => {
  const author = await driver.fixtures.person('construction-historical-author');
  await driver.fixtures.grantAccount(author, ['definitions:publish']);
  const historical = constructionFixture(4097, 4096);
  historical.catalogue.version = 'historical-construction';
  historical.types['grow:Root']!.mappings = Array.from(
    { length: 257 },
    (_, i) => `grow:M${String(i).padStart(4, '0')}`,
  );
  const headers = key();
  const request = {
    method: 'POST',
    path: '/v1/definitions/releases',
    bearer: author.bearer,
    body: { release: historical },
    headers,
  };
  const created = await cold({ ...request, original: true });
  expect(created.validation).toEqual([]);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const digest = releaseDigest(historical);
  expect(created.digest).toBe(digest);
  expect(created.body).toEqual({ digest });
  const applied = await effectsSnapshot(driver.fixtures.pool);
  const read = await cold({ method: 'GET', path: `/v1/definitions/releases/${digest}` });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body).toEqual({ digest, release: historical });
  expect(read.etag).toBe(JSON.stringify(digest));
  const replay = await cold(request);
  expect(replay.status, JSON.stringify(replay.body)).toBe(201);
  expect(replay.body).toEqual({ digest });
  expect(replay.points).toBe(1);
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(applied);
  const existing = await cold({ ...request, headers: key() });
  expect(existing.status, JSON.stringify(existing.body)).toBe(200);
  expect(existing.body).toEqual({ digest });
  expect(existing.points).toBe(1);
  const after = await effectsSnapshot(driver.fixtures.pool);
  expect(after['semantic.definition_release']).toEqual(applied['semantic.definition_release']);
  for (const table of ['core.receipt', 'core.outbox', 'editorial.write_basis'])
    expect((after[table] as unknown[]).length - (applied[table] as unknown[]).length, table).toBe(1);
  // Native self-renunciation uses the public grant command, without SQL authority.
  const revoke = await driver.fixtures.send(
    author,
    'POST',
    '/v1/grants:revoke',
    {
      resource: { route: 0, id: driver.globalContext },
      subject: { kind: 'account', id: author.accountId },
      actions: ['definitions:publish'],
      valid: '(,)',
    },
    key(),
  );
  expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
  const deniedBefore = await effectsSnapshot(driver.fixtures.pool);
  const denied = await cold(request);
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect(denied.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(denied.body).not.toHaveProperty('digest');
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(deniedBefore);
}, 180_000);
