import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { RELEASE_LIMITS, releaseDigest, validateRelease } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';
import {
  CHECKPOINT_WEIGHT,
  digestContextDiagnostic,
  PROPOSED_ANALYSIS_MAX,
  effectsSnapshot,
  publicationFixture,
  PROPOSED_WORK_MAX,
  workDiagnostic,
} from './support/definition-publication-work.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';

let driver: SemanticOutcomeDriver;
beforeAll(async () => {
  // Preserve the shared driver's real Auth host, pool, bootstrap and kernel composition.
  driver = await createSemanticDriver();
  await driver.projection('paused');
}, 180_000);
afterAll(async () => {
  await driver?.close();
});

const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const snapshotHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The first HTTP acceptance intentionally reaches today's missing 422 boundary.
// Pure validation below is outside HTTP; it never changes the product verdict.
test('cold definition publication refuses deterministic excess work before effects while ordinary valid publication and current authorized replay retain their outcomes', async () => {
  const ordinary = publicationFixture();
  const excess = publicationFixture(RELEASE_LIMITS.properties - Object.keys(bundledRelease.properties).length);
  for (const [name, release] of [
    ['current bundled', bundledRelease],
    ['ordinary third-type', ordinary],
    ['excess', excess],
  ] as const) {
    expect(validateRelease(release), `${name}: actual pure validator`).toEqual([]);
    const diagnostic = workDiagnostic(release);
    const { proofs: _proofs, ...counts } = diagnostic;
    console.log('definition-publication-work diagnostic', JSON.stringify({ name, ...counts }));
    expect(diagnostic.allSafe).toBe(true);
    expect(diagnostic.fixedSafe).toBe(true);
    expect(diagnostic.releaseBytes).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
    if (name === 'excess') {
      expect(diagnostic.proposedReuseFloor).toBeGreaterThan(PROPOSED_WORK_MAX);
      expect(CHECKPOINT_WEIGHT * diagnostic.newSteps).toBeGreaterThan(PROPOSED_WORK_MAX);
    }
  }
  const current = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${bundledDigest}`);
  expect(current.status, JSON.stringify(current.body)).toBe(200);
  expect(current.body).toEqual({ digest: bundledDigest, release: bundledRelease });

  const account = await driver.fixtures.person('publication-work-author');
  await driver.fixtures.grantAccount(account, ['definitions:publish']);
  const publish = (release: unknown, headers = key()) =>
    driver.fixtures.send(account, 'POST', '/v1/definitions/releases', { release }, headers);
  const digest = releaseDigest(ordinary);
  const headers = key();
  const before = await effectsSnapshot(driver.fixtures.pool);
  const first = await publish(ordinary, headers);
  console.log('definition-publication-work cold', JSON.stringify({ status: first.status, body: first.body }));
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toEqual({ digest });
  expect(first.headers.get(SESSION_HEADER)).toBeTruthy();
  const applied = await effectsSnapshot(driver.fixtures.pool);
  for (const table of ['semantic.definition_release', 'core.receipt', 'core.outbox', 'editorial.write_basis'])
    expect((applied[table] as unknown[]).length - (before[table] as unknown[]).length, table).toBe(1);
  expect(applied['semantic.revision']).toEqual(before['semantic.revision']);
  const read = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${digest}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body).toEqual({ digest, release: ordinary });
  expect(read.headers.get('etag')).toBe(`"${digest}"`);

  const replay = await publish(ordinary, headers);
  expect(replay.status, JSON.stringify(replay.body)).toBe(201);
  expect(replay.body).toEqual(first.body);
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(applied);
  const existing = await publish(ordinary);
  expect(existing.status, JSON.stringify(existing.body)).toBe(200);
  expect(existing.body).toEqual({ digest });
  const afterNewKey = await effectsSnapshot(driver.fixtures.pool);
  expect(afterNewKey['semantic.definition_release']).toEqual(applied['semantic.definition_release']);
  for (const table of ['core.receipt', 'core.outbox', 'editorial.write_basis'])
    expect((afterNewKey[table] as unknown[]).length - (applied[table] as unknown[]).length, table).toBe(1);

  const changed = structuredClone(ordinary);
  changed.catalogue.version += '-changed';
  const conflict = await publish(changed, headers);
  expect(conflict.status, JSON.stringify(conflict.body)).toBe(422);
  expect(conflict.body).toMatchObject({ code: 'idempotency_conflict', retryable: false, effect_status: 'not_applied' });
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(afterNewKey);
  const malformed = await publish({});
  expect(malformed.status, JSON.stringify(malformed.body)).toBe(400);
  expect(malformed.body).toMatchObject({ code: 'invalid_request', retryable: false, effect_status: 'not_applied' });
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(afterNewKey);

  // Fixture mutation of the actual native grant, just as real-access.ts revokes it.
  // The next HTTP call uses the original real Auth token and current native Access.
  const revoked = await driver.fixtures.pool.query(
    `DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1
       AND subject_id=$2 AND action='definitions:publish' RETURNING action`,
    [driver.globalContext, account.accountId],
  );
  expect(revoked.rowCount).toBeGreaterThan(0);
  const deniedBefore = await effectsSnapshot(driver.fixtures.pool);
  const denied = await publish(ordinary, headers);
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect(denied.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(denied.body).not.toHaveProperty('digest');
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(deniedBefore);

  await driver.fixtures.grantAccount(account, ['definitions:publish']);
  const excessBefore = await effectsSnapshot(driver.fixtures.pool);
  const refused = await publish(excess);
  const excessAfter = await effectsSnapshot(driver.fixtures.pool);
  // Retain actual response and all-effects fingerprints even when status is wrong.
  console.log(
    'definition-publication-work reached HTTP boundary',
    JSON.stringify({
      status: refused.status,
      body: refused.body,
      before: snapshotHash(excessBefore),
      after: snapshotHash(excessAfter),
      deltas: Object.fromEntries(
        Object.keys(excessBefore).map((table) => [
          table,
          (excessAfter[table] as unknown[]).length - (excessBefore[table] as unknown[]).length,
        ]),
      ),
    }),
  );
  expect(refused.status, JSON.stringify(refused.body)).toBe(422);
  expect(refused.body).toMatchObject({
    code: 'definition_work_exceeded',
    retryable: false,
    effect_status: 'not_applied',
    errors: [{ pointer: '/release', code: 'out_of_range' }],
  });
  expect(refused.headers.has('retry-after')).toBe(false);
  expect(excessAfter).toEqual(excessBefore);
}, 180_000);

// Additional diagnostics do not replace any frozen HTTP assertion above.
test('checkpoint-only proposal retains the full catalogue at three changed-input sizes and bounds digest context bytes', () => {
  const context = digestContextDiagnostic();
  expect(context.clientUnits).toBe(1024);
  expect(context.requestedByBytes).toBe(92);
  expect(context.framingAndOperationBytes).toBe(76);
  expect(context.contextMaxBytes).toBe(76 + 6 * 1024 + 92);
  expect(context.contextMaxBytes).toBe(6312);
  console.log('definition-publication-work context bound', JSON.stringify(context));
  for (const added of [64, 512, RELEASE_LIMITS.properties - Object.keys(bundledRelease.properties).length]) {
    const release = publicationFixture(added);
    expect(validateRelease(release)).toEqual([]);
    const diagnostic = workDiagnostic(release);
    expect(diagnostic.fixedInitializationSteps).toBe(13_344);
    expect(diagnostic.fixedSources).toBe(8);
    expect(diagnostic.allSafe).toBe(true);
    expect(diagnostic.fixedSafe).toBe(true);
    expect(diagnostic.newSteps).toBe(967 + 14 * added);
    expect(diagnostic.knownByteFloor).toBe(
      4 * diagnostic.releaseBytes + 2 * diagnostic.envelopeBytes + 2 * diagnostic.valueCanonicalBytes,
    );
    expect(diagnostic.releaseBytes).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
    const { proofs: _proofs, currentFloor: _oldCurrent, proposedReuseFloor: _oldReuse, ...counts } = diagnostic;
    console.log(
      'definition-publication-work A-only growth',
      JSON.stringify({ added, analysisMax: PROPOSED_ANALYSIS_MAX, ...counts }),
    );
    if (added === 64 || added === 512) expect(diagnostic.newSteps).toBeLessThan(PROPOSED_ANALYSIS_MAX);
    else expect(diagnostic.newSteps).toBeGreaterThan(PROPOSED_ANALYSIS_MAX);
  }
}, 180_000);
