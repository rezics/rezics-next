import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createAccess } from '../../src/access/index.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { AccountActor, Access } from '../../src/request/access.ts';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { readViewerFactsPage, prepareViewerFacts, viewerFactsCurrent } from '../../src/library/viewer-facts.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x6d41;
const routeKey = new Uint8Array(32).fill(73);
const ownerId = newId(route);
const otherId = newId(route);
const actor = (accountId: string): AccountActor => ({
  kind: 'account',
  accountId,
  clientId: 'viewer-facts',
  scopes: ['library_entry:read', 'library_entry:list', 'rating:vote'],
  requestedBy: null,
  authnEpoch: 1,
});
const mergeAuthorization: CommandAuthorization = {
  action: 'subject:merge',
  resource: { route: 0, id: GLOBAL_CONTEXT },
  denied: () => new Error('Subject merge denied'),
  async authorize() {
    return 'execute';
  },
};

let database: GrowthDatabase;
let access: Access;

beforeAll(async () => {
  database = await openGrowthDatabase();
  const auth = {
    issuer: 'https://viewer-facts.example.test',
    audience: 'https://api.rezics.test',
    jwksUrl: 'https://viewer-facts.example.test/jwks',
    fetch: async () => Response.json({ keys: [] }),
  };
  access = createAccess({ actions: new Map(), auth });
  for (const accountId of [ownerId, otherId])
    await database.admin.query(
      `INSERT INTO access.account
       (route,account_id,kind,state,transaction_id,authn_fenced,minimum_authn_epoch,membership_inverse_complete)
       VALUES ($1,$2,'actor','active',$2,false,1,true)`,
      [routeOf(accountId), accountId],
    );
  await bootstrapRelease(database.pool, bundledRelease);
  await bootstrapGovernance(database.pool, ownerId);
});

afterAll(async () => {
  await database?.close();
});

async function makeSubject(label: string): Promise<string> {
  const key = randomUUID();
  const created = await createSubject(database.pool, {
    actor: actor(ownerId),
    target: subjectTarget(routeKey, ownerId, key),
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return created.subject.id;
}

async function putEntry(accountId: string, subjectId: string, state: string, revision: number) {
  await database.admin.query(
    `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,incarnation_id)
     VALUES($1,$2,$3,$4,$5,now(),now(),$6,$7)
     ON CONFLICT(route,account_id,subject_id) DO UPDATE SET state=EXCLUDED.state,revision=EXCLUDED.revision,updated_at=now()`,
    [routeOf(accountId), accountId, subjectId, state, revision, randomUUID(), randomUUID()],
  );
}

async function putVote(voterId: string, targetId: string, countedTarget: string, units: number | null, revision = 1) {
  await database.admin.query(
    `INSERT INTO rating.vote(route,voter_id,question_id,target_id,units,revision,changed_at,transaction_id,counted_target)
     VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8)`,
    [routeOf(voterId), voterId, STANDARD_QUESTION_ID, targetId, units, revision, randomUUID(), countedTarget],
  );
}

test('bounded viewer facts keep page identity and current private state, vote and authority', async () => {
  const [first, alias, second, absent] = await Promise.all([
    makeSubject('zero score subject'),
    makeSubject('merged subject alias'),
    makeSubject('nonzero score subject'),
    makeSubject('absent subject'),
  ]);
  await mergeSubjects(database.pool, {
    subjects: [alias!, first!],
    survivor: first!,
    actor: actor(ownerId),
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(randomUUID()).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: mergeAuthorization,
    deadline: Date.now() + 30_000,
  });
  await putEntry(ownerId, first!, 'planned', 1);
  await putEntry(ownerId, second!, 'completed', 1);
  await putVote(ownerId, alias!, first!, 0);
  await putVote(ownerId, second!, second!, 12);
  await putVote(otherId, alias!, first!, 20);

  const owner = actor(ownerId);
  const firstPage = await readViewerFactsPage(
    { pool: database.pool, access },
    owner,
    [
      { rowKey: 'first-result', subjectId: alias! },
      { rowKey: 'same-subject-second-row', subjectId: alias! },
    ],
    STANDARD_QUESTION_ID,
    Date.now() + 30_000,
  );
  expect(firstPage).toMatchObject({
    state: 'current',
    rows: [
      {
        rowKey: 'first-result',
        subjectId: alias,
        entry: { state: 'present', entryState: 'planned', revision: 1 },
        vote: { state: 'present', questionId: STANDARD_QUESTION_ID, units: 0, revision: 1 },
      },
      { rowKey: 'same-subject-second-row', subjectId: alias, vote: { units: 0 } },
    ],
  });

  const reads = createCollectionReads({
    pool: database.pool,
    access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
  });
  const collectionPage = await reads.withViewerFacts(
    owner,
    { members: [{ id: 'admitted-member', subjectId: alias! }], next: null },
    Date.now() + 30_000,
  );
  expect(collectionPage).toMatchObject({
    members: [{ id: 'admitted-member', subjectId: alias }],
    viewerFacts: { state: 'current', rows: [{ rowKey: 'admitted-member', vote: { units: 0 } }] },
  });

  const secondPage = await readViewerFactsPage(
    { pool: database.pool, access },
    owner,
    [{ rowKey: 'second-result', subjectId: second! }],
    STANDARD_QUESTION_ID,
    Date.now() + 30_000,
  );
  expect(secondPage).toMatchObject({
    state: 'current',
    rows: [
      {
        rowKey: 'second-result',
        entry: { state: 'present', entryState: 'completed', revision: 1 },
        vote: { state: 'present', units: 12, revision: 1 },
      },
    ],
  });

  const foreignPage = await readViewerFactsPage(
    { pool: database.pool, access },
    actor(otherId),
    [{ rowKey: 'foreign-result', subjectId: alias! }],
    STANDARD_QUESTION_ID,
    Date.now() + 30_000,
  );
  expect(foreignPage).toMatchObject({
    state: 'current',
    rows: [{ entry: { state: 'absent' }, vote: { state: 'absent', questionId: STANDARD_QUESTION_ID } }],
  });

  const absentPage = await readViewerFactsPage(
    { pool: database.pool, access },
    owner,
    [{ rowKey: 'missing', subjectId: absent! }],
    STANDARD_QUESTION_ID,
    Date.now() + 30_000,
  );
  expect(absentPage).toMatchObject({ state: 'current', rows: [{ entry: { state: 'absent' }, vote: { state: 'absent' } }] });

  await database.admin.query(`UPDATE library.entry SET state='paused',revision=2 WHERE account_id=$1 AND subject_id=$2`, [ownerId, first]);
  await database.admin.query(`UPDATE rating.vote SET units=NULL,revision=2 WHERE voter_id=$1 AND target_id=$2`, [ownerId, alias]);
  const changed = await readViewerFactsPage(
    { pool: database.pool, access },
    owner,
    [{ rowKey: 'first-result', subjectId: alias! }],
    STANDARD_QUESTION_ID,
    Date.now() + 30_000,
  );
  expect(changed).toMatchObject({
    state: 'current',
    rows: [{ entry: { state: 'present', entryState: 'paused', revision: 2 }, vote: { state: 'absent' } }],
  });

  const prepared = await prepareViewerFacts(
    { pool: database.pool, access },
    owner,
    [{ rowKey: 'first-result', subjectId: alias! }],
    STANDARD_QUESTION_ID,
    Date.now() + 30_000,
  );
  await expect(
    prepareViewerFacts(
      { pool: database.pool, access },
      owner,
      Array.from({ length: 101 }, (_, index) => ({ rowKey: String(index), subjectId: alias! })),
      STANDARD_QUESTION_ID,
      Date.now() + 30_000,
    ),
  ).rejects.toThrow('at most 100 rows');
  await database.admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE account_id=$1', [ownerId]);
  expect(await viewerFactsCurrent({ pool: database.pool, access }, owner, prepared, Date.now() + 30_000)).toBe(false);
});
