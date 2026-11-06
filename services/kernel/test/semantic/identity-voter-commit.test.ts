import { expect, test } from 'bun:test';
import { composeLibraryDomain } from '../../src/composition/library.ts';
import { noEffect, runCommand, withSingleCommandAttempt } from '../../src/command/command.ts';
import type { Pool, PoolClient } from 'pg';
import lockOwner from '../../src/semantic/identity-rating-commit-participant-lock-owner.sql';
import { randomUUID } from 'node:crypto';
import { createProfileEntryFixture } from '../library/support/profile-entry-fixture.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { STANDARD_QUESTION_ID, createVoteCommands } from '../../src/rating/votes.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { withConnection } from '../../src/database/pool.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { drainIdentityTerminalClosure } from '../../src/semantic/identity-terminal-closure.ts';
import { stepLibraryIdentityEpoch } from '../../src/library/identity-epoch-participant.ts';
import { identityEpochStore, identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import type { IdentityJobRef } from '../../src/semantic/identity-epoch-contract.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readIdentityRatingReview } from '../../src/semantic/identity-adapters/read.ts';
import { createIdentityRatingCommitParticipant } from '../../src/semantic/identity-rating-commit-participant.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';
import { digest, identityEpochDatabase, release } from './support/identity-epoch.ts';

composeLibraryDomain();

async function reviewedSelf(f: Awaited<ReturnType<typeof createIdentityMappingFixture>>, route: number) {
  const subjectId = (await f.create('Rating reviewed identity', route)).subject.id;
  await f.bootstrapHomes([subjectId]);
  const review = await readIdentityRatingReview(f.pool, {
    requestedOriginalId: subjectId,
    canonicalTerminalId: subjectId,
    deadline: Date.now() + 5000,
  });
  if (review.state !== 'reviewed') throw new Error(`Expected a reviewed self mapping, received ${review.state}`);
  return { subjectId, operand: review.operand, home: partitionOf(routeOf(subjectId)!) };
}

test('reviewed identity admission returns the native owner and published head and holds the owner fence through commit', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 2 });
  try {
    const selected = await reviewedSelf(f, 0x5d10);
    const participant = createIdentityRatingCommitParticipant();
    const prepared = participant.prepare(selected.operand);
    let releaseCommand!: () => void;
    let admitted!: (held: Awaited<ReturnType<typeof participant.admit>>) => void;
    const commandBarrier = new Promise<void>((resolve) => (releaseCommand = resolve));
    const admission = new Promise<Awaited<ReturnType<typeof participant.admit>>>((resolve) => (admitted = resolve));
    const command = runCommand(f.pool, { partition: selected.home, deadline: Date.now() + 10_000 }, async (tx) => {
      const held = await participant.admit(tx, prepared);
      admitted(held);
      await commandBarrier;
      return noEffect(held);
    });
    const held = await admission;
    const expectedOwner = (
      await f.admin.query('SELECT node,epoch FROM core.partition WHERE partition_no=$1', [selected.home])
    ).rows[0]!;
    const expectedHead = (
      await f.admin.query(
        'SELECT published_epoch FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2',
        [selected.home, selected.subjectId],
      )
    ).rows[0]!;
    expect(held).toEqual({
      ownerId: expectedOwner.node,
      ownerEpoch: expectedOwner.epoch,
      partition: selected.home,
      subjectId: selected.subjectId,
      publishedHeads: [
        { partition: selected.home, group: selected.subjectId, epoch: String(expectedHead.published_epoch) },
      ],
    });

    const writer = await f.admin.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        writer.query('UPDATE core.partition SET position=position+1 WHERE partition_no=$1', [selected.home]),
      ).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
      releaseCommand();
      expect((await command).value).toEqual(held);
      const afterCommit = await writer.query(
        'UPDATE core.partition SET position=position+1 WHERE partition_no=$1 RETURNING partition_no',
        [selected.home],
      );
      expect(afterCommit.rowCount).toBe(1);
    } finally {
      releaseCommand();
      writer.release();
    }
  } finally {
    await f.close();
  }
}, 180_000);

async function localRatingSubject(f: Awaited<ReturnType<typeof createProfileEntryFixture>>, label: string) {
  const key = randomUUID();
  const requested = (
    await createSubject(f.pool, {
      actor: f.owner.actor,
      target: { route: 1, id: newId(1) },
      item: { type: 'ex:Child', labels: { en: label } },
      idempotencyKey: key,
      digest: digest(key),
      release: { digest: f.originalDigest, release: f.original },
      authorization: await accessCommandAuthorization(
        f.access,
        f.owner.actor,
        'subject:create',
        { route: 0, id: GLOBAL_CONTEXT },
        { pool: f.pool, deadline: Date.now() + 5000 },
        () => new Error('Native Subject creation denied'),
      ),
    })
  ).subject.id;
  const sourceHome = partitionOf(routeOf(requested)!);
  for (let n = 0; n < 1000; n++) {
    if ((await stepIdentityEpochBootstrap(f.pool, sourceHome)).state === 'caught-up') break;
    if (n === 999) throw new Error('Provider source bootstrap did not finish');
  }
  return { requested, sourceHome };
}

async function grantStewardMerge(f: Awaited<ReturnType<typeof createProfileEntryFixture>>) {
  const { installIdentityGrants } = await import('../support/trusted-grants.ts');
  await installIdentityGrants(f.pool, GLOBAL_CONTEXT, f.steward.actor.accountId, ['subject:merge']);
}

async function admitSameHomeMerge(
  f: Awaited<ReturnType<typeof createProfileEntryFixture>>,
  redirected: string,
  survivor: string,
): Promise<IdentityJobRef> {
  const key = randomUUID();
  const job = await identityEpochStore().prepareAdmission(
    f.pool,
    {
      basis: {
        actorAccountId: f.steward.actor.accountId,
        clientId: f.steward.actor.clientId,
        requestedBy: f.steward.actor.requestedBy,
      },
      authorization: await accessCommandAuthorization(
        f.access,
        f.steward.actor,
        'subject:merge',
        { route: 0, id: GLOBAL_CONTEXT },
        { pool: f.pool, deadline: Date.now() + 5000 },
        () => new Error('Native merge denied'),
      ),
    },
    {
      intent: { kind: 'merge', redirected, survivor, release: f.originalDigest },
      receipt: {
        kind: 'subject.merge',
        command: {
          actorAccountId: f.steward.actor.accountId,
          kind: 'subject.merge',
          key,
          digest: digest(key),
        },
      },
    },
  );
  for (let attempt = 0; attempt < 16; attempt++) {
    const progress = await stepIdentityEpochAdmission(f.pool, job);
    if (progress.state === 'pending') return job;
  }
  throw new Error('Native admission did not finish within sixteen bounded steps');
}

async function drainMapping(pool: Pool, job: IdentityJobRef, bound = 512) {
  for (let attempt = 0; attempt < bound; attempt++) {
    const progress = await stepIdentityEpochMapping(pool, job);
    if (progress.state === 'complete') return progress;
  }
  throw new Error(`Native mapping did not finish within ${bound} bounded steps`);
}

async function drainLibrary(pool: Pool, job: IdentityJobRef, bound = 32) {
  for (let attempt = 0; attempt < bound; attempt++) {
    const progress = await stepLibraryIdentityEpoch(pool, job);
    if (progress.state === 'complete') return progress;
  }
  throw new Error(`ALL-Library identity did not finish within ${bound} bounded steps`);
}


async function profileRatingFixture() {
  const db = await identityEpochDatabase();
  try {
    const f = await createProfileEntryFixture({
      ownerScopes: ['rating:vote'],
      pool: db.pool,
      databaseUrl: db.url,
    });
    return {
      ...f,
      async close() {
        await f.close();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function injectControlReplacement(
  admin: Pool,
  table: string,
  column: string,
  where: string,
  keys: readonly unknown[],
  replacement: unknown,
) {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`UPDATE ${table} SET ${column}=$${keys.length + 1} WHERE ${where}`, [...keys, replacement]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('four provider review/apply paths commit local votes and preserve foreign-home refusal', async () => {
  const f = await profileRatingFixture();
  try {
    const votes = createVoteCommands({ pool: f.pool, access: f.access });
    const tuples = [];
    const providers = ['vndb', 'bangumi', 'mal', 'anilist'] as const;
    const sourceHome = partitionOf(1);
    const prepared = [];
    for (const provider of providers) {
      for (const callerHome of [sourceHome, (sourceHome + 1) % 4096]) {
        const caller = await f.identity(f.owner.actor.scopes, callerHome);
        await f.grantLibraryGate(caller.actor.accountId);
        prepared.push({ provider, caller, callerHome });
      }
    }
    await installIdentityEpochBootstrap(f.pool);
    for (const provider of providers) {
      const { requested, sourceHome: subjectHome } = await localRatingSubject(f, `${provider} native score target`);
      expect(subjectHome).toBe(sourceHome);
      for (const { caller, callerHome } of prepared.filter((row) => row.provider === provider)) {
        let appliedRequest!: { path: string; body: unknown; key: string; data: unknown };
        const request = async (path: string, body: unknown, key: string = randomUUID()) => {
          const response = await f.send(caller.bearer, 'POST', `/v1/libraryImports/${provider}${path}`, body, key);
          const data = await response.json();
          expect({ status: response.status, data }).toMatchObject({ status: 200 });
          if (path.endsWith(':apply') || path.endsWith('/apply')) appliedRequest = { path, body, key, data };
          return data;
        };
        let outcome: unknown;
        if (provider === 'vndb') {
          const upload = await request(':preview', {
            xml: '<vndb-export version="1.0" uid="u1"><vns><vn id="v42"><vote>8</vote></vn></vns></vndb-export>',
          });
          const review = await request(`/${upload.uploadId}:review`, {
            ordinal: 0,
            action: 'score',
            targetId: requested,
            questionId: STANDARD_QUESTION_ID,
            questionRevision: 1,
            selection: { kind: 'vote', units: 16 },
            consent: 'adopt-native-vote',
          });
          expect(review).toMatchObject({ status: 'reviewed', units: 16 });
          outcome = (
            await request(`/${upload.uploadId}:apply`, { rows: [{ ordinal: 0, scoreReviewId: review.reviewId }] })
          ).outcomes[0];
        } else if (provider === 'bangumi') {
          const upload = await request(':preview', {
            upload: JSON.stringify({
              format: 'rezics.bangumi-collection.v1',
              collections: [{ subject_id: 42, subject_type: 4, type: 1, rate: 8 }],
            }),
          });
          const { review } = await request(`/${upload.uploadId}:review`, {
            ordinal: 0,
            target: requested,
            score: { action: 'set', units: 16 },
          });
          expect(review.score.native.questionId).toBe(STANDARD_QUESTION_ID);
          outcome = (
            await request(`/${upload.uploadId}:apply`, {
              rows: [
                {
                  ordinal: 0,
                  reviewToken: review.token,
                  state: 'omit',
                  skip: false,
                  score: { action: 'set', units: 16, consent: true },
                },
              ],
            })
          ).outcomes[0].score;
        } else if (provider === 'mal') {
          const upload = await request(':preview', {
            xml: '<myanimelist><anime><series_animedb_id>42</series_animedb_id><my_status>Completed</my_status><my_score>8</my_score></anime></myanimelist>',
          });
          const version = randomUUID();
          await request(
            `/${upload.id}/review`,
            {
              row: 0,
              target: requested,
              skip: false,
              replace: false,
              score: { action: 'adopt', questionId: STANDARD_QUESTION_ID, questionRevision: 1, units: 16 },
            },
            version,
          );
          outcome = (
            await request(`/${upload.id}/apply`, { confirm: true, rows: [{ row: 0, version, fields: ['score'] }] })
          ).outcomes[0].score;
        } else {
          const upload = await request(':preview', {
            upload: JSON.stringify([{ mediaId: 42, score: 8 }]),
            scoreFormat: 'POINT_10',
          });
          const { review } = await request(`/${upload.id}:review`, {
            ordinal: 0,
            subjectId: requested,
            fields: [],
            replace: false,
            score: { action: 'vote', questionId: STANDARD_QUESTION_ID, questionRevision: 1, units: 16 },
          });
          expect(review.score.native.guard.subject.canonicalId).toBe(requested);
          outcome = (
            await request(`/${upload.id}:apply`, {
              confirmations: [{ ordinal: 0, reviewId: review.id, confirmNativeVoteEffects: true }],
            })
          ).outcomes[0].score;
        }
        expect(outcome).toMatchObject({ status: callerHome === sourceHome ? 'applied' : 'unavailable' });
        const native = await votes.readVoteReview(caller.actor, STANDARD_QUESTION_ID, requested);
        const review = await readIdentityRatingReview(f.pool, {
          requestedOriginalId: requested,
          canonicalTerminalId: native.guard.subject.canonicalId,
          deadline: Date.now() + 5000,
        });
        if (review.state !== 'reviewed') throw new Error(`Provider ${provider}: ${review.state}`);
        const commandHome = partitionOf(routeOf(caller.actor.accountId)!);
        const participant = createIdentityRatingCommitParticipant();
        const admission = () =>
          runCommand(f.pool, { partition: commandHome }, async (tx) =>
            noEffect(await participant.admit(tx, participant.prepare(review.operand))),
          );
        if (commandHome === sourceHome) {
          expect(commandHome).toBe(partitionOf(routeOf(STANDARD_QUESTION_ID)!));
          expect(await admission()).toMatchObject({ value: { subjectId: requested, ownerId: expect.any(String) } });
        } else {
          await expect(admission()).rejects.toMatchObject({
            reason: 'atomic_guard_unavailable',
            identityState: 'foreign-control',
          });
        }
        tuples.push({
          provider,
          requested,
          canonical: native.guard.subject.canonicalId,
          question: STANDARD_QUESTION_ID,
          questionHome: partitionOf(routeOf(STANDARD_QUESTION_ID)!),
          voter: caller.actor.accountId,
          commandHome,
          sourceHomes: review.operand.sourceHomes,
          controls: review.operand.controlLocators,
        });
        const own = await votes.readOwnVote(caller.actor, STANDARD_QUESTION_ID, requested);
        if (commandHome === sourceHome) {
          expect(own).toMatchObject({ units: 16, revision: 1, targetId: requested });
          expect(native.currentVote).toMatchObject({ state: 'counted', units: 16, countedRevision: 1 });
          const { path, body, key, data } = appliedRequest;
          expect(await request(path, body, key)).toEqual(data);
          expect(await votes.readOwnVote(caller.actor, STANDARD_QUESTION_ID, requested)).toEqual(own);
        } else {
          expect(own).toBeNull();
          expect(native.currentVote.state).toBe('absent');
        }
      }
    }
    console.info('Native provider Rating caller tuples', tuples);
    expect(tuples).toHaveLength(8);
  } finally {
    await f.close();
  }
}, 600_000);

test('persisted control replacement invalidates the exact review without changing the source epoch', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const selected = await reviewedSelf(f, 0x5d30);
    const participant = createIdentityRatingCommitParticipant();
    const prepared = participant.prepare(selected.operand);
    const before = (
      await f.admin.query('SELECT epoch FROM semantic.identity_epoch_mapping WHERE original=$1', [selected.subjectId])
    ).rows;
    // Imported replacement/ABA cuts keep the pair and mapping epoch identical.
    // Restore only the test's fault injection between independent witnesses.
    for (const [table, column, where, keys] of [
      ['core.partition', 'epoch', 'partition_no=$1', [selected.home]],
      [
        'semantic.identity_epoch_group',
        'generation',
        'partition_no=$1 AND terminal=$2',
        [selected.home, selected.subjectId],
      ],
      [
        'semantic.identity_epoch_group',
        'closure_incarnation',
        'partition_no=$1 AND terminal=$2',
        [selected.home, selected.subjectId],
      ],
      [
        'semantic.identity_epoch_original',
        'closure_registration_transaction',
        'partition_no=$1 AND original=$2 AND present',
        [selected.home, selected.subjectId],
      ],
    ] as const) {
      const previous = (await f.admin.query(`SELECT ${column} AS value FROM ${table} WHERE ${where}`, [...keys]))
        .rows[0]!.value;
      const replacement = column === 'epoch' ? Number(previous) + 2 : randomUUID();
      await injectControlReplacement(f.admin, table, column, where, keys, replacement);
      try {
        await expect(
          runCommand(f.pool, { partition: selected.home }, async (tx) =>
            noEffect(await participant.admit(tx, prepared)),
          ),
        ).rejects.toMatchObject({ name: 'VoteReviewStaleError', reason: 'identity_epoch_changed' });
      } finally {
        await injectControlReplacement(f.admin, table, column, where, keys, previous);
      }
    }
    expect(
      (await f.admin.query('SELECT epoch FROM semantic.identity_epoch_mapping WHERE original=$1', [selected.subjectId]))
        .rows,
    ).toEqual(before);
  } finally {
    await f.close();
  }
}, 180_000);

/** Limit only this attempt's actual native writer, without changing its SQL or executor. */
async function contendedWriter(f: { pool: Pool }, write: () => Promise<unknown>) {
  const originals = new Map<PoolClient, PoolClient['query']>();
  const acquire = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = async function (...args: unknown[]) {
      const result = await Reflect.apply(query, client, args);
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string }).text;
      if (sql?.startsWith('BEGIN') && !sql.includes('READ ONLY'))
        await Reflect.apply(query, client, ["SET LOCAL lock_timeout = '100ms'"]);
      return result;
    } as PoolClient['query'];
  };
  f.pool.on('acquire', acquire);
  try {
    await expect(withSingleCommandAttempt(write)).rejects.toMatchObject({ reason: 'contention' });
  } finally {
    f.pool.off('acquire', acquire);
    for (const [client, query] of originals) client.query = query;
  }
}

test('real admission, mapping, dirty capture and terminal closure cannot commit through a held reviewed command', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 3 });
  try {
    const selected = await reviewedSelf(f, 0x5d40);
    const survivor = (await f.create('Native writer survivor', 0x5d40)).id;
    const original = (await f.create('Native writer original', 0x5d40)).id;
    await f.bootstrapHomes([survivor, original]);
    const participant = createIdentityRatingCommitParticipant();
    // Real released JSON transport, including the complete persisted-control operand.
    const prepared = participant.prepare(JSON.parse(JSON.stringify(selected.operand)));
    const held = async <T>(write: () => Promise<T>, rollback: boolean): Promise<T> => {
      let release!: () => void;
      let admitted!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const ready = new Promise<void>((resolve) => (admitted = resolve));
      const command = runCommand(f.pool, { partition: selected.home, deadline: Date.now() + 10_000 }, async (tx) => {
        await participant.admit(tx, prepared);
        admitted();
        await barrier;
        if (rollback) throw new Error('reviewed command rollback');
        return noEffect(null);
      });
      try {
        await Promise.race([ready, command]);
        await contendedWriter(f, write);
      } finally {
        release();
        if (rollback) await expect(command).rejects.toThrow('reviewed command rollback');
        else await command;
      }
      return write();
    };
    const intent = { kind: 'merge' as const, redirected: original, survivor, release: release.digest };
    const job = await held(() => f.admit(intent), false);
    await held(() => stepIdentityEpochMapping(f.pool, job), true);
    await f.drainMapping(job, 512);
    await held(() => f.create('Native birth and dirty capture', 0x5d40), false);
    await held(() => stepIdentityEpochBootstrap(f.pool, selected.home), true);
    const claim = randomUUID();
    await held(() => drainIdentityTerminalClosure(f.pool, selected.subjectId, claim), false);
    await expect(
      runCommand(f.pool, { partition: selected.home }, async (tx) => noEffect(await participant.admit(tx, prepared))),
    ).rejects.toMatchObject({ name: 'VoteReviewStaleError', reason: 'identity_epoch_changed' });
  } finally {
    await f.close();
  }
}, 180_000);

test('identity mutation after review refuses admission, and rollback releases the native fence', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 2 });
  try {
    const original = (await f.create('Rating original', 0x5d10)).subject.id;
    const survivor = (await f.create('Rating survivor', 0x5d10)).subject.id;
    await f.bootstrapHomes([original, survivor]);
    const review = await readIdentityRatingReview(f.pool, {
      requestedOriginalId: original,
      canonicalTerminalId: original,
      deadline: Date.now() + 5000,
    });
    if (review.state !== 'reviewed') throw new Error(`Expected a reviewed self mapping, received ${review.state}`);
    const participant = createIdentityRatingCommitParticipant();
    const prepared = participant.prepare(review.operand);
    await expect(
      runCommand(f.pool, { partition: partitionOf(routeOf(original)!) }, async (tx) => {
        await participant.admit(tx, prepared);
        throw new Error('rollback after identity admission');
      }),
    ).rejects.toThrow('rollback after identity admission');

    await f.admit({ kind: 'merge', redirected: original, survivor, release: release.digest });

    await expect(
      runCommand(f.pool, { partition: partitionOf(routeOf(original)!) }, async (tx) =>
        noEffect(await participant.admit(tx, prepared)),
      ),
    ).rejects.toMatchObject({
      name: 'IdentityRatingCommitUnavailableError',
      identityState: 'pending',
    });

    const current = await readIdentityRatingReview(f.pool, {
      requestedOriginalId: original,
      canonicalTerminalId: original,
      deadline: Date.now() + 5000,
    });
    expect(current.state).toBe('pending');
  } finally {
    await f.close();
  }
}, 180_000);

test('fresh and JSONB-reviewed published evidence continues the original native vote under exact consent', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 2 });
  try {
    const selected = await reviewedSelf(f, 0x5d10);
    const participant = createIdentityRatingCommitParticipant();
    const evidence = JSON.parse(selected.operand.evidence) as { mapping: string; subjects: unknown };
    const mapping = JSON.parse(evidence.mapping) as { pendingRows: { pending_job: unknown; pending_epoch: unknown }[] };
    expect(mapping.pendingRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pending_job: null, pending_epoch: null, terminal: selected.subjectId }),
      ]),
    );
    const stored = (
      await f.admin.query<{ operand: Record<string, unknown>; mapping: { pendingRows: unknown[] } }>(
        'SELECT $1::jsonb AS operand, $2::jsonb AS mapping',
        [JSON.stringify(selected.operand), evidence.mapping],
      )
    ).rows[0]!;
    expect(stored.mapping.pendingRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pending_job: null, pending_epoch: null, terminal: selected.subjectId }),
      ]),
    );
    const fromJsonb = {
      version: stored.operand.version,
      requestedOriginalId: stored.operand.requestedOriginalId,
      canonicalTerminalId: stored.operand.canonicalTerminalId,
      sourceIdentities: stored.operand.sourceIdentities,
      sourceHomes: stored.operand.sourceHomes,
      controlLocators: stored.operand.controlLocators,
      evidence: stored.operand.evidence,
    };
    for (const operand of [selected.operand, JSON.parse(JSON.stringify(selected.operand)), fromJsonb]) {
      const prepared = participant.prepare(operand as typeof selected.operand);
      const held = await runCommand(f.pool, { partition: selected.home }, async (tx) =>
        noEffect(await participant.admit(tx, prepared)),
      );
      expect(held.value.subjectId).toBe(selected.subjectId);
      expect(held.value.partition).toBe(selected.home);
    }
    const unpairedMapping = JSON.parse(evidence.mapping) as {
      pendingRows: { pending_job: unknown; pending_epoch: unknown }[];
    };
    unpairedMapping.pendingRows = unpairedMapping.pendingRows.map((row) => ({
      ...row,
      pending_job: null,
      pending_epoch: '1',
    }));
    expect(() =>
      participant.prepare({
        ...selected.operand,
        evidence: JSON.stringify({ mapping: JSON.stringify(unpairedMapping), subjects: evidence.subjects }),
      }),
    ).toThrow(TypeError);
  } finally {
    await f.close();
  }
}, 180_000);

test('preparation rejects extra, duplicated and oversized reviewed evidence', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const selected = await reviewedSelf(f, 0x5d10);
    const participant = createIdentityRatingCommitParticipant();
    expect(() => participant.prepare({ ...selected.operand, extra: true } as never)).toThrow(TypeError);
    expect(() =>
      participant.prepare({
        ...selected.operand,
        controlLocators: [...selected.operand.controlLocators, selected.operand.controlLocators[0]!],
      }),
    ).toThrow(TypeError);
    expect(() =>
      participant.prepare({
        ...selected.operand,
        evidence: JSON.stringify({ mapping: 'x'.repeat(16_500), subjects: [] }),
      }),
    ).toThrow(TypeError);
  } finally {
    await f.close();
  }
}, 180_000);

test('the authorized vote transaction excludes native control writes through commit and rollback and replays after a changed review', async () => {
  const f = await profileRatingFixture();
  try {
    const sourceHome = partitionOf(1);
    const caller = await f.identity(['rating:vote', 'subject:read'], sourceHome);
    await grantStewardMerge(f);
    await installIdentityEpochBootstrap(f.pool);
    const { requested, sourceHome: subjectHome } = await localRatingSubject(f, 'Authorized guarded vote');
    expect(subjectHome).toBe(sourceHome);
    const votes = createVoteCommands({ pool: f.pool, access: f.access });
    const original = await localRatingSubject(f, 'Publication original');
    const survivor = await localRatingSubject(f, 'Publication survivor');
    expect(original.sourceHome).toBe(sourceHome);
    expect(survivor.sourceHome).toBe(sourceHome);
    const prior = {
      questionId: STANDARD_QUESTION_ID,
      targetId: original.requested,
      units: 16,
      guard: (await votes.readVoteReview(caller.actor, STANDARD_QUESTION_ID, original.requested)).guard,
    };
    const job = await admitSameHomeMerge(f, original.requested, survivor.requested);
    expect(identityJobPartition(job)).toBe(sourceHome);
    const input = async (units: number) => ({
      questionId: STANDARD_QUESTION_ID,
      targetId: requested,
      units,
      guard: (await votes.readVoteReview(caller.actor, STANDARD_QUESTION_ID, requested)).guard,
    });
    let committed!: Awaited<ReturnType<typeof votes.putVoteOutcome>>;
    const first = await input(16);
    const key = randomUUID();
    for (const rollback of [false, true]) {
      const request = rollback ? await input(15) : first;
      let resume!: () => void;
      let locked!: () => void;
      const barrier = new Promise<void>((resolve) => (resume = resolve));
      const ready = new Promise<void>((resolve) => (locked = resolve));
      const originals = new Map<PoolClient, PoolClient['query']>();
      const acquire = (client: PoolClient) => {
        if (originals.has(client)) return;
        const query = client.query;
        originals.set(client, query);
        client.query = async function (...args: unknown[]) {
          const result = await Reflect.apply(query, client, args);
          const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string }).text;
          if (sql === lockOwner.sql) {
            locked();
            await barrier;
            if (rollback) throw new Error('authorized vote rollback');
          }
          return result;
        } as PoolClient['query'];
      };
      f.pool.on('acquire', acquire);
      const command = votes.putVoteOutcome(caller.actor, request, rollback ? randomUUID() : key);
      try {
        await Promise.race([ready, command]);
        await contendedWriter(f, () => drainIdentityTerminalClosure(f.pool, requested, randomUUID()));
        await contendedWriter(f, () => stepIdentityEpochMapping(f.pool, job));
        await contendedWriter(f, () => stepLibraryIdentityEpoch(f.pool, job));
      } finally {
        resume();
        try {
          if (rollback) await expect(command).rejects.toThrow('authorized vote rollback');
          else committed = await command;
        } finally {
          f.pool.off('acquire', acquire);
          for (const [client, query] of originals) client.query = query;
        }
      }
      expect(await votes.readOwnVote(caller.actor, STANDARD_QUESTION_ID, requested)).toMatchObject({
        units: 16,
        revision: 1,
      });
    }
    expect(committed.vote).toMatchObject({ units: 16, revision: 1 });
    expect(committed.component).not.toBeNull();
    const mapping = await drainMapping(f.pool, job);
    expect(mapping.state).toBe('complete');
    const reconciled = await identityEpochStore().reconcileStepReceipt(f.pool, mapping.receipt);
    expect(reconciled.state).toBe('complete');
    expect(reconciled.receipt).toEqual(mapping.receipt);
    const library = await drainLibrary(f.pool, job);
    expect(library.state).toBe('complete');
    const libraryReceipt = await identityEpochStore().reconcileStepReceipt(f.pool, library.receipt);
    expect(libraryReceipt.state).toBe('complete');
    expect(libraryReceipt.receipt).toEqual(library.receipt);
    const saved = await withConnection(f.pool, (tx) => identityEpochStore().readJob(tx, job));
    expect(saved?.mapping?.state).toBe('complete');
    expect(saved?.participants['library-private-follow-counts']?.state).toBe('complete');
    await expect(votes.putVoteOutcome(caller.actor, prior, randomUUID())).rejects.toMatchObject({
      reason: 'identity_pending',
    });
    const stale = await input(14);
    await drainIdentityTerminalClosure(f.pool, requested, randomUUID());
    await expect(votes.putVoteOutcome(caller.actor, stale, randomUUID())).rejects.toMatchObject({
      reason: 'identity_epoch_changed',
    });
    expect(await votes.putVoteOutcome(caller.actor, first, key)).toEqual(committed);
    expect(await votes.readOwnVote(caller.actor, STANDARD_QUESTION_ID, requested)).toMatchObject({
      units: 16,
      revision: 1,
    });
  } finally {
    await f.close();
  }
}, 180_000);
