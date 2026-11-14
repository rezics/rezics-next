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
const idempotency = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });

beforeAll(async () => {
  driver = await createSemanticDriver(composeWithEmptyShelfTitleInputs, { originalCapabilities: true });
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

async function createSubject(label: string): Promise<string> {
  const created = await driver.request(
    'editor',
    'POST',
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: label } },
    idempotency(),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body.subject as { id: string }).id;
}

async function currentTitle(subjectId: string) {
  const observed = await createSemanticTitleInputsAdapter(driver.fixtures.pool).observe({
    subjects: [subjectId],
    deadline: Date.now() + 10_000,
  });
  if (observed.status !== 'current') throw new Error('Expected current native Semantic title inputs');
  return observed;
}

async function titleClock(): Promise<Map<number, bigint>> {
  const result = await driver.fixtures.pool.query<{ partitionNo: number; revision: string }>(
    'SELECT partition_no AS "partitionNo", revision::text AS revision FROM semantic.title_input_home_revision',
  );
  return new Map(result.rows.map((row) => [row.partitionNo, BigInt(row.revision)]));
}

test('native title currentness follows term and original-language writers', async () => {
  const subjectId = await createSubject(`Title input ${randomUUID()}`);
  const beforeTitle = await currentTitle(subjectId);
  expect(beforeTitle.entries[0]).toMatchObject({ subjectId, labels: { en: expect.any(String) } });

  const changedTitle = await driver.request(
    'editor',
    'PATCH',
    `/v1/subjects/${subjectId}/terms`,
    { labels: { en: 'Updated title input' } },
    { ...idempotency(), 'If-Match': '"1"' },
  );
  expect(changedTitle.status, JSON.stringify(changedTitle.body)).toBe(200);
  const afterTitle = await currentTitle(subjectId);
  expect(afterTitle.basis).not.toBe(beforeTitle.basis);
  expect(afterTitle.entries[0]).toMatchObject({ labels: { en: 'Updated title input' } });

  const proposal = await driver.request(
    'editor',
    'POST',
    `/v1/subjects/${subjectId}/candidates`,
    {
      statement: {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'ja' },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.org/title-inputs' },
              },
            ],
          },
        ],
      },
    },
    idempotency(),
  );
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  const candidateId = proposal.body.candidate as string;
  const accepted = await driver.request(
    'acceptor',
    'POST',
    `/v1/subjects/${subjectId}/candidates/${candidateId}:accept`,
    { context: driver.globalContext, expected_head: null },
    idempotency(),
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const adopted = await driver.request(
    'acceptor',
    'POST',
    `/v1/subjects/${subjectId}:adopt`,
    {
      context: driver.globalContext,
      property: 'schema:inLanguage',
      mode: 'replace',
      selection: [{ candidate: candidateId, rank: 'normal' }],
      expected_head: null,
    },
    idempotency(),
  );
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
  const afterLanguage = await currentTitle(subjectId);
  expect(afterLanguage.basis).not.toBe(afterTitle.basis);
  expect(afterLanguage.entries[0]).toMatchObject({ originalLanguage: 'ja' });
});

test('native identity birth, control-home changes and redirects retire title currentness', async () => {
  const beforeBirth = await titleClock();
  const identity = await createSubject(`Redirected title ${randomUUID()}`);
  const identityRoute = routeOf(identity)!;
  const sourceHome = partitionOf(identityRoute);
  const mapping = await driver.fixtures.pool.query<{ controlHome: number }>(
    `SELECT control_partition AS "controlHome" FROM semantic.identity_epoch_mapping
     WHERE route=$1 AND original=$2`,
    [identityRoute, identity],
  );
  expect(mapping.rows).toHaveLength(1);
  const afterBirth = await titleClock();
  const controlHome = mapping.rows[0]!.controlHome;
  expect(afterBirth.get(sourceHome)!).toBeGreaterThan(beforeBirth.get(sourceHome)!);
  expect(afterBirth.get(controlHome)!).toBeGreaterThan(beforeBirth.get(controlHome)!);

  const nextControlHome = (controlHome + 1) % 4096;
  const beforeControlMove = await titleClock();
  const beforeControlBasis = await currentBasis();
  try {
    const moved = await driver.fixtures.pool.query(
      `UPDATE semantic.identity_epoch_mapping SET control_partition=$3 WHERE route=$1 AND original=$2
       RETURNING control_partition`,
      [identityRoute, identity, nextControlHome],
    );
    expect(moved.rowCount).toBe(1);
    expect(await currentBasis()).not.toBe(beforeControlBasis);
    const afterControlMove = await titleClock();
    for (const home of new Set([sourceHome, controlHome, nextControlHome]))
      expect(afterControlMove.get(home)!).toBeGreaterThan(beforeControlMove.get(home)!);
  } finally {
    await driver.fixtures.pool.query(
      'UPDATE semantic.identity_epoch_mapping SET control_partition=$3 WHERE route=$1 AND original=$2',
      [identityRoute, identity, controlHome],
    );
  }

  const survivor = await createSubject(`Surviving title ${randomUUID()}`);
  const beforeMerge = await currentBasis();
  const [redirected, kept] = [identity, survivor].sort();
  const merged = await driver.request(
    'acceptor',
    'POST',
    '/v1/subjects:merge',
    { subjects: [redirected, kept] },
    idempotency(),
  );
  expect(merged.status, JSON.stringify(merged.body)).toBe(202);
  const operationId = (merged.body.operation as { id: string }).id;
  const completion = await driver.advanceIdentityOperation(operationId);
  expect(completion.status, JSON.stringify(completion.body)).toBe(200);
  expect(completion.body.operation).toMatchObject({
    id: operationId,
    done: true,
    result: { survivor: kept, redirected },
  });
  expect(await currentBasis()).not.toBe(beforeMerge);

  const redirectRow = await driver.fixtures.pool.query<{ terminal: string }>(
    'SELECT target::text AS terminal FROM semantic.redirect WHERE subject_id=$1',
    [redirected],
  );
  expect(redirectRow.rows).toHaveLength(1);
  const observed = await currentTitle(redirected);
  expect(observed.entries[0]).toMatchObject({ subjectId: redirected, sourceId: redirectRow.rows[0]!.terminal });
});

test('native lifecycle and owner-tuple writes retire the complete title basis', async () => {
  const owner = await driver.fixtures.person(`title-input-lifecycle-${randomUUID()}`);
  await driver.fixtures.grantAccount(owner, ['statement:delete'], driver.globalContext);
  const created = await driver.fixtures.send(
    owner,
    'POST',
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: 'Lifecycle title input' } },
    idempotency(),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const subjectId = (created.body.subject as { id: string }).id;
  const proposal = await driver.fixtures.send(
    owner,
    'POST',
    `/v1/subjects/${subjectId}/candidates`,
    {
      statement: {
        property: { id: 'schema:url' },
        value: { type: 'value', content: `https://example.org/lifecycle/${randomUUID()}` },
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } },
            ],
          },
        ],
      },
    },
    idempotency(),
  );
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  const candidateId = proposal.body.candidate as string;
  const beforeDelete = await currentBasis();
  const deleted = await driver.fixtures.send(
    owner,
    'DELETE',
    `/v1/subjects/${subjectId}/candidates/${candidateId}`,
    undefined,
    idempotency(),
  );
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect(deleted.body).toMatchObject({ subject: subjectId, candidate: candidateId, deleted: true });
  expect(await currentBasis()).not.toBe(beforeDelete);

  const home = 4095;
  const originalOwner = await driver.fixtures.pool.query<{ node: string }>(
    'SELECT node FROM core.partition WHERE partition_no=$1',
    [home],
  );
  expect(originalOwner.rows).toHaveLength(1);
  const originalNode = originalOwner.rows[0]!.node;
  const beforeOwnerChange = await currentBasis();
  await driver.fixtures.pool.query('UPDATE core.partition SET node=$2 WHERE partition_no=$1', [
    home,
    `${originalNode}-title-input-test`,
  ]);
  try {
    expect(await currentBasis()).not.toBe(beforeOwnerChange);
  } finally {
    await driver.fixtures.pool.query('UPDATE core.partition SET node=$2 WHERE partition_no=$1', [home, originalNode]);
  }
  expect(await currentBasis()).toBe(beforeOwnerChange);
});

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
