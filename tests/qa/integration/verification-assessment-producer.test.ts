import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import {
  VerificationStore,
  nativeId,
  uuidOf,
  type ActivationInput,
  type AssessmentProducerAuditFrontier,
  type AssessmentProducerPermit,
  type AssessmentProducerStage,
  type AssessmentProducerTerminal,
  type StagedAssessmentProducer,
} from '../../../services/main/src/modules/verification/store.ts';

let pool: Pool;
beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through the isolated integration tier');
  }
  pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  await migrateContent(pool);
});
afterAll(async () => {
  await pool?.end();
});
afterEach(async () => {
  // There is no production release in this slice. Reset only the isolated QA
  // database's gate so each refusal test starts from its own ordinary cut.
  await pool.query(`UPDATE verification.assessment_producer_gate SET mode = 'ordinary', job = NULL,
    restore_epoch = (SELECT version FROM reading_position.generation WHERE singleton) WHERE singleton`);
});

function fixture(admission: string = randomUUID()) {
  const principal = randomUUID();
  const challenger = randomUUID();
  const claim = nativeId(randomUUID());
  const claimRevision = nativeId(randomUUID());
  const assessment = nativeId(randomUUID());
  const context = `urn:rezics:context:assessment-producer:${randomUUID()}`;
  const store = new VerificationStore(pool);
  const activation: ActivationInput = {
    target: claim,
    context,
    claim,
    claimRevision,
    adoptedRevision: null,
    assessment,
    policyRevision: 'urn:rezics:policy:assessment-producer',
    support: 'supported',
    review: 'reviewed',
    coverage: 'complete',
    dependence: 'established',
    reasons: ['review-complete'],
    dependencies: [
      { owner: 'graph', kind: 'claim', reference: claim, expectedHead: claimRevision },
    ],
    ownerPositions: {},
    operationKey: `assessment:${admission}`,
    expectedActive: null,
    observedDemand: null,
    openChallenges: 0,
    resolvedChallenges: 0,
  };
  const stage: AssessmentProducerStage = {
    admission,
    requestDigest: '',
    principal,
    actingSubject: nativeId(principal),
    scope: 'verification:assess:global',
    authorityEpoch: '1',
    idempotencyKey: randomUUID(),
    claim,
    claimRevision,
    intent: {
      claimRevision,
      evidenceSetRevision: nativeId(randomUUID()),
      sourceAssessments: [],
      method: 'human-review',
      judgment: 'supported',
      evaluationContext: context,
      adoptedRevision: null,
      scorePerMillion: null,
      calibration: null,
      evaluationReference: null,
      limitations: 'Independent review of these precise pins',
      expectedSummary: null,
      resolvesChallenges: [],
      actingSubject: nativeId(principal),
    },
  };
  const receipt = `urn:rezics:receipt:${createHash('sha256').update(`${admission}\0claim-assess`).digest('hex')}`;
  const terminal: AssessmentProducerTerminal = {
    status: 'no-activation',
    receipt,
    assessment,
    activation: { status: 'not-reproduced' },
  };
  return {
    principal,
    challenger,
    admission,
    claim,
    claimRevision,
    assessment,
    context,
    store,
    activation,
    stage,
    receipt,
    terminal,
  };
}

function originalIntent(f: ReturnType<typeof fixture>, challenges: readonly string[] = []) {
  const intent = { ...f.stage.intent, resolvesChallenges: [...challenges] };
  const requestDigest = createHash('sha256')
    .update(
      JSON.stringify({
        family: 'claim-assessment-v1',
        claim: f.claim,
        ...intent,
        sourceAssessments: [],
        resolvesChallenges: [...challenges].sort(),
      }),
    )
    .digest('hex');
  return { ...f.stage, intent, requestDigest };
}

async function challenge(f: ReturnType<typeof fixture>, principal = f.challenger) {
  const result = await f.store.submitChallenge(principal, randomUUID(), f.claim, {
    claimRevision: f.claimRevision,
    adoptedRevision: null,
    context: f.context,
    reason: 'Review this exact assessment input',
    counterevidence: [],
    actingSubject: nativeId(principal),
  });
  return uuidOf(result.challenge.challenge)!;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pause after the real SQL lock, keeping its transaction and client alive. */
function heldQueries(match: (sql: string) => boolean) {
  const locked = deferred();
  const connected = deferred();
  const resume = deferred();
  const queries: string[] = [];
  const calls: { sql: string; values?: unknown[] }[] = [];
  const backendPids: number[] = [];
  let held = false;
  const database = {
    connect: async () => {
      const client = await pool.connect();
      backendPids.push((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      connected.resolve();
      return {
        query: async (sql: string, values?: unknown[]) => {
          queries.push(sql);
          calls.push({ sql, values });
          const result = await client.query(sql, values);
          if (!held && match(sql)) {
            held = true;
            locked.resolve();
            await resume.promise;
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  return {
    store: new VerificationStore(database),
    locked,
    connected,
    resume,
    queries,
    calls,
    backendPids,
  };
}

function settlement<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error) => ({ status: 'rejected' as const, error }),
  );
}

function auditFrontier(
  permit: AssessmentProducerPermit,
  after: string,
): AssessmentProducerAuditFrontier {
  if (permit.mode !== 'maintenance' || !permit.job)
    throw new Error('Audit fixture requires a closed producer');
  return {
    after,
    job: permit.job,
    generation: permit.generation,
    restoreEpoch: permit.restoreEpoch,
  };
}

async function seedProducerRows(
  f: ReturnType<typeof fixture>,
  admissions: readonly string[],
  scope = f.stage.scope,
) {
  const stage = originalIntent(f);
  await pool.query(
    `INSERT INTO verification.assessment_producer
    (admission_id, request_digest, principal_id, acting_subject, scope, authority_epoch, idempotency_key,
      claim, claim_revision, intent_json, stage_generation, restore_epoch, terminal, terminal_at)
    SELECT admission, $2, $3, $4, $5, $6, admission::text, $7, $8, $9, gate.generation, gate.restore_epoch,
      terminal, clock_timestamp()
    FROM unnest($1::uuid[], $10::jsonb[]) AS inputs(admission, terminal)
    CROSS JOIN verification.assessment_producer_gate gate WHERE gate.singleton`,
    [
      admissions,
      stage.requestDigest,
      stage.principal,
      stage.actingSubject,
      scope,
      stage.authorityEpoch,
      stage.claim,
      stage.claimRevision,
      JSON.stringify(stage.intent),
      admissions.map((admission) => ({
        ...f.terminal,
        receipt: `urn:rezics:receipt:${createHash('sha256').update(`${admission}\0claim-assess`).digest('hex')}`,
      })),
    ],
  );
}

function expectPlainGateReads(queries: readonly string[]) {
  const reads = queries.filter(
    (sql) =>
      /\bSELECT\b/.test(sql) &&
      /(?:assessment_producer_gate|reading_position\.generation)/.test(sql),
  );
  expect(reads.length).toBeGreaterThan(0);
  for (const sql of reads)
    expect(sql).not.toMatch(/FOR\s+(?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)/i);
}

async function waitingForProducerLock(pid: number, mode: 'RowExclusiveLock' | 'ShareLock') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (
      (
        await pool.query(
          `SELECT 1 FROM pg_locks WHERE pid = $1
      AND relation = 'verification.assessment_producer'::regclass
      AND mode = $2 AND NOT granted`,
          [pid, mode],
        )
      ).rowCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Producer did not wait for its ${mode} table lock`);
}

async function waitingForAuditRow(pid: number) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (
      (
        await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE pid = $1
      AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`,
          [pid],
        )
      ).rowCount
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Audit did not wait behind the producer effect row lock');
}

async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Producer did not reach the expected SQL lock')),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('missing historical intent remains unresolved even when the pending keyset is empty', async () => {
  const f = fixture();
  const generation = (
    await pool.query(
      'SELECT generation::text FROM verification.assessment_producer_gate WHERE singleton',
    )
  ).rows[0].generation;
  const permit = await f.store.closeAssessmentProducerGate(randomUUID(), generation);
  expect(await f.store.listPendingAssessmentProducers(permit)).toEqual([]);
  expect(await f.store.readAssessmentProducer(f.admission)).toBeNull();
  let effects = 0;
  await expect(
    f.store.withAssessmentProducerEffects(
      f.admission,
      originalIntent(f).requestDigest,
      permit,
      async () => {
        effects++;
        return f.terminal;
      },
    ),
  ).rejects.toThrow('unavailable');
  expect(effects).toBe(0);
});

test('the original intent remains recoverable when the Content tail has not run', async () => {
  const f = fixture();
  const requested = await challenge(f);
  const secondRequested = await challenge(f);
  const stage = originalIntent(f, [requested, secondRequested]);
  const staged = await f.store.stageAssessmentProducer(stage);
  const equivalentRetry = await f.store.stageAssessmentProducer({
    ...stage,
    intent: { ...stage.intent, resolvesChallenges: [...stage.intent.resolvesChallenges].reverse() },
  });
  expect(equivalentRetry.row).toEqual(staged.row);
  // A new owner instance must recover the original requested effects without
  // reconstructing them from challenge resolutions or a current summary.
  const recovered = await new VerificationStore(pool).readAssessmentProducer(
    f.admission,
    stage.requestDigest,
  );
  expect(recovered).toEqual(staged.row);
  expect(recovered?.intent).toEqual(stage.intent);
  expect(
    (
      await pool.query(
        'SELECT intent_json FROM verification.assessment_producer WHERE admission_id = $1',
        [f.admission],
      )
    ).rows[0].intent_json,
  ).toBe(JSON.stringify(stage.intent));
  expect(recovered?.terminal).toBeNull();
  expect(await f.store.readSummary(f.claim, f.context)).toBeNull();
  expect((await f.store.readChallenge(f.claim, requested))?.state).toBe('pending');
  expect((await f.store.readChallenge(f.claim, secondRequested))?.state).toBe('pending');
  const sealed = await f.store.withAssessmentProducerEffects(
    f.admission,
    stage.requestDigest,
    staged.permit,
    async (client) => {
      await f.store.resolveChallenges(
        f.principal,
        f.admission,
        f.claim,
        f.assessment,
        stage.intent.resolvesChallenges,
        'not-established',
        'Exact assessment review',
        nativeId(f.principal),
        client,
      );
      return f.terminal;
    },
  );
  expect(sealed.terminal).toEqual(f.terminal);
  expect((await f.store.readChallenge(f.claim, requested))?.state).toBe('resolved');
  expect((await f.store.readChallenge(f.claim, secondRequested))?.state).toBe('resolved');
  await expect(
    f.store.stageAssessmentProducer({
      ...stage,
      intent: { ...stage.intent, expectedSummary: nativeId(randomUUID()) },
    }),
  ).rejects.toThrow();
});

test('positive and no-activation terminals cannot omit requested challenge receipts', async () => {
  const f = fixture();
  const requested = await challenge(f);
  const stage = originalIntent(f, [requested]);
  const staged = await f.store.stageAssessmentProducer(stage);
  await expect(
    f.store.withAssessmentProducerEffects(
      f.admission,
      stage.requestDigest,
      staged.permit,
      async (client) => ({
        ...f.terminal,
        status: 'activated',
        activation: await f.store.activateSummary(f.activation, client),
      }),
    ),
  ).rejects.toThrow('exact requested challenge authority');
  expect(await f.store.readSummary(f.claim, f.context)).toBeNull();
  expect(
    (
      await pool.query('SELECT id FROM verification.summary_generation WHERE operation_key = $1', [
        `assessment:${f.admission}`,
      ])
    ).rows,
  ).toEqual([]);
  expect((await f.store.readAssessmentProducer(f.admission))?.terminal).toBeNull();
  await expect(
    f.store.withAssessmentProducerEffects(
      f.admission,
      stage.requestDigest,
      staged.permit,
      async () => f.terminal,
    ),
  ).rejects.toThrow('exact requested challenge authority');
  expect((await f.store.readChallenge(f.claim, requested))?.state).toBe('pending');
  expect(
    (
      await pool.query(
        `SELECT id FROM verification.receipt WHERE principal_id = $1
    AND action = 'challenge.resolve' AND idempotency_key = $2`,
        [f.principal, `${f.admission}:${requested}`],
      )
    ).rows,
  ).toEqual([]);
  expect((await f.store.readAssessmentProducer(f.admission))?.terminal).toBeNull();
  await f.store.withAssessmentProducerEffects(
    f.admission,
    stage.requestDigest,
    staged.permit,
    async () => ({
      ...f.terminal,
      status: 'refused',
      activation: { status: 'refused', reason: 'basis-unavailable' },
    }),
  );
});

test('a later invalid challenge rolls back earlier effects and keeps the producer pending', async () => {
  const f = fixture();
  const first = await challenge(f);
  const missing = randomUUID();
  const stage = originalIntent(f, [first, missing]);
  const staged = await f.store.stageAssessmentProducer(stage);
  const before = await f.store.challengeState(f.claim);
  await expect(
    f.store.withAssessmentProducerEffects(
      f.admission,
      stage.requestDigest,
      staged.permit,
      async (client) => {
        await f.store.resolveChallenges(
          f.principal,
          f.admission,
          f.claim,
          f.assessment,
          stage.intent.resolvesChallenges,
          'not-established',
          'Exact assessment review',
          nativeId(f.principal),
          client,
        );
        const activation = await f.store.activateSummary(f.activation, client);
        return { ...f.terminal, status: 'activated', activation };
      },
    ),
  ).rejects.toThrow('unavailable');
  expect(await f.store.challengeState(f.claim)).toEqual(before);
  expect((await f.store.readChallenge(f.claim, first))?.state).toBe('pending');
  expect(
    (
      await pool.query(
        `SELECT id FROM verification.receipt WHERE principal_id = $1
    AND action = 'challenge.resolve' AND idempotency_key = $2`,
        [f.principal, `${f.admission}:${first}`],
      )
    ).rows,
  ).toEqual([]);
  expect(await f.store.readSummary(f.claim, f.context)).toBeNull();
  expect((await f.store.readAssessmentProducer(f.admission))?.terminal).toBeNull();
  await f.store.withAssessmentProducerEffects(
    f.admission,
    stage.requestDigest,
    staged.permit,
    async () => ({
      ...f.terminal,
      status: 'refused',
      activation: { status: 'refused', reason: 'missing-challenge' },
    }),
  );
});

test('lost acknowledgement replays one atomic terminal and retains a superseded positive generation', async () => {
  const f = fixture();
  const requested = await challenge(f);
  const stage = originalIntent(f, [requested]);
  const staged = await f.store.stageAssessmentProducer(stage);
  let effects = 0;
  const reconcile = () =>
    f.store.withAssessmentProducerEffects(
      f.admission,
      stage.requestDigest,
      staged.permit,
      async (client) => {
        effects++;
        await f.store.resolveChallenges(
          f.principal,
          f.admission,
          f.claim,
          f.assessment,
          stage.intent.resolvesChallenges,
          'not-established',
          'Exact assessment review',
          nativeId(f.principal),
          client,
        );
        const activation = await f.store.activateSummary(
          { ...f.activation, resolvedChallenges: 1 },
          client,
        );
        return { ...f.terminal, status: 'activated', activation };
      },
    );
  const [one, two] = await Promise.all([reconcile(), reconcile()]);
  expect(one.terminal).toEqual(two.terminal);
  expect((await reconcile()).terminal).toEqual(one.terminal);
  expect(effects).toBe(1);
  expect(await f.store.challengeState(f.claim)).toMatchObject({ open: 0, resolved: 1 });
  expect(
    (
      await pool.query(
        `SELECT id FROM verification.receipt WHERE principal_id = $1
    AND action = 'challenge.resolve' AND idempotency_key = $2`,
        [f.principal, `${f.admission}:${requested}`],
      )
    ).rows,
  ).toHaveLength(1);
  const generations = (
    await pool.query('SELECT id FROM verification.summary_generation WHERE operation_key = $1', [
      `assessment:${f.admission}`,
    ])
  ).rows;
  expect(generations).toHaveLength(1);
  const firstGeneration = nativeId(generations[0].id);
  await f.store.activateSummary({
    ...f.activation,
    operationKey: randomUUID(),
    expectedActive: firstGeneration,
  });
  expect((await f.store.readSummary(f.claim, f.context))?.generation).not.toBe(firstGeneration);
  expect((await reconcile()).terminal).toEqual(one.terminal);
  expect(effects).toBe(1);
});

test('negative and no-activation terminals are explicit immutable outcomes', async () => {
  const f = fixture();
  const stage = originalIntent(f);
  const staged = await f.store.stageAssessmentProducer(stage);
  const activation = await f.store.activateSummary({ ...f.activation, operationKey: randomUUID() });
  expect(activation.status).toBe('activated');
  const negative = await f.store.withAssessmentProducerEffects(
    f.admission,
    stage.requestDigest,
    staged.permit,
    async (client) => ({
      ...f.terminal,
      status: 'refused',
      activation: await f.store.activateSummary(f.activation, client),
    }),
  );
  expect(negative.terminal).toMatchObject({
    status: 'refused',
    activation: { status: 'stale-summary' },
  });
  const other = fixture();
  const otherStage = originalIntent(other);
  const otherStaged = await other.store.stageAssessmentProducer(otherStage);
  const noActivation = await other.store.withAssessmentProducerEffects(
    other.admission,
    otherStage.requestDigest,
    otherStaged.permit,
    async () => other.terminal,
  );
  expect(noActivation.terminal).toMatchObject({
    status: 'no-activation',
    activation: { status: 'not-reproduced' },
  });
  let retried = false;
  expect(
    (
      await other.store.withAssessmentProducerEffects(
        other.admission,
        otherStage.requestDigest,
        otherStaged.permit,
        async () => {
          retried = true;
          return other.terminal;
        },
      )
    ).terminal,
  ).toEqual(noActivation.terminal);
  expect(retried).toBe(false);
  await expect(
    pool.query(
      'UPDATE verification.assessment_producer SET terminal = $2 WHERE admission_id = $1',
      [other.admission, { ...other.terminal, status: 'refused' }],
    ),
  ).rejects.toThrow('immutable');
});

test('ordinary effect locks are compatible, closure waits for them, and later ordinary tails refuse', async () => {
  const f = fixture();
  const stage = originalIntent(f);
  const staged = await f.store.stageAssessmentProducer(stage);
  const readRows = () =>
    pool.query(`SELECT 'gate' AS owner, xmax::text FROM verification.assessment_producer_gate
    WHERE singleton UNION ALL SELECT 'epoch' AS owner, xmax::text FROM reading_position.generation WHERE singleton`);
  const beforeReaders = (await readRows()).rows;
  const gateRead = (sql: string) =>
    /FROM verification\.assessment_producer_gate WHERE singleton/.test(sql);
  const held = heldQueries(gateRead);
  const secondHeld = heldQueries(gateRead);
  let secondTail: ReturnType<VerificationStore['withAssessmentProducerEffects']> | undefined;
  const tail = held.store.withAssessmentProducerEffects(
    f.admission,
    stage.requestDigest,
    staged.permit,
    async () => f.terminal,
  );
  try {
    await reached(held.locked.promise);
    // A second ordinary producer takes a compatible lock rather than waiting
    // on a global head changed by every assessment.
    const other = fixture();
    const otherStage = originalIntent(other);
    const compatible = await other.store.stageAssessmentProducer(otherStage);
    expect(compatible.permit.generation).toBe(staged.permit.generation);
    secondTail = secondHeld.store.withAssessmentProducerEffects(
      other.admission,
      otherStage.requestDigest,
      compatible.permit,
      async () => other.terminal,
    );
    await reached(secondHeld.locked.promise);
    const pids = [held.backendPids[0]!, secondHeld.backendPids[0]!];
    const locks = (
      await pool.query(
        `SELECT pid, locktype, relation::regclass::text AS relation, mode, granted
      FROM pg_locks WHERE pid = ANY($1::int[]) AND relation = ANY($2::regclass[])`,
        [
          pids,
          [
            'verification.assessment_producer',
            'verification.assessment_producer_gate',
            'reading_position.generation',
          ],
        ],
      )
    ).rows;
    for (const pid of pids) {
      expect(
        locks.filter(
          (lock) =>
            lock.pid === pid &&
            lock.relation === 'verification.assessment_producer' &&
            lock.mode === 'RowExclusiveLock' &&
            lock.granted,
        ),
      ).toHaveLength(1);
      const sharedRows = locks.filter(
        (lock) =>
          lock.pid === pid &&
          ['verification.assessment_producer_gate', 'reading_position.generation'].includes(
            lock.relation,
          ),
      );
      expect(sharedRows).toHaveLength(2);
      for (const lock of sharedRows)
        expect(lock).toMatchObject({
          locktype: 'relation',
          mode: 'AccessShareLock',
          granted: true,
        });
    }
    expect((await readRows()).rows).toEqual(beforeReaders);
    await expect(
      f.store.closeAssessmentProducerGate(randomUUID(), staged.permit.generation),
    ).rejects.toThrow('lock timeout');
    expect(
      (
        await pool.query(
          'SELECT mode, generation::text FROM verification.assessment_producer_gate WHERE singleton',
        )
      ).rows[0],
    ).toEqual({ mode: 'ordinary', generation: staged.permit.generation });
  } finally {
    secondHeld.resume.resolve();
    held.resume.resolve();
    if (secondTail) await secondTail;
    await tail;
  }
  expectPlainGateReads(held.queries);
  expectPlainGateReads(secondHeld.queries);
  const replayHeld = heldQueries((sql) =>
    /LOCK TABLE verification\.assessment_producer IN ROW EXCLUSIVE MODE/i.test(sql),
  );
  let replayEffects = 0;
  const replay = replayHeld.store.withAssessmentProducerEffects(
    f.admission,
    stage.requestDigest,
    staged.permit,
    async () => {
      replayEffects++;
      return f.terminal;
    },
  );
  try {
    await reached(replayHeld.locked.promise);
    await expect(
      f.store.closeAssessmentProducerGate(randomUUID(), staged.permit.generation),
    ).rejects.toThrow('lock timeout');
  } finally {
    replayHeld.resume.resolve();
  }
  expect((await replay).terminal).toEqual(f.terminal);
  expect(replayEffects).toBe(0);
  expectPlainGateReads(replayHeld.queries);
  const pending = fixture();
  const pendingStage = originalIntent(pending);
  const beforeClose = await pending.store.stageAssessmentProducer(pendingStage);
  const job = randomUUID();
  const permit = await f.store.closeAssessmentProducerGate(job, staged.permit.generation);
  expect(permit).toMatchObject({ mode: 'maintenance', job });
  expect(await f.store.closeAssessmentProducerGate(job, staged.permit.generation)).toEqual(permit);
  let effects = 0;
  await expect(
    pending.store.withAssessmentProducerEffects(
      pending.admission,
      pendingStage.requestDigest,
      beforeClose.permit,
      async () => {
        effects++;
        return pending.terminal;
      },
    ),
  ).rejects.toThrow('gate changed');
  expect(effects).toBe(0);
  expect((await pending.store.readAssessmentProducer(pending.admission))?.terminal).toBeNull();
  await expect(f.store.stageAssessmentProducer(originalIntent(fixture()))).rejects.toThrow(
    'closed for maintenance',
  );
  const reconciled = await pending.store.withAssessmentProducerEffects(
    pending.admission,
    pendingStage.requestDigest,
    permit,
    async () => pending.terminal,
  );
  expect(reconciled.terminal).toEqual(pending.terminal);
}, 15_000);

test('an in-flight producer INSERT blocks closure and a timed-out closer leaves no permit', async () => {
  const f = fixture();
  const stage = originalIntent(f);
  const generation = (
    await pool.query(
      'SELECT generation::text FROM verification.assessment_producer_gate WHERE singleton',
    )
  ).rows[0].generation;
  const inserted = heldQueries((sql) =>
    /INSERT INTO verification\.assessment_producer \(/.test(sql),
  );
  const staging = inserted.store.stageAssessmentProducer(stage);
  let closed: Awaited<ReturnType<VerificationStore['closeAssessmentProducerGate']>> | undefined;
  try {
    await reached(inserted.locked.promise);
    expect(await f.store.readAssessmentProducer(f.admission)).toBeNull();
    await expect(
      f.store.closeAssessmentProducerGate(randomUUID(), generation).then((permit) => {
        closed = permit;
        return permit;
      }),
    ).rejects.toThrow('lock timeout');
    expect(closed).toBeUndefined();
    expect(
      (
        await pool.query(
          'SELECT mode, generation::text FROM verification.assessment_producer_gate WHERE singleton',
        )
      ).rows[0],
    ).toEqual({ mode: 'ordinary', generation });
    const closer = heldQueries(() => false);
    const closure = closer.store.closeAssessmentProducerGate(randomUUID(), generation);
    try {
      await reached(closer.connected.promise);
      await waitingForProducerLock(closer.backendPids[0]!, 'ShareLock');
      inserted.resume.resolve();
      const staged = await staging;
      const permit = await closure;
      expect(permit.mode).toBe('maintenance');
      expect((await f.store.readAssessmentProducer(f.admission))?.intent).toEqual(stage.intent);
      expect(staged.permit.generation).toBe(generation);
      await f.store.withAssessmentProducerEffects(
        f.admission,
        stage.requestDigest,
        permit,
        async () => f.terminal,
      );
    } finally {
      inserted.resume.resolve();
      await closure;
    }
  } finally {
    inserted.resume.resolve();
    await staging;
  }
  expectPlainGateReads(inserted.queries);
}, 15_000);

test('a stale INSERT and a delayed repeatable-read effect both refuse after the maintenance table barrier', async () => {
  const f = fixture();
  const stage = originalIntent(f);
  const pending = fixture();
  const pendingStage = originalIntent(pending);
  const staged = await pending.store.stageAssessmentProducer(pendingStage);
  const staleReader = heldQueries((sql) =>
    /FROM verification\.assessment_producer_gate WHERE singleton/.test(sql),
  );
  const staging = staleReader.store.stageAssessmentProducer(stage);
  // Collect settlement without invoking Bun's rejection matcher while the SQL
  // barrier is held; that matcher can wait before cleanup releases the writer.
  const stageSettled = staging.catch(() => undefined);
  const closer = heldQueries((sql) =>
    /LOCK TABLE verification\.assessment_producer IN SHARE MODE/i.test(sql),
  );
  let closure: ReturnType<VerificationStore['closeAssessmentProducerGate']> | undefined;
  const delayed = heldQueries(() => false);
  let effects = 0;
  let effect: ReturnType<VerificationStore['withAssessmentProducerEffects']> | undefined;
  let effectSettled: Promise<unknown> | undefined;
  try {
    await reached(staleReader.locked.promise);
    closure = closer.store.closeAssessmentProducerGate(randomUUID(), staged.permit.generation);
    await reached(closer.locked.promise);
    staleReader.resume.resolve();
    effect = delayed.store.withAssessmentProducerEffects(
      pending.admission,
      pendingStage.requestDigest,
      staged.permit,
      async () => {
        effects++;
        return pending.terminal;
      },
    );
    effectSettled = effect.catch(() => undefined);
    await waitingForProducerLock(staleReader.backendPids[0]!, 'RowExclusiveLock');
    await reached(delayed.connected.promise);
    await waitingForProducerLock(delayed.backendPids[0]!, 'RowExclusiveLock');
    const lock = delayed.queries.findIndex((sql) =>
      /LOCK TABLE verification\.assessment_producer IN ROW EXCLUSIVE MODE/i.test(sql),
    );
    const firstSelect = delayed.queries.findIndex((sql) => /\bSELECT\b/i.test(sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(firstSelect).toBe(-1);
  } finally {
    staleReader.resume.resolve();
    closer.resume.resolve();
    if (closure) await closure;
    await stageSettled;
    if (effectSettled) await effectSettled;
  }
  await expect(staging).rejects.toThrow('gate changed');
  if (effect === undefined) throw new Error('Delayed effect did not reach the table barrier');
  await expect(effect).rejects.toThrow('gate changed');
  expect(effects).toBe(0);
  expect(await f.store.readAssessmentProducer(f.admission)).toBeNull();
  expect((await pending.store.readAssessmentProducer(pending.admission))?.terminal).toBeNull();
  expectPlainGateReads(staleReader.queries);
  expectPlainGateReads(delayed.queries);
  const permit = await closure!;
  await pending.store.withAssessmentProducerEffects(
    pending.admission,
    pendingStage.requestDigest,
    permit,
    async () => pending.terminal,
  );
}, 15_000);

test('the indexed pending seek cannot skip a locked earliest producer', async () => {
  const first = fixture();
  const second = fixture();
  const fixtures = [first, second].sort((a, b) => a.admission.localeCompare(b.admission));
  const staged: StagedAssessmentProducer[] = [];
  for (const f of fixtures) staged.push(await f.store.stageAssessmentProducer(originalIntent(f)));
  const permit = await first.store.closeAssessmentProducerGate(
    randomUUID(),
    staged[0]!.permit.generation,
  );
  const lock = await pool.connect();
  const measured = heldQueries(() => false);
  try {
    await lock.query('BEGIN');
    await lock.query(
      'SELECT admission_id FROM verification.assessment_producer WHERE admission_id = $1 FOR UPDATE',
      [fixtures[0]!.admission],
    );
    await expect(measured.store.listPendingAssessmentProducers(permit, null, 1)).rejects.toThrow(
      'lock timeout',
    );
    const seek = measured.queries.find((sql) =>
      /FROM verification.assessment_producer WHERE terminal IS NULL/.test(sql),
    );
    expect(seek).toContain('ORDER BY admission_id LIMIT');
    expect(seek).toContain('FOR UPDATE');
    expect(seek).not.toMatch(/SKIP LOCKED|count\s*\(/i);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  const page = await first.store.listPendingAssessmentProducers(permit, null, 1);
  expect(page.map((row) => row.admission)).toEqual([fixtures[0]!.admission]);
  expect(
    (await first.store.listPendingAssessmentProducers(permit, page[0]!.admission, 1)).map(
      (row) => row.admission,
    ),
  ).toEqual([fixtures[1]!.admission]);
  const plan = (
    await pool.query(
      `EXPLAIN (FORMAT JSON) SELECT admission_id FROM verification.assessment_producer
    WHERE terminal IS NULL AND admission_id > $1::uuid ORDER BY admission_id LIMIT 1`,
      ['00000000-0000-0000-0000-000000000000'],
    )
  ).rows[0]['QUERY PLAN'][0].Plan;
  // The partial keyset index is a real schema authority, independent of the
  // planner preferring a seq scan for this tiny isolated fixture.
  expect(
    (
      await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'verification'
    AND indexname = 'assessment_producer_pending'`)
    ).rows[0].indexdef,
  ).toMatch(/admission_id.*WHERE \(terminal IS NULL\)/);
  expect(plan['Node Type']).toBe('Limit');
  for (const f of fixtures)
    await f.store.withAssessmentProducerEffects(
      f.admission,
      originalIntent(f).requestDigest,
      permit,
      async () => f.terminal,
    );
}, 15_000);

test('closed producer audit includes sparse terminal and pending rows and consumes malformed originals', async () => {
  const minimum = '00000000-0000-0000-0000-000000000000';
  const terminal = fixture(minimum);
  const pending = fixture('00000000-0000-0000-0000-000000000010');
  const invalid = fixture('00000000-0000-0000-0000-000000000030');
  const later = fixture('00000000-0000-0000-0000-000000001000');
  const original = await terminal.store.stageAssessmentProducer(originalIntent(terminal));
  await terminal.store.withAssessmentProducerEffects(
    terminal.admission,
    original.row.requestDigest,
    original.permit,
    async () => terminal.terminal,
  );
  const unresolved = await pending.store.stageAssessmentProducer(originalIntent(pending));
  await seedProducerRows(invalid, [invalid.admission], 'unreviewed:assessment');
  const laterOriginal = await later.store.stageAssessmentProducer(originalIntent(later));
  await later.store.withAssessmentProducerEffects(
    later.admission,
    laterOriginal.row.requestDigest,
    laterOriginal.permit,
    async () => later.terminal,
  );
  const permit = await terminal.store.closeAssessmentProducerGate(
    randomUUID(),
    original.permit.generation,
  );
  const first = await terminal.store.auditAssessmentProducers(permit, null, 2);
  expect(first.scope).toBe('content-assessment-producer');
  expect(first.entries).toEqual([
    { status: 'terminal', producer: { ...original.row, terminal: terminal.terminal } },
    { status: 'unresolved', reason: 'pending', producer: unresolved.row },
  ]);
  expect(first.eof).toBe(false);
  expect(first.frontier).toEqual(auditFrontier(permit, pending.admission));
  const second = await terminal.store.auditAssessmentProducers(permit, first.frontier, 2);
  expect(second.entries).toEqual([
    { status: 'unresolved', reason: 'invalid-original', admission: invalid.admission },
    { status: 'terminal', producer: { ...laterOriginal.row, terminal: later.terminal } },
  ]);
  expect(second.frontier).toEqual(auditFrontier(permit, later.admission));
  expect(second.eof).toBe(false);
  let page = second;
  for (let pages = 0; !page.eof && pages < 8; pages++) {
    page = await terminal.store.auditAssessmentProducers(permit, page.frontier);
    expect(page.scope).toBe('content-assessment-producer');
  }
  expect(page.eof).toBe(true);
  expect(page.frontier).toBeNull();
  const empty = auditFrontier(permit, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
  expect(await terminal.store.auditAssessmentProducers(permit, empty, 1)).toEqual({
    scope: 'content-assessment-producer',
    entries: [],
    frontier: null,
    eof: true,
  });
  const wrongPermit = { ...permit, generation: String(BigInt(permit.generation) + 1n) };
  await expect(
    terminal.store.auditAssessmentProducers(
      wrongPermit,
      auditFrontier(wrongPermit, empty.after),
      1,
    ),
  ).rejects.toThrow('gate changed');
  await expect(terminal.store.auditAssessmentProducers(original.permit, null, 1)).rejects.toThrow();
  await expect(
    terminal.store.auditAssessmentProducers(
      permit,
      { ...empty, generation: String(BigInt(permit.generation) + 1n) },
      1,
    ),
  ).rejects.toThrow();
  await expect(
    terminal.store.auditAssessmentProducers(permit, { ...empty, job: randomUUID() }, 1),
  ).rejects.toThrow();
  await expect(
    terminal.store.auditAssessmentProducers(
      permit,
      { ...empty, restoreEpoch: String(BigInt(permit.restoreEpoch) + 1n) },
      1,
    ),
  ).rejects.toThrow();
  for (const limit of [0, 33])
    await expect(terminal.store.auditAssessmentProducers(permit, empty, limit)).rejects.toThrow();
  await pending.store.withAssessmentProducerEffects(
    pending.admission,
    unresolved.row.requestDigest,
    permit,
    async () => pending.terminal,
  );
});

test('closed audit waits for its earliest retained row and remains compatible with unrelated maintenance effects', async () => {
  const f = fixture();
  const stage = await f.store.stageAssessmentProducer(originalIntent(f));
  const sameWindow = fixture('30000000-0000-0000-0000-000000000001');
  const sameWindowStage = await sameWindow.store.stageAssessmentProducer(
    originalIntent(sameWindow),
  );
  const permit = await f.store.closeAssessmentProducerGate(randomUUID(), stage.permit.generation);
  const lock = await pool.connect();
  let blocked: Awaited<ReturnType<typeof settlement>> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query(
      'SELECT admission_id FROM verification.assessment_producer WHERE admission_id = $1 FOR UPDATE',
      ['00000000-0000-0000-0000-000000000000'],
    );
    blocked = await settlement(f.store.auditAssessmentProducers(permit, null, 1));
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect(blocked!.status).toBe('rejected');
  if (blocked!.status === 'rejected') expect(blocked!.error.message).toContain('lock timeout');
  const held = heldQueries(
    (sql) =>
      /FROM verification\.assessment_producer/.test(sql) &&
      /ORDER BY admission_id/.test(sql) &&
      /FOR SHARE/.test(sql),
  );
  const auditing = settlement(held.store.auditAssessmentProducers(permit, null, 1));
  let sealed: Awaited<ReturnType<VerificationStore['withAssessmentProducerEffects']>> | undefined;
  try {
    await reached(held.locked.promise);
    sealed = await f.store.withAssessmentProducerEffects(
      f.admission,
      stage.row.requestDigest,
      permit,
      async () => f.terminal,
    );
  } finally {
    held.resume.resolve();
  }
  expect(sealed?.terminal).toEqual(f.terminal);
  const outcome = await auditing;
  expect(outcome.status).toBe('fulfilled');
  if (outcome.status === 'fulfilled') expect(outcome.value.entries).toHaveLength(1);
  const sql = held.queries.find(
    (query) => /ORDER BY admission_id/.test(query) && /FOR SHARE/.test(query),
  );
  expect(sql).not.toMatch(/terminal IS NULL|SKIP LOCKED|OFFSET|count\s*\(/i);
  expectPlainGateReads(held.queries);
  const effectHeld = heldQueries((query) =>
    /FROM verification\.assessment_producer WHERE admission_id = \$1 FOR UPDATE/.test(query),
  );
  const committing = settlement(
    effectHeld.store.withAssessmentProducerEffects(
      sameWindow.admission,
      sameWindowStage.row.requestDigest,
      permit,
      async () => sameWindow.terminal,
    ),
  );
  const reader = heldQueries(() => false);
  let resumedAudit:
    | ReturnType<
        typeof settlement<Awaited<ReturnType<VerificationStore['auditAssessmentProducers']>>>
      >
    | undefined;
  try {
    await reached(effectHeld.locked.promise);
    resumedAudit = settlement(
      reader.store.auditAssessmentProducers(
        permit,
        auditFrontier(permit, '30000000-0000-0000-0000-000000000000'),
        1,
      ),
    );
    await reached(reader.connected.promise);
    await waitingForAuditRow(reader.backendPids[0]!);
  } finally {
    effectHeld.resume.resolve();
  }
  const committed = await committing;
  const resumed = await resumedAudit!;
  expect(committed.status).toBe('fulfilled');
  expect(resumed.status).toBe('fulfilled');
  if (resumed.status === 'fulfilled')
    expect(resumed.value.entries).toEqual([
      { status: 'terminal', producer: { ...sameWindowStage.row, terminal: sameWindow.terminal } },
    ]);
}, 15_000);

test('closed audit seeks one fixed primary-key page at 64 and 10000 producers', async () => {
  const f = fixture();
  const lowerBound = '60000000-0000-0000-0000-000000000000';
  const admission = (ordinal: number) =>
    `60000000-0000-0000-0000-${ordinal.toString(16).padStart(12, '0')}`;
  await seedProducerRows(
    f,
    Array.from({ length: 64 }, (_, index) => admission(index + 1)),
  );
  await pool.query('ANALYZE verification.assessment_producer');
  const generation = (
    await pool.query(
      'SELECT generation::text FROM verification.assessment_producer_gate WHERE singleton',
    )
  ).rows[0].generation;
  const firstPermit = await f.store.closeAssessmentProducerGate(randomUUID(), generation);
  async function measure(permit: AssessmentProducerPermit, population: number) {
    const observed = heldQueries(() => false);
    const page = await observed.store.auditAssessmentProducers(
      permit,
      auditFrontier(permit, lowerBound),
      32,
    );
    expect(page.entries).toHaveLength(32);
    expect(page.entries.every((entry) => entry.status === 'terminal')).toBe(true);
    expect(page.eof).toBe(false);
    expect(page.frontier).toEqual(auditFrontier(permit, admission(32)));
    const query = observed.calls.find(
      (call) =>
        /FROM verification\.assessment_producer/.test(call.sql) &&
        /ORDER BY admission_id/.test(call.sql) &&
        /FOR SHARE/.test(call.sql),
    );
    if (!query) throw new Error('Missing actual audit page query');
    expect(query.sql).not.toMatch(/terminal IS NULL|OFFSET|SKIP LOCKED|count\s*\(/i);
    expect(query.values).toEqual([lowerBound, 33]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const planner = observed.calls.filter((call) =>
        /^SET LOCAL enable_sort = off$/.test(call.sql),
      );
      expect(planner).toHaveLength(1);
      for (const setting of planner) await client.query(setting.sql, setting.values);
      const plan = (
        await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${query.sql}`,
          query.values,
        )
      ).rows[0]['QUERY PLAN'][0].Plan;
      type PlanNode = {
        'Node Type': string;
        'Index Name'?: string;
        'Actual Rows': number;
        'Actual Loops': number;
        Plans?: PlanNode[];
      };
      const nodes: PlanNode[] = [];
      function visit(node: PlanNode) {
        nodes.push(node);
        for (const child of node.Plans ?? []) visit(child);
      }
      visit(plan);
      const buffers = (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
      console.log(
        JSON.stringify({
          case: 'assessment-producer-audit-page',
          population,
          rows: plan['Actual Rows'],
          loops: plan['Actual Loops'],
          buffers,
          nodes: nodes.map((node) => ({
            type: node['Node Type'],
            index: node['Index Name'],
            rows: node['Actual Rows'],
          })),
        }),
      );
      expect(nodes.some((node) => /Sort|Seq Scan/.test(node['Node Type']))).toBe(false);
      const index = nodes.find((node) => node['Index Name'] === 'assessment_producer_pkey');
      expect(index).toBeDefined();
      expect(index?.['Actual Rows']).toBe(33);
      expect(index?.['Actual Loops']).toBe(1);
      expect(plan['Actual Rows']).toBe(33);
      expect(plan['Actual Loops']).toBe(1);
      expect(buffers).toBeLessThanOrEqual(256);
      await client.query('ROLLBACK');
      return { buffers, sql: query.sql, rows: index?.['Actual Rows'] };
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  const small = await measure(firstPermit, 64);
  // Only the isolated fixture reopens its gate to prepare a larger corpus;
  // each measured page uses a newly acquired exact maintenance permit.
  await pool.query(
    "UPDATE verification.assessment_producer_gate SET mode = 'ordinary', job = NULL WHERE singleton",
  );
  await seedProducerRows(
    f,
    Array.from({ length: 9936 }, (_, index) => admission(index + 65)),
  );
  await pool.query('ANALYZE verification.assessment_producer');
  const largePermit = await f.store.closeAssessmentProducerGate(
    randomUUID(),
    firstPermit.generation,
  );
  const large = await measure(largePermit, 10000);
  expect(large.sql).toBe(small.sql);
  expect(large.rows).toBe(small.rows);
  expect(large.buffers).toBeLessThanOrEqual(small.buffers + 16);
}, 30_000);

test('closed audit rechecks restore epoch after reading its page', async () => {
  const f = fixture();
  const stage = await f.store.stageAssessmentProducer(originalIntent(f));
  const permit = await f.store.closeAssessmentProducerGate(randomUUID(), stage.permit.generation);
  const epoch = (
    await pool.query('SELECT version::text FROM reading_position.generation WHERE singleton')
  ).rows[0].version;
  const held = heldQueries(
    (sql) =>
      /FROM verification\.assessment_producer/.test(sql) &&
      /ORDER BY admission_id/.test(sql) &&
      /FOR SHARE/.test(sql),
  );
  const auditing = settlement(held.store.auditAssessmentProducers(permit, null, 1));
  try {
    await reached(held.locked.promise);
    await pool.query(
      'UPDATE reading_position.generation SET version = version + 1 WHERE singleton',
    );
  } finally {
    held.resume.resolve();
  }
  const outcome = await auditing;
  try {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error.message).toContain('restore epoch');
  } finally {
    await pool.query('UPDATE reading_position.generation SET version = $1 WHERE singleton', [
      epoch,
    ]);
  }
  await f.store.withAssessmentProducerEffects(
    f.admission,
    stage.row.requestDigest,
    permit,
    async () => f.terminal,
  );
}, 15_000);

test('a changed restore epoch refuses the saved cut and leaves the original intent unresolved', async () => {
  const f = fixture();
  const stage = originalIntent(f);
  const staged = await f.store.stageAssessmentProducer(stage);
  const permit = await f.store.closeAssessmentProducerGate(randomUUID(), staged.permit.generation);
  await pool.query('UPDATE reading_position.generation SET version = version + 1 WHERE singleton');
  let effects = 0;
  await expect(
    f.store.withAssessmentProducerEffects(f.admission, stage.requestDigest, permit, async () => {
      effects++;
      return f.terminal;
    }),
  ).rejects.toThrow('restore epoch');
  await expect(f.store.listPendingAssessmentProducers(permit)).rejects.toThrow('restore epoch');
  expect(effects).toBe(0);
  const retained = await f.store.readAssessmentProducer(f.admission, stage.requestDigest);
  expect(retained?.intent).toEqual(stage.intent);
  expect(retained?.restoreEpoch).toBe(staged.row.restoreEpoch);
  expect(retained?.terminal).toBeNull();
});
