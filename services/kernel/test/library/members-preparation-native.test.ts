import { runOperationalTransaction } from '../../src/command/operational.ts';
import { partitionOf } from '../../src/route/route.ts';
import { readPreparedMembers } from '../../src/library/members-preparation.ts';
import { testTokens, testRouteKey } from '../support/test-kernel.ts';
import { capture } from '../support/growth.ts';
import { startErasureWorker } from './support/erasure-worker.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { definition, membersPreparationRuntime } from './support/members-preparation-runtime.ts';

let native: Awaited<ReturnType<typeof membersPreparationRuntime>>;

beforeAll(async () => {
  native = await membersPreparationRuntime();
}, 120000);

afterAll(async () => {
  await native?.close();
});

test('a mounted private Collection can reserve, touch and admit its exact native episode', async () => {
  const fixture = await native.fixture();
  const reserved = await fixture.store.reserve(fixture.actor, fixture.collectionId, [definition()]);
  expect(reserved.episodes).toHaveLength(1);
  const [episode] = reserved.episodes;
  expect(episode).toMatchObject({ state: 'preparing', locator: { collectionId: fixture.collectionId } });
  expect(reserved.intent?.input.episodes).toEqual([
    { collectionId: fixture.collectionId, episodeId: episode!.locator.episodeId },
  ]);
  expect((await native.workflow(episode!.workflowId)).status?.status).toBe('ENQUEUED');
  expect(await fixture.store.touch(fixture.actor, episode!.locator)).toBe(true);
  expect(await native.step(episode!.locator)).toBe(true);
});

test('real authenticated id and ordinal reservations share the retained mechanism and admission never certifies readiness', async () => {
  const f = await native.fixture();
  const definitions = [definition(), { ...definition(), sort: 'ordinal' as const }];
  const first = await f.store.reserve(f.actor, f.collectionId, definitions);
  expect(first.episodes).toHaveLength(2);
  expect(first.intent!.input.episodes).toHaveLength(2);
  const duplicate = await f.store.reserve(f.actor, f.collectionId, definitions);
  expect(duplicate.episodes).toEqual(first.episodes);
  expect(duplicate.intent).toBeNull();
  const before = await native.rows(f.owner);
  for (const episode of first.episodes) {
    expect(await native.step(episode.locator)).toBe(true);
  }
  expect(await native.rows(f.owner)).toEqual(before);
});

test('an exact episode cannot be admitted under another native fenced owner', async () => {
  const f = await native.fixture();
  const episode = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  const locator = episode.locator;
  expect(
    await runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(locator.route),
        kind: 'library.membersPreparation.step',
        accounts: [native.personas.bob.accountId],
        workClient: native.workClient,
      },
      (tx) => f.store.admitStep(tx, locator),
    ),
  ).toBe(false);
  expect(await native.step(locator)).toBe(true);
});

test('Real authenticated members preparation reserves exact episodes once, admits actual default worker steps and returns useful bounded ready pages through the existing ordered scope producer', async () => {
  const f = await native.fixture();
  const granted = await native.send(native.personas.staff, 'POST', '/v1/grants', {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: f.owner.accountId },
    actions: ['subject:create'],
    valid: '(,)',
  });
  expect(granted.status).toBe(201);
  const subjects: string[] = [];
  for (let index = 0; index < 4; index++) {
    const created = await native.send(f.owner, 'POST', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: `Native preparation member ${index}` },
    });
    expect(created.status).toBe(201);
    const subject = ((await created.json()) as { subject: { id: string } }).subject.id;
    subjects.push(subject);
    const added = await native.send(f.owner, 'POST', `/v1/collections/${f.collectionId}/members`, {
      subjectId: subject,
    });
    expect(added.status).toBe(201);
  }
  // Occurrences remain distinct in editing; browsing must not spend a second result slot on this duplicate.
  expect(
    (
      await native.send(f.owner, 'POST', `/v1/collections/${f.collectionId}/members`, {
        subjectId: subjects[0],
      })
    ).status,
  ).toBe(201);
  const admitted = { ...definition(), filter: { type: { in: ['schema:Book'] } } };
  const definitions = [admitted, { ...admitted, sort: 'ordinal' as const }];
  const first = await f.store.reserve(f.actor, f.collectionId, definitions);
  const duplicate = await f.store.reserve(f.actor, f.collectionId, definitions);
  expect(first.episodes).toHaveLength(2);
  expect(first.intent!.input.episodes).toHaveLength(2);
  expect(duplicate.episodes).toEqual(first.episodes);
  expect(duplicate.intent).toBeNull();
  const locator = first.episodes[0]!.locator;
  expect(await native.step(locator)).toBe(true);
  const path = `/v1/collections/${f.collectionId}/members?filter=${encodeURIComponent(JSON.stringify(admitted.filter))}&sort=id&limit=3`;
  const initial = await native.send(f.owner, 'GET', path);
  expect(initial.status).toBe(202);
  expect(initial.headers.get('retry-after')).not.toBeNull();
  expect(await initial.json()).toEqual({ preparing: true });
  // Reuse the existing default-worker fixture with this fixture's genuine route key.
  const previousRouteKey = process.env.KERNEL_ROUTE_KEY;
  process.env.KERNEL_ROUTE_KEY = Buffer.from(testRouteKey()).toString('base64url');
  let worker: Awaited<ReturnType<typeof startErasureWorker>>;
  try {
    worker = await startErasureWorker(native.db.url, native.workClient);
  } finally {
    if (previousRouteKey === undefined) delete process.env.KERNEL_ROUTE_KEY;
    else process.env.KERNEL_ROUTE_KEY = previousRouteKey;
  }
  try {
    await native.workClient.retrieveWorkflow(first.intent!.workflowId).getResult({ pollingIntervalMs: 10 });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await native.send(f.owner, 'GET', path);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      if (response.status === 202) {
        await Bun.sleep(20);
        continue;
      }
      expect(response.status).toBe(200);
      const page = (await response.json()) as { members: { subjectId: string }[]; next: string | null };
      expect(page.members.map((member) => member.subjectId)).toEqual([...subjects].sort().slice(0, 3));
      expect(new Set(page.members.map((member) => member.subjectId)).size).toBe(3);
      expect(page.next).toBeString();
      const ordinal = await readPreparedMembers(
        { pool: native.db.pool, access: native.kernel.testAccess, tokens: testTokens() },
        { actor: f.actor, collectionId: f.collectionId, definition: definitions[1]!, deadline },
        { limit: 3 },
      );
      if (ordinal.status === 'preparing') {
        await Bun.sleep(20);
        continue;
      }
      expect(ordinal.status).toBe('ready');
      if (ordinal.status !== 'ready') throw new Error('Ordinal producer unavailable');
      try {
        expect(ordinal.subjects).toEqual(subjects.slice(0, 3));
        await ordinal.revalidate();
      } finally {
        ordinal.release();
      }
      return;
    }
    throw new Error(`Finite native preparation never produced useful id and ordinal pages: ${worker.output}`);
  } finally {
    await worker.close();
  }
}, 120000);

test('successful current touch survives until exact idle expiry and a replacement never revives the old episode', async () => {
  const f = await native.fixture();
  const first = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  native.advance(1);
  expect(await f.store.touch(f.actor, first.locator)).toBe(true);
  native.advance(24 * 60 * 60 * 1000);
  expect(await f.store.touch(f.actor, first.locator)).toBe(false);
  expect(await native.step(first.locator)).toBe(false);
  const replacement = await f.store.reserve(f.actor, f.collectionId, [definition()]);
  expect(replacement.episodes[0]!.locator.episodeId).not.toBe(first.locator.episodeId);
  expect(replacement.intent!.input.cleanup).toEqual([
    {
      collectionId: first.locator.collectionId,
      episodeId: first.locator.episodeId,
    },
  ]);
  expect(await f.store.touch(f.actor, first.locator)).toBe(false);
  expect(await native.step(replacement.episodes[0]!.locator)).toBe(true);
});

test('reservation preserves native timestamp precision immediately before idle expiry', async () => {
  const f = await native.fixture();
  const first = await f.store.reserve(f.actor, f.collectionId, [definition()]);
  const locator = first.episodes[0]!.locator;
  // Schedule only an already admitted episode. JavaScript millisecond truncation would expire it early.
  await native.db.admin.query(
    `UPDATE library.members_preparation SET last_read_at=last_read_at - interval '24 hours' + interval '0.0005 seconds'
     WHERE route=$1 AND owner_account_id=$2 AND collection_id=$3 AND episode_id=$4`,
    [locator.route, locator.ownerAccountId, locator.collectionId, locator.episodeId],
  );
  expect(await native.step(locator)).toBe(true);
  const duplicate = await f.store.reserve(f.actor, f.collectionId, [definition()]);
  expect(duplicate.episodes).toEqual(first.episodes);
  expect(duplicate.intent).toBeNull();
});

test('the native work-definition getter refuses another fenced owner and a closed transaction without effects', async () => {
  const f = await native.fixture();
  const locator = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!.locator;
  const before = await native.rows(f.owner);
  const closed = await runOperationalTransaction(
    native.db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: 'library.membersPreparation.step',
      accounts: [locator.ownerAccountId],
      workClient: native.workClient,
    },
    async (tx) => {
      expect(await f.store.admitStep(tx, locator)).toBe(true);
      return tx;
    },
  );
  expect(await f.store.readWorkDefinition(closed, locator)).toBeNull();
  expect(
    await runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(locator.route),
        kind: 'library.membersPreparation.step',
        accounts: [native.personas.bob.accountId],
        workClient: native.workClient,
      },
      (tx) => f.store.readWorkDefinition(tx, locator),
    ),
  ).toBeNull();
  expect(await native.rows(f.owner)).toEqual(before);
});

test('incomplete and unavailable episodes cannot disclose ready-empty or become authority after owner termination', async () => {
  const f = await native.fixture();
  const reserved = await f.store.reserve(f.actor, f.collectionId, [definition()]);
  const locator = reserved.episodes[0]!.locator;
  const path = `/v1/collections/${f.collectionId}/members?filter=${encodeURIComponent(JSON.stringify(definition().filter))}&sort=id`;
  const first = await native.send(f.owner, 'GET', path);
  expect([202, 503]).toContain(first.status);
  expect(await native.rows(f.owner)).not.toHaveLength(0);
  await native.deletePersona(f.owner);
  expect(await native.step(locator)).toBe(false);
  expect(
    await f.store.touch(f.actor, locator).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  const denied = await native.send(f.owner, 'GET', path);
  expect(denied.status).toBe(401);
});

test('native quota eviction keeps a touched episode and repeated admission writes nothing', async () => {
  const f = await native.fixture();
  const first = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  for (let index = 1; index < 32; index++) await f.store.reserve(f.actor, f.collectionId, [definition(index)]);
  native.advance(1);
  expect(await f.store.touch(f.actor, first.locator)).toBe(true);
  const before = await native.rows(f.owner);
  const oldest = before
    .filter((row) => row.episode_id !== first.locator.episodeId)
    .sort((a, b) => a.episode_id.localeCompare(b.episode_id))[0]!;
  const replacement = await f.store.reserve(f.actor, f.collectionId, [definition(32)]);
  expect(replacement.intent!.input.cleanup).toEqual([{ collectionId: f.collectionId, episodeId: oldest.episode_id }]);
  const retained = await native.rows(f.owner);
  expect(retained.filter((row) => row.state === 'live')).toHaveLength(32);
  expect(retained.find((row) => row.episode_id === first.locator.episodeId)?.state).toBe('live');
  const duplicate = await capture(native.db, () => f.store.reserve(f.actor, f.collectionId, [definition(32)]));
  expect(duplicate.value.intent).toBeNull();
  expect(await native.rows(f.owner)).toEqual(retained);
  expect(
    duplicate.capture.statements.some((sql) => /\b(?:INSERT INTO|UPDATE\s+library\.|DELETE FROM)\b/i.test(sql)),
  ).toBe(false);
});

test('a native enqueue failure rolls back both retained admission and its control row', async () => {
  const f = await native.fixture();
  const before = await native.domain();
  await native.db.admin.query(`CREATE FUNCTION library.members_preparation_test_enqueue_failure() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workflow_uuid LIKE 'library:members-preparation:%' THEN RAISE EXCEPTION 'members enqueue failure'; END IF;
      RETURN NEW;
    END $$`);
  await native.db.admin
    .query(`CREATE TRIGGER members_preparation_test_enqueue_failure BEFORE INSERT ON dbos.workflow_input
    FOR EACH ROW EXECUTE FUNCTION library.members_preparation_test_enqueue_failure()`);
  try {
    await expect(f.store.reserve(f.actor, f.collectionId, [definition()])).rejects.toThrow('members enqueue failure');
    expect(await native.rows(f.owner)).toEqual([]);
    expect(
      (
        await native.db.admin.query(
          `SELECT 1 FROM core.operational_work_original
      WHERE operation_accounts=jsonb_build_array($1::text)`,
          [f.owner.accountId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await native.db.admin.query(
          `SELECT 1 FROM core.operational_work_mapping
      WHERE source->'binding'->>'ownerAccountId'=$1`,
          [f.owner.accountId],
        )
      ).rows,
    ).toEqual([]);
    expect(await native.domain()).toEqual(before);
    const control = await native.db.admin.query(
      'SELECT 1 FROM library.members_preparation_owner WHERE owner_account_id=$1',
      [f.owner.accountId],
    );
    expect(control.rows).toEqual([]);
  } finally {
    await native.db.admin.query('DROP TRIGGER members_preparation_test_enqueue_failure ON dbos.workflow_input');
    await native.db.admin.query('DROP FUNCTION library.members_preparation_test_enqueue_failure()');
  }
});

test('concurrent genuine reservations bind the inserted native tuple and enqueue/receive the original exactly once', async () => {
  const f = await native.fixture();
  const definitions = [definition(), { ...definition(), sort: 'ordinal' as const }];
  const attempts = await Promise.all([
    f.store.reserve(f.actor, f.collectionId, definitions),
    f.store.reserve(f.actor, f.collectionId, definitions),
  ]);
  expect(attempts.filter((result) => result.intent !== null)).toHaveLength(1);
  expect(attempts[0]!.episodes).toEqual(attempts[1]!.episodes);
  const created = attempts.find((result) => result.intent !== null)!;
  const rows = await native.rows(f.owner);
  expect(rows).toHaveLength(2);
  const originals = await native.db.admin.query(
    `SELECT * FROM core.operational_work_original
    WHERE partition_no=$1 AND workflow_id=$2`,
    [partitionOf(created.intent!.input.route), created.intent!.workflowId],
  );
  expect(originals.rows).toHaveLength(1);
  const original = originals.rows[0]!;
  expect(original.operation_accounts).toEqual([f.owner.accountId]);
  expect(original.source_domain).toBe('operational-work/v1');
  expect(original.sealed).toBe(true);
  expect(original.creation_captured).toBe(true);
  expect(original.intent).toEqual(created.intent);
  expect(original.binding.episodes).toEqual(
    rows.map((row) => ({
      collectionId: row.collection_id,
      episodeId: row.episode_id,
      reservedIncarnation: row.reserved_incarnation,
      reservedGeneration: String(row.reserved_generation),
      canonicalBasis: row.canonical_basis,
      basisDigest: Buffer.from(row.basis_digest).toString('hex'),
    })),
  );
  for (const row of rows) {
    expect(row.original_custody_id).toBe(original.custody_id);
    expect(row.original_transaction_id).toBe(original.transaction_id);
    expect(row.original_epoch).toBe(original.source_epoch);
    expect(row.original_generation).toBe(original.source_generation);
    expect(row.original_position).toBe(original.source_position);
  }
  // Receiving is possible only after the source COMMIT/release, using the original live transfers.
  const mapping = await native.db.admin.query(
    `SELECT source FROM core.operational_work_mapping
    WHERE partition_no=0 AND custody_id=$1`,
    [original.custody_id],
  );
  expect(mapping.rows).toHaveLength(1);
  expect(mapping.rows[0]!.source.stamp.domain).toBe('operational-work/v1');
  const sdk = await native.db.admin.query('SELECT 1 FROM dbos.workflow_input WHERE workflow_uuid=$1', [
    created.intent!.workflowId,
  ]);
  expect(sdk.rows).toHaveLength(1);
});
