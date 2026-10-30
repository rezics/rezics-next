import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  RELEASE_LIMITS,
  releaseAdmission,
  releaseDigest,
  validateRelease,
  valueSchema,
} from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { analyzePattern } from '../../../../packages/definitions/src/pattern-safety.ts';
import { constructionFixture } from '../../../../packages/definitions/test/support/publication-construction.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';
import {
  canonicalBytes,
  effectsSnapshot,
  PROPOSED_ANALYSIS_MAX,
  publicationFixture,
  workDiagnostic,
} from './support/definition-publication-work.ts';

// Post-integration native acceptance. No injected checker, budget, Access or
// execution port: an absent aggregate producer must fail at its HTTP outcome.
let driver: SemanticOutcomeDriver;
type Author = Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
let author: Author;
const key = () => ({ 'Idempotency-Key': JSON.stringify(randomUUID()) });
const publish = (release: unknown, headers = key(), account = author) =>
  driver.fixtures.send(account, 'POST', '/v1/definitions/releases', { release }, headers);

beforeAll(async () => {
  driver = await createSemanticDriver();
  await driver.projection('paused');
  author = await driver.fixtures.person('publication-resource-author');
  await driver.fixtures.grantAccount(author, ['definitions:publish', 'gate:definition_publication']);
}, 180_000);
afterAll(async () => {
  await driver?.close();
});

async function refusal(release: unknown, status: 400 | 422, errors: { pointer: string; code: string }[]) {
  const before = await effectsSnapshot(driver.fixtures.pool);
  const response = await publish(release);
  // Snapshot contents include partition updates, not merely inserted row counts.
  const after = await effectsSnapshot(driver.fixtures.pool);
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.body).toMatchObject({
    code: status === 400 ? 'invalid_request' : 'definition_work_exceeded',
    retryable: false,
    effect_status: 'not_applied',
  });
  expect(response.body.errors).toEqual(errors);
  expect(response.headers.has('retry-after')).toBe(false);
  expect(after).toEqual(before);
}

test('native cold publication keeps gate, body identity, replay, new-key, conflict and current denial outcomes', async () => {
  const account = await driver.fixtures.person('publication-resource-replay');
  await driver.fixtures.grantAccount(account, ['definitions:publish']);
  const release = publicationFixture();
  const headers = key();
  const closedBefore = await effectsSnapshot(driver.fixtures.pool);
  const closed = await publish(release, headers, account);
  expect(closed.status, JSON.stringify(closed.body)).toBe(403);
  expect(closed.body.code).toBe('platform_closed');
  expect(closed.body).not.toHaveProperty('digest');
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(closedBefore);

  await driver.fixtures.grantAccount(account, ['gate:definition_publication']);
  expect(validateRelease(release)).toEqual([]);
  const before = await effectsSnapshot(driver.fixtures.pool);
  const first = await publish(release, headers, account);
  const digest = releaseDigest(release);
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toEqual({ digest });
  const applied = await effectsSnapshot(driver.fixtures.pool);
  for (const table of ['semantic.definition_release', 'core.receipt', 'core.outbox', 'editorial.write_basis'])
    expect((applied[table] as unknown[]).length - (before[table] as unknown[]).length, table).toBe(1);
  const read = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${digest}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body).toEqual({ digest, release });
  expect(read.headers.get('etag')).toBe(JSON.stringify(digest));
  const replay = await publish(release, headers, account);
  expect(replay.status, JSON.stringify(replay.body)).toBe(201);
  expect(replay.body).toEqual(first.body);
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(applied);
  const existing = await publish(release, key(), account);
  expect(existing.status, JSON.stringify(existing.body)).toBe(200);
  expect(existing.body).toEqual({ digest });
  const bookkeeping = await effectsSnapshot(driver.fixtures.pool);
  expect(bookkeeping['semantic.definition_release']).toEqual(applied['semantic.definition_release']);
  for (const table of ['core.receipt', 'core.outbox', 'editorial.write_basis'])
    expect((bookkeeping[table] as unknown[]).length - (applied[table] as unknown[]).length, table).toBe(1);
  const changed = structuredClone(release);
  changed.catalogue.version += '-conflict';
  const conflict = await publish(changed, headers, account);
  expect(conflict.status, JSON.stringify(conflict.body)).toBe(422);
  expect(conflict.body).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(bookkeeping);

  const revoked = await driver.fixtures.send(account, 'POST', '/v1/grants:revoke', {
    resource: { route: 0, id: driver.globalContext },
    subject: { kind: 'account', id: account.accountId },
    actions: ['definitions:publish'],
    valid: '(,)',
  }, key());
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  const deniedBefore = await effectsSnapshot(driver.fixtures.pool);
  const denied = await publish(release, headers, account);
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect(denied.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(denied.body).not.toHaveProperty('digest');
  expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(deniedBefore);
}, 180_000);

test('a valid body at the existing canonical byte boundary is published unchanged', async () => {
  const release = publicationFixture(0);
  release.generator.version = '';
  release.generator.version = 'x'.repeat(RELEASE_LIMITS.bytes - canonicalBytes(release));
  expect(canonicalBytes(release)).toBe(RELEASE_LIMITS.bytes);
  expect(releaseAdmission(release)).toEqual([]);
  expect(validateRelease(release)).toEqual([]);
  const created = await publish(release);
  const digest = releaseDigest(release);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body).toEqual({ digest });
  const read = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${digest}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body).toEqual({ digest, release });
  expect(read.headers.get('etag')).toBe(JSON.stringify(digest));
  release.generator.version += 'x';
  await refusal(release, 400, [{ pointer: '/release', code: 'out_of_range' }]);
}, 180_000);

for (const count of [64, 512, 4096])
  test(`duplicate-heavy admitted body retains native schema refusal at ${count} members`, async () => {
    const release = constructionFixture();
    release.types['grow:Root']!.bases = Array(count).fill('schema:Thing');
    expect(releaseAdmission(release)).toEqual([]);
    await refusal(release, 400, [{ pointer: '/release/types/grow:Root/bases', code: 'invalid_format' }]);
  }, 180_000);

test('dense invalid values and cheap collection/schema faults refuse before aggregate analysis', async () => {
  const dense = publicationFixture(1);
  dense.properties['work:p0000']!.value = { enum: Array(64 * 1024).fill(0) };
  expect(releaseAdmission(dense)).toEqual([]);
  await refusal(dense, 400, [{ pointer: '/release/properties/work:p0000/value', code: 'invalid_format' }]);

  const excess = publicationFixture(RELEASE_LIMITS.properties - Object.keys(bundledRelease.properties).length);
  expect(validateRelease(excess)).toEqual([]);
  const limited = structuredClone(excess);
  limited.types['work:Sample0']!.properties = Array(65).fill('work:p0000');
  await refusal(limited, 400, [{ pointer: '/release/types/work:Sample0/properties', code: 'out_of_range' }]);
  await refusal({ ...excess, unexpected: true }, 400, [{ pointer: '/release/unexpected', code: 'invalid_format' }]);
  // The valid body is intentionally red until the real aggregate producer lands.
  await refusal(excess, 422, [{ pointer: '/release', code: 'out_of_range' }]);
}, 180_000);

const defects = [
  { source: '^(a+)+$', steps: 156 },
  { source: '^[ab]{32}a[ab]*$', steps: 8193 },
  { source: '^[ab]*a[ab]{32}$', steps: 457 },
] as const;

for (const { source, steps } of defects)
  test(`native hostile checker outcome remains unsafe for ${source}`, async () => {
    expect(analyzePattern(source)).toEqual({ safe: false, steps });
    const release = publicationFixture(1);
    release.properties['work:p0000']!.value = valueSchema('string', { pattern: source });
    await refusal(release, 400, [{ pointer: '/release/properties/work:p0000/value/pattern', code: 'invalid_format' }]);
  }, 180_000);

// Preserve the package's observed literal/checker schedules in a full-catalogue
// HTTP body. These diagnostics only build input; no count is passed to production.
// Include current nonfixed catalogue sources preceding the defect, rather than
// assuming the catalogue's contribution is zero or dropping its entries.
let catalogueProofs: ReturnType<typeof workDiagnostic>['proofs'] | undefined;
function tieFixture(source: string, steps: number, delta: -1 | 0 | 1) {
  catalogueProofs ??= workDiagnostic(publicationFixture(0)).proofs;
  const preceding = catalogueProofs.filter((proof) => !proof.fixed && proof.source < source);
  expect(preceding.every((proof) => proof.safe)).toBe(true);
  const catalogueSteps = preceding.reduce((sum, proof) => sum + proof.steps, 0);
  const prefixTarget = PROPOSED_ANALYSIS_MAX - steps + delta;
  const needed = prefixTarget - catalogueSteps;
  const singles = ['!', '"', '#', '%', '&', ',', '-', '/', ':'];
  const singleCount = singles.findIndex((_, count) => needed >= 4 * count && (needed - 4 * count) % 9 === 0);
  expect(singleCount).toBeGreaterThanOrEqual(0);
  const sources = [
    ...singles.slice(0, singleCount),
    ...Array.from({ length: (needed - 4 * singleCount) / 9 }, (_, i) => `!${String(i).padStart(4, '0')}`),
    source,
  ];
  expect(sources.every((item, i) => i === sources.length - 1 || item < source)).toBe(true);
  expect(new Set(sources).size).toBe(sources.length);
  expect(analyzePattern('!')).toEqual({ safe: true, steps: 4 });
  expect(analyzePattern('!0000')).toEqual({ safe: true, steps: 9 });
  const release = publicationFixture(sources.length);
  sources.forEach((pattern, i) => {
    release.properties[`work:p${String(i).padStart(4, '0')}`]!.value = valueSchema('string', { pattern });
  });
  expect(releaseAdmission(release)).toEqual([]);
  expect(canonicalBytes(release)).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
  expect(Object.keys(release.properties).length).toBeLessThanOrEqual(RELEASE_LIMITS.properties);
  const actual = workDiagnostic(release).proofs.filter((proof) => !proof.fixed && proof.source <= source);
  expect(actual.reduce((sum, proof) => sum + proof.steps, 0)).toBe(PROPOSED_ANALYSIS_MAX + delta);
  return { release, pointer: `/release/properties/work:p${String(sources.length - 1).padStart(4, '0')}/value/pattern` };
}

for (const { source, steps } of defects)
  for (const delta of [-1, 0, 1] as const)
    test(`native same-pattern defect/excess tie for ${source} at proposed allowance ${delta >= 0 ? '+' : ''}${delta}`, async () => {
      const { release, pointer } = tieFixture(source, steps, delta);
      await refusal(release, delta > 0 ? 422 : 400, [
        { pointer: delta > 0 ? '/release' : pointer, code: delta > 0 ? 'out_of_range' : 'invalid_format' },
      ]);
    }, 180_000);
