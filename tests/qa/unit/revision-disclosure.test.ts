import { expect, test } from 'bun:test';
import { readExactContributionDraft } from '../../../services/main/src/modules/contribution/history.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { readExactMainRevision, readExactWorkRevision, RevisionCorrupt, RevisionNotFound }
  from '../../../services/main/src/modules/work/history.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const anotherWork = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const mainVersion = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000005';

function fixture(rows: Record<string, { value: string }>[]) {
  let queries = 0;
  const env = { fuseki: { query: async () => {
    queries += 1;
    return { results: { bindings: rows } };
  } } } as unknown as WorkActivationEnvironment;
  return { env, queryCount: () => queries };
}

test('WORK02: ambiguous MainVersion anchor is concealed until Work authorization', async () => {
  const { env } = fixture([{ work: { value: work } }, { work: { value: work } }]);
  await expect(readExactMainRevision(env, mainVersion, revision, async () => false))
    .rejects.toBeInstanceOf(RevisionNotFound);
  await expect(readExactMainRevision(env, mainVersion, revision, async () => true))
    .rejects.toBeInstanceOf(RevisionCorrupt);
});

test('WORK02: conflicting MainVersion owners are concealed without choosing one authority', async () => {
  const { env } = fixture([{ work: { value: work } }, { work: { value: anotherWork } }]);
  let authorizationCalls = 0;
  await expect(readExactMainRevision(env, mainVersion, revision, async () => {
    authorizationCalls += 1;
    return true;
  })).rejects.toBeInstanceOf(RevisionNotFound);
  expect(authorizationCalls).toBe(0);
});

test('WORK02: ambiguous Work anchor is concealed until Work authorization', async () => {
  const { env } = fixture([{ work: { value: work } }, { work: { value: work } }]);
  await expect(readExactWorkRevision(env, revision, async () => false))
    .rejects.toBeInstanceOf(RevisionNotFound);
  await expect(readExactWorkRevision(env, revision, async () => true))
    .rejects.toBeInstanceOf(RevisionCorrupt);
});

test('WORK02: private draft revision never queries the anchor before authorization', async () => {
  const { env, queryCount } = fixture([{ component: { value: contribution } },
    { component: { value: contribution } }]);
  await expect(readExactContributionDraft(env, contribution, revision, async () => false))
    .rejects.toBeInstanceOf(RevisionNotFound);
  expect(queryCount()).toBe(0);
  await expect(readExactContributionDraft(env, contribution, revision, async () => true))
    .rejects.toBeInstanceOf(RevisionCorrupt);
  expect(queryCount()).toBe(1);
});
