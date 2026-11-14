import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { KernelDependencies } from '../../src/http/kernel.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { ContentShelfTitleInputs } from '../../src/library/shelf-title-content-source.ts';
import { createSemanticTitleInputsAdapter } from '../../src/semantic/adapters/title-inputs.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

const emptyShelfTitleInputs: ContentShelfTitleInputs = {
  async observe() {
    return { status: 'current', version: 'empty-shelf-title-test-v1', entries: [] };
  },
};

const composeWithEmptyShelfTitleInputs: typeof createKernel = (dependencies: KernelDependencies) =>
  createKernel({
    ...dependencies,
    content: { ...dependencies.content, shelfTitleInputs: emptyShelfTitleInputs } as NonNullable<
      KernelDependencies['content']
    >,
  });

let driver: SemanticOutcomeDriver;

beforeAll(async () => {
  driver = await createSemanticDriver(composeWithEmptyShelfTitleInputs);
});

afterAll(async () => {
  await driver?.close();
});

async function currentBasis(subjects: readonly string[] = []) {
  const observed = await createSemanticTitleInputsAdapter(driver.fixtures.pool).observe({
    subjects,
    deadline: Date.now() + 10_000,
  });
  if (observed.status !== 'current') throw new Error('Expected a current native Semantic title basis');
  return observed.basis;
}

test('an unrequested Semantic visibility write retires the basis while real empty-shelf preparation preserves it', async () => {
  await driver.fixtures.openFeatures(['personal_library']);
  const shelfOwner = await driver.fixtures.person('title-input-shelf-owner', { scopes: ['library_entry:list'] });
  const created = await driver.request(
    'editor',
    'POST',
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: `Title basis ${randomUUID()}` } },
    { 'Idempotency-Key': `"${randomUUID()}"` },
  );
  expect(created.status).toBe(201);
  const subjectId = (created.body.subject as { id: string }).id;
  const subjectRoute = routeOf(subjectId)!;
  const sourceHome = partitionOf(subjectRoute);
  const before = await currentBasis();
  expect(await currentBasis([subjectId])).toBe(before);
  const revisionBefore = (
    await driver.fixtures.pool.query<{ revision: string }>(
      'SELECT revision::text FROM semantic.title_input_home_revision WHERE partition_no=$1',
      [sourceHome],
    )
  ).rows[0]!.revision;

  const shelfHome = partitionOf(routeOf(shelfOwner.accountId)!);
  const priorPosition = (
    await driver.fixtures.pool.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no=$1',
      [shelfHome],
    )
  ).rows[0]!.position;
  const prepared = await driver.fixtures.send(shelfOwner, 'POST', '/v1/libraryShelfTitlePreparation', undefined, {
    'Accept-Language': 'en',
    'Idempotency-Key': `"${randomUUID()}"`,
  });
  expect(prepared.status).toBe(200);
  expect(prepared.body).toMatchObject({ installation: 'pending', prepared: 0 });
  expect(
    (
      await driver.fixtures.pool.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no=$1',
        [shelfHome],
      )
    ).rows[0]!.position,
  ).not.toBe(priorPosition);
  expect(await currentBasis()).toBe(before);
  expect(
    (
      await driver.fixtures.pool.query<{ revision: string }>(
        'SELECT revision::text FROM semantic.title_input_home_revision WHERE partition_no=$1',
        [sourceHome],
      )
    ).rows[0]!.revision,
  ).toBe(revisionBefore);

  const hidden = await driver.fixtures.pool.query(
    `UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1
     WHERE route=$1 AND subject_id=$2 AND visibility='visible'`,
    [subjectRoute, subjectId],
  );
  expect(hidden.rowCount).toBe(1);
  expect(
    (
      await driver.fixtures.pool.query<{ revision: string }>(
        'SELECT revision::text FROM semantic.title_input_home_revision WHERE partition_no=$1',
        [sourceHome],
      )
    ).rows[0]!.revision,
  ).not.toBe(revisionBefore);
  expect(await currentBasis()).not.toBe(before);
});
