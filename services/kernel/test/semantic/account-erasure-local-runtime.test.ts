import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EXTENSION_FORMAT, termPrefix } from '@rezics/definitions/extension';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { GLOBAL_CONTEXT, readRelease } from '../../src/semantic/definitions.ts';
import { effectiveRelease } from '../../src/semantic/extensions.ts';
import { routeOf } from '../../src/route/route.ts';
import { accountErasureFixture, type AccountErasureFixture } from './support/account-erasure-fixture.ts';
import { beginSemanticErasure, readSemanticErasure, stepSemanticErasure } from '../../src/semantic/account-erasure.ts';
import { accountErasureWorker } from './support/account-erasure-worker.ts';
import { createBody as starterBody } from '../zones/resource-fixture.ts';

const createBody = () => {
  const input = starterBody();
  input.configuration.scope = [];
  return input;
};
let f: AccountErasureFixture;
beforeAll(async () => {
  f = await accountErasureFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

test('indexed native local cleanup resumes committed pages and remains idle pending shared custody', async () => {
  const author = await f.author();
  const other = await f.author();
  const created = await f.call(author, 'POST', '/v1/subjects', {
    type: 'schema:Person',
    labels: { en: 'Communal public person' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const subject = created.body.subject.id as string;
  const proposed = await f.call(author, 'POST', `/v1/subjects/${subject}/candidates`, {
    statement: {
      property: { id: 'rezics:penNameOf' },
      value: { type: 'value', content: accountAgentId(author.accountId) },
    },
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  await f.grant(GLOBAL_CONTEXT, author, ['zone:create']);
  const zone = await f.call(author, 'POST', '/v1/zones', createBody());
  expect(zone.status, JSON.stringify(zone.body)).toBe(201);
  const zoneId = zone.body.zone.id as string;
  await f.grantAs(author, zoneId, other, ['zone:read', 'zone:configure']);
  expect((await f.call(other, 'GET', `/v1/zones/${zoneId}/configuration`)).status).toBe(200);
  const context = await f.call(author, 'POST', '/v1/contexts', {
    labels: { en: 'Personal Context payload' },
  });
  expect(context.status, JSON.stringify(context.body)).toBe(201);
  const transferred = await f.call(author, 'POST', '/v1/contexts', {
    labels: { en: 'Transferred communal Context' },
  });
  expect(transferred.status, JSON.stringify(transferred.body)).toBe(201);
  const transferredId = transferred.body.context.id as string;
  const roleRows = await f.db.admin.query(
    `SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
    AND subject_id=$3 AND grant_role='semantic.context.owner' AND upper_inf(valid)`,
    [routeOf(transferredId), transferredId, author.accountId],
  );
  const originalRole = {
    resource: { route: routeOf(transferredId), id: transferredId },
    subject: { kind: 'account', id: author.accountId },
    role: 'semantic.context.owner',
    valid: roleRows.rows[0].valid,
  };
  const newRole = {
    ...originalRole,
    subject: { kind: 'account', id: other.accountId },
  };
  expect((await f.call(author, 'POST', '/v1/roleGrants', newRole)).status).toBe(201);
  expect((await f.call(author, 'POST', '/v1/roleGrants:revoke', originalRole)).status).toBe(200);
  const transferredBefore = await f.db.admin.query('SELECT * FROM semantic.context WHERE route=$1 AND context_id=$2', [
    routeOf(transferredId),
    transferredId,
  ]);
  const unlisted = await f.call(author, 'POST', '/v1/zones', createBody());
  expect(unlisted.status, JSON.stringify(unlisted.body)).toBe(201);
  const published = await f.call(
    author,
    'POST',
    `/v1/zones/${unlisted.body.zone.id}:publish`,
    { visibility: 'unlisted' },
    { 'if-match': JSON.stringify(unlisted.body.zone.revision) },
  );
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect((await f.call(undefined, 'GET', `/v1/zones/${unlisted.body.zone.id}`)).status).toBe(200);
  const archived = await f.call(author, 'POST', '/v1/zones', createBody());
  expect(archived.status, JSON.stringify(archived.body)).toBe(201);
  const removed = await f.call(author, 'DELETE', `/v1/zones/${archived.body.zone.id}`, undefined, {
    'if-match': JSON.stringify(archived.body.zone.revision),
  });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);

  await f.grant(GLOBAL_CONTEXT, other, ['zone:create']);
  const survivor = await f.call(other, 'POST', '/v1/zones', createBody());
  expect(survivor.status, JSON.stringify(survivor.body)).toBe(201);
  const before = await f.db.admin.query('SELECT * FROM zones.zone WHERE route=$1 AND zone_id=$2', [
    routeOf(survivor.body.zone.id),
    survivor.body.zone.id,
  ]);
  const source = await f.db.admin.query(
    `SELECT r.recorded_transaction_id FROM semantic.candidate c
    JOIN semantic.revision r USING(route,subject_id,revision)
    WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3`,
    [routeOf(subject), subject, candidate],
  );
  const transactionId = source.rows[0].recorded_transaction_id;
  const locators = await f.db.admin.query(
    `SELECT store,role,source_transaction_id,source_position::text,partition_no FROM semantic.erasure_locator
    WHERE account_id=$1 AND source_transaction_id=$2 ORDER BY store,role`,
    [author.accountId, transactionId],
  );
  expect(locators.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ store: 'candidate', role: 'actor' }),
      expect.objectContaining({ store: 'revision', role: 'actor' }),
    ]),
  );
  const candidateLocator = locators.rows.find((row) => row.store === 'candidate' && row.role === 'actor')!;
  const deletion = await f.tombstone(author);
  // Paused physical cleanup never grants current private authority to another live account.
  expect((await f.call(other, 'GET', `/v1/zones/${zoneId}/configuration`)).status).toBe(404);
  expect((await f.call(undefined, 'GET', `/v1/zones/${unlisted.body.zone.id}`)).status).toBe(404);
  expect((await f.call(undefined, 'GET', `/v1/contexts/${context.body.context.id}`)).status).toBe(404);
  await beginSemanticErasure(f.db.pool, author.accountId);
  const first = await stepSemanticErasure(f.db.pool, author.accountId);
  expect(first.rawKeys).toBeLessThanOrEqual(100);
  expect(first.bytes).toBeLessThanOrEqual(65536);
  // Each stop kills only this fixture's real default worker. Committed owner/inbox rows survive the process.
  const crashAt = async (table: string, condition: string, observe: () => Promise<void>) => {
    const lock = await f.db.admin.connect();
    const gate = 719530;
    await lock.query('SELECT pg_advisory_lock($1)', [gate]);
    await f.db.admin.query(`CREATE FUNCTION public.hold_erasure_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${gate}); END IF; RETURN NEW; END; $$;
      CREATE TRIGGER hold_erasure_checkpoint BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION public.hold_erasure_checkpoint()`);
    let interrupted: Awaited<ReturnType<typeof accountErasureWorker>> | undefined;
    try {
      console.error(`Native erasure crash boundary: ${table} ${condition}`);
      interrupted = await accountErasureWorker(f.db.url);
      const deadline = Date.now() + 120_000;
      for (;;) {
        const blocked = await f.db.admin.query(
          "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objid=$1 AND NOT granted",
          [gate],
        );
        if (blocked.rowCount) break;
        if (Date.now() > deadline) {
          const progress = await readSemanticErasure(f.db.pool, author.accountId);
          const pending = progress
            ? await f.db.admin.query(
                `SELECT store,record_key::text,role,state FROM semantic.erasure_locator
            WHERE partition_no=$1 AND account_id=$2 AND state='pending'
            ORDER BY priority,store,record_key,role LIMIT 8`,
                [progress.partition, author.accountId],
              )
            : null;
          throw new Error(
            `Native crash boundary was not reached: ${table} ${condition}; ${JSON.stringify({ progress, pending: pending?.rows })}`,
          );
        }
        await Bun.sleep(20);
      }
      await observe();
      console.error(`Native erasure crash boundary reached: ${table}`);
      await interrupted.crash();
    } finally {
      await interrupted?.crash();
      await lock.query('SELECT pg_advisory_unlock($1)', [gate]);
      lock.release();
      await f.db.admin.query(
        `DROP TRIGGER hold_erasure_checkpoint ON ${table}; DROP FUNCTION public.hold_erasure_checkpoint()`,
      );
    }
  };
  const accountCondition = `NEW.account_id='${author.accountId}'::uuid`;
  await crashAt('semantic.candidate', `NEW.candidate_id='${candidate}'::uuid AND NEW.erasure_private`, async () => {
    // The native locator inbox must commit before its blocked owning payload transaction.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const inbox = await f.db.admin.query(
        `SELECT 1 FROM semantic.erasure_inbox i JOIN semantic.candidate c ON c.erasure_key=i.record_key
        WHERE i.account_id=$1 AND i.store='candidate' AND c.candidate_id=$2 AND c.route=$3 AND i.state='pending'`,
        [author.accountId, candidate, routeOf(subject)],
      );
      if (inbox.rowCount) break;
      if (Date.now() > deadline) throw new Error('Real late locator did not commit before payload minimization');
      await Bun.sleep(20);
    }
    expect(
      (
        await f.db.admin.query(
          'SELECT erasure_private FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
          [routeOf(subject), subject, candidate],
        )
      ).rows,
    ).toEqual([{ erasure_private: false }]);
    expect(
      (
        await f.db.admin.query(
          `SELECT l.resolved_at FROM semantic.erasure_inbox i
          JOIN access.erasure_late_item l ON l.route=i.route AND l.account_id=i.account_id
            AND l.participant='semantic' AND l.locator='semantic:'||i.source_partition||':'||i.store||':'||i.record_key||':'||i.role||':'||i.delivery_position
          WHERE i.route=$1 AND i.account_id=$2 AND i.source_partition=$3 AND i.store='candidate'
            AND i.record_key=(SELECT erasure_key FROM semantic.candidate WHERE route=$4 AND subject_id=$5 AND candidate_id=$6)
            AND i.role='actor' AND i.late`,
          [
            routeOf(author.accountId),
            author.accountId,
            candidateLocator.partition_no,
            routeOf(subject),
            subject,
            candidate,
          ],
        )
      ).rows,
    ).toContainEqual({ resolved_at: null });
  });
  await crashAt(
    'semantic.erasure_inbox',
    `${accountCondition} AND NEW.state='minimized' AND NEW.store='candidate'`,
    async () => {
      expect(
        (
          await f.db.admin.query(
            'SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
            [routeOf(subject), subject, candidate],
          )
        ).rows,
      ).toEqual([{ statement: {} }]);
    },
  );
  await crashAt(
    'semantic.erasure_inbox',
    `${accountCondition} AND NEW.state='resolved' AND NEW.store='candidate'`,
    async () => {
      expect(
        (
          await f.db.admin.query(
            `SELECT state FROM semantic.erasure_inbox WHERE account_id=$1 AND store='candidate' AND record_key=(SELECT erasure_key FROM semantic.candidate WHERE route=$2 AND subject_id=$3 AND candidate_id=$4)`,
            [author.accountId, routeOf(subject), subject, candidate],
          )
        ).rows,
      ).toEqual(expect.arrayContaining([{ state: 'minimized' }]));
      expect(
        (
          await f.db.admin.query(
            `SELECT l.resolved_at IS NOT NULL AS resolved FROM semantic.erasure_inbox i
            JOIN access.erasure_late_item l ON l.route=i.route AND l.account_id=i.account_id
              AND l.participant='semantic' AND l.locator='semantic:'||i.source_partition||':'||i.store||':'||i.record_key||':'||i.role||':'||i.delivery_position
            WHERE i.route=$1 AND i.account_id=$2 AND i.source_partition=$3 AND i.store='candidate'
              AND i.record_key=(SELECT erasure_key FROM semantic.candidate WHERE route=$4 AND subject_id=$5 AND candidate_id=$6)
              AND i.role='actor' AND i.state='minimized' AND i.late`,
            [
              routeOf(author.accountId),
              author.accountId,
              candidateLocator.partition_no,
              routeOf(subject),
              subject,
              candidate,
            ],
          )
        ).rows,
      ).toContainEqual({ resolved: true });
    },
  );
  await crashAt('semantic.erasure_progress', `${accountCondition} AND NEW.partition_no=4096`, async () => {
    expect(
      (
        await f.db.admin.query('SELECT state FROM semantic.erasure_home WHERE partition_no=4095 AND account_id=$1', [
          author.accountId,
        ])
      ).rows,
    ).toEqual([{ state: 'complete' }]);
    expect((await readSemanticErasure(f.db.pool, author.accountId))?.state).toBe('local');
  });
  const worker = await accountErasureWorker(f.db.url);
  try {
    const deadline = Date.now() + 150_000;
    for (;;) {
      const completion = await f.db.admin.query(
        `SELECT p.state,w.status FROM semantic.erasure_progress p
        JOIN dbos.workflow_status w ON w.workflow_uuid=p.workflow_id
        WHERE p.route=$1 AND p.account_id=$2`,
        [routeOf(author.accountId), author.accountId],
      );
      if (completion.rows[0]?.state === 'pending-shared-custody' && completion.rows[0]?.status === 'SUCCESS') break;
      if (Date.now() > deadline) throw new Error('Default Semantic local work did not converge');
      await Bun.sleep(20);
    }
    const progress = await readSemanticErasure(f.db.pool, author.accountId);
    expect(progress).toMatchObject({
      state: 'pending-shared-custody',
      applied: true,
    });
    expect(new Date(progress!.at).toISOString()).toBe(deletion.status!.at);
    const localWork = (
      await f.db.admin.query(
        `SELECT p.workflow_id,w.name,w.queue_name,w.queue_partition_key,w.status
      FROM semantic.erasure_progress p JOIN dbos.workflow_status w ON w.workflow_uuid=p.workflow_id
      WHERE p.route=$1 AND p.account_id=$2`,
        [routeOf(author.accountId), author.accountId],
      )
    ).rows;
    expect(localWork).toEqual([
      {
        workflow_id: `semantic:erasure:${author.accountId}:${progress!.at}`,
        name: 'semantic.erasure.local',
        queue_name: 'effects',
        queue_partition_key: `semantic_erasure_local:${Math.floor(routeOf(author.accountId)! / 16)}`,
        status: 'SUCCESS',
      },
    ]);
    // Native delivery checkpoints and open-work receipts must come from the normal registered relay, even
    // when the independent local walker discovers the owning payload before that source effect does.
    const delivered = await f.db.admin.query(
      `SELECT d.source_position::text FROM semantic.erasure_delivery d
      JOIN core.outbox o ON o.partition_no=d.partition_no AND o.position=d.source_position
      JOIN access.erasure_locator_work work ON work.workflow_id='fx:'||o.epoch||':'||o.partition_no||':'||o.position||':'||o.event_seq||':semantic_erasure_locator'
      WHERE d.partition_no=$1 AND d.source_position=$2 AND work.effect='semantic_erasure_locator' AND work.state='done' LIMIT 1`,
      [candidateLocator.partition_no, candidateLocator.source_position],
    );
    expect(delivered.rows).toEqual([{ source_position: candidateLocator.source_position }]);
    expect(
      (
        await f.db.admin.query(
          `SELECT work.effect FROM core.outbox o JOIN access.erasure_locator_work work
          ON work.workflow_id='fx:'||o.epoch||':'||o.partition_no||':'||o.position||':'||o.event_seq||':semantic_erasure'
          WHERE o.partition_no=$1 AND o.subject=$2 AND o.type='com.rezics.access.account-tombstoned.v1'
            AND work.effect='semantic_erasure' AND work.state='done'`,
          [Math.floor(routeOf(author.accountId)! / 16), author.accountId],
        )
      ).rows,
    ).toEqual([{ effect: 'semantic_erasure' }]);
    const minimized = await f.db.admin.query(
      'SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(subject), subject, candidate],
    );
    expect(minimized.rows).toEqual([{ statement: {} }]);
    const erasedZone = await f.db.admin.query(
      'SELECT configuration,mounts,owner_id,state FROM zones.zone WHERE route=$1 AND zone_id=$2',
      [routeOf(zoneId), zoneId],
    );
    expect(erasedZone.rows).toEqual([{ configuration: null, mounts: [], owner_id: null, state: 'purged' }]);
    for (const id of [unlisted.body.zone.id, archived.body.zone.id]) {
      expect(
        (
          await f.db.admin.query(
            'SELECT configuration,mounts,owner_id,state FROM zones.zone WHERE route=$1 AND zone_id=$2',
            [routeOf(id), id],
          )
        ).rows,
      ).toEqual(erasedZone.rows);
    }
    expect(
      (
        await f.db.admin.query(
          'SELECT labels,settings_id,defaults FROM semantic.context WHERE route=$1 AND context_id=$2',
          [routeOf(context.body.context.id), context.body.context.id],
        )
      ).rows,
    ).toEqual([{ labels: {}, settings_id: null, defaults: {} }]);
    expect(
      (
        await f.db.admin.query(
          'SELECT source,verification_receipt_id,revocation_receipt_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND recorded_transaction_id=$3',
          [routeOf(subject), subject, transactionId],
        )
      ).rows,
    ).toEqual([
      {
        source: null,
        verification_receipt_id: null,
        revocation_receipt_id: null,
      },
    ]);
    expect(
      (
        await f.db.admin.query('SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2', [
          Math.floor(routeOf(subject)! / 16),
          transactionId,
        ])
      ).rows,
    ).toEqual([]);
    const late = await f.db.admin.query(
      'SELECT store,state FROM semantic.erasure_inbox WHERE route=$1 AND account_id=$2 AND late',
      [routeOf(author.accountId), author.accountId],
    );
    expect(late.rows.length).toBeGreaterThan(0);
    expect(late.rows.every((row) => row.state === 'resolved')).toBe(true);
    expect(
      (
        await f.db.admin.query('SELECT state FROM semantic.erasure_shared_custody WHERE account_id=$1 LIMIT 1', [
          author.accountId,
        ])
      ).rows,
    ).toEqual([{ state: 'pending' }]);
    expect(
      (
        await f.db.admin.query('SELECT * FROM zones.zone WHERE route=$1 AND zone_id=$2', [
          routeOf(survivor.body.zone.id),
          survivor.body.zone.id,
        ])
      ).rows,
    ).toEqual(before.rows);
    expect((await f.call(undefined, 'GET', `/v1/subjects/${subject}`)).status).toBe(200);
    expect((await f.call(undefined, 'GET', `/v1/contexts/${transferredId}`)).status).toBe(200);
    expect(
      (
        await f.db.admin.query('SELECT * FROM semantic.context WHERE route=$1 AND context_id=$2', [
          routeOf(transferredId),
          transferredId,
        ])
      ).rows,
    ).toEqual(transferredBefore.rows);
    const status = await f.status(author.accountId);
    expect(status?.participants.semantic).toEqual({
      outcome: 'pending',
      retained: [],
    });
    expect(status?.completedAt).toBeNull();
    expect(await stepSemanticErasure(f.db.pool, author.accountId)).toMatchObject({
      localComplete: true,
      changed: false,
      rawKeys: 0,
    });
    expect(await readSemanticErasure(f.db.pool, author.accountId)).toEqual(progress);
  } finally {
    // Access's separate coordinator intentionally remains active until every participant ACKs. This crash/replay
    // fixture waits for the actual local workflow's SUCCESS, never for global completion during cleanup.
    // The unchanged WorkModule lifecycle cases separately exercise shared startup, stop and drain.
    await worker.crash();
  }
}, 360_000);

// This test deliberately uses a nonowner's native configure command; owner_id-only discovery misses it.
test('native nonowner Zone editor records exact source roles and minimizes its private configuration', async () => {
  const owner = await f.author();
  const editor = await f.author();
  await f.grant(GLOBAL_CONTEXT, owner, ['zone:create']);
  const input = createBody();
  const created = await f.call(owner, 'POST', '/v1/zones', input);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.zone.id as string;
  await f.grantAs(owner, id, editor, ['zone:read', 'zone:configure']);
  input.configuration.labels.en = `Private editor ${randomUUID()}`;
  const edited = await f.call(
    editor,
    'PUT',
    `/v1/zones/${id}/configuration`,
    { configuration: input.configuration, mounts: input.mounts },
    {
      'if-match': JSON.stringify(created.body.zone.revision),
    },
  );
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  const evidence = await f.db.admin.query(
    `SELECT l.role,l.source_transaction_id,z.transaction_id,z.owner_id
    FROM semantic.erasure_locator l JOIN zones.zone z ON z.erasure_key=l.record_key
    WHERE l.store='zone' AND l.account_id=$1 AND z.route=$2 AND z.zone_id=$3`,
    [editor.accountId, routeOf(id), id],
  );
  expect(evidence.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'actor',
        owner_id: owner.accountId,
      }),
    ]),
  );
  expect(evidence.rows.find((row) => row.role === 'actor').source_transaction_id).toBe(evidence.rows[0].transaction_id);
  await f.tombstone(editor);
  await beginSemanticErasure(f.db.pool, editor.accountId);
  const worker = await accountErasureWorker(f.db.url);
  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const completion = await f.db.admin.query(
        `SELECT p.state,w.status FROM semantic.erasure_progress p
        JOIN dbos.workflow_status w ON w.workflow_uuid=p.workflow_id
        WHERE p.route=$1 AND p.account_id=$2`,
        [routeOf(editor.accountId), editor.accountId],
      );
      if (completion.rows[0]?.state === 'pending-shared-custody' && completion.rows[0]?.status === 'SUCCESS') break;
      if (Date.now() > deadline) throw new Error('Default nonowner-editor cleanup did not converge');
      await Bun.sleep(20);
    }
    expect(
      (
        await f.db.admin.query(
          'SELECT configuration,mounts,owner_id,state FROM zones.zone WHERE route=$1 AND zone_id=$2',
          [routeOf(id), id],
        )
      ).rows,
    ).toEqual([{ configuration: null, mounts: [], owner_id: owner.accountId, state: 'purged' }]);
    expect((await f.status(editor.accountId))?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
    expect(await stepSemanticErasure(f.db.pool, editor.accountId)).toMatchObject({ localComplete: true, rawKeys: 0 });
  } finally {
    await worker.crash();
  }
}, 120_000);

test('native assigned actor and acting human provenance use the existing declared delegation authority', async () => {
  const author = await f.author();
  const other = await f.author();
  await f.grant(GLOBAL_CONTEXT, other, ['zone:create']);
  const survivor = await f.call(other, 'POST', '/v1/zones', createBody());
  expect(survivor.status, JSON.stringify(survivor.body)).toBe(201);
  await f.grantAs(other, survivor.body.zone.id, author, ['zone:read', 'zone:configure']);
  const delegated = await f.delegated(author, other);
  const organizationCopy = createBody();
  organizationCopy.configuration.labels.en = 'Surviving principal resource';
  const acting = await f.call(
    delegated,
    'PUT',
    `/v1/zones/${survivor.body.zone.id}/configuration`,
    {
      configuration: organizationCopy.configuration,
      mounts: organizationCopy.mounts,
    },
    {
      'if-match': JSON.stringify(survivor.body.zone.revision),
    },
  );
  expect(acting.status, JSON.stringify(acting.body)).toBe(200);
  const actingRoles = await f.db.admin.query(
    `SELECT l.role,l.account_id,b.requested_by FROM semantic.erasure_locator l
    JOIN zones.zone z ON z.erasure_key=l.record_key
    JOIN editorial.write_basis b ON b.partition_no=l.partition_no AND b.transaction_id=l.source_transaction_id
    WHERE l.store='zone' AND z.zone_id=$1 AND z.route=$2 AND l.source_transaction_id=z.transaction_id`,
    [survivor.body.zone.id, routeOf(survivor.body.zone.id)],
  );
  expect(actingRoles.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'acting-human',
        account_id: author.accountId,
      }),
      expect.objectContaining({
        role: 'delegate',
        account_id: other.accountId,
      }),
    ]),
  );
  const before = await f.db.admin.query('SELECT * FROM zones.zone WHERE route=$1 AND zone_id=$2', [
    routeOf(survivor.body.zone.id),
    survivor.body.zone.id,
  ]);
  await f.tombstone(author);
  // The acting human has attribution to erase, never ownership of the assigned actor's resource.
  await beginSemanticErasure(f.db.pool, author.accountId);
  const worker = await accountErasureWorker(f.db.url);
  try {
    const deadline = Date.now() + 150_000;
    while ((await readSemanticErasure(f.db.pool, author.accountId))?.state !== 'pending-shared-custody') {
      if (Date.now() > deadline) throw new Error('Acting-human native cleanup did not converge');
      await Bun.sleep(20);
    }
  } finally {
    // Shared custody deliberately leaves the account coordinator active after local convergence.
    await worker.crash();
  }
  expect(
    (
      await f.db.admin.query('SELECT * FROM zones.zone WHERE route=$1 AND zone_id=$2', [
        routeOf(survivor.body.zone.id),
        survivor.body.zone.id,
      ])
    ).rows,
  ).toEqual(before.rows);
  expect((await f.status(author.accountId))?.participants.semantic).toEqual({
    outcome: 'pending',
    retained: [],
  });
}, 360_000);

test('native Context publication and transferred custody minimize private bodies while retaining current communal definitions', async () => {
  const author = await f.author();
  const other = await f.author();
  const context = await f.call(author, 'POST', '/v1/contexts', { labels: { en: 'Private extension payload' } });
  expect(context.status, JSON.stringify(context.body)).toBe(201);
  const publishExtension = async (id: string, publisher = author) => {
    await f.grant(id, publisher, ['definitions:publish', 'definitions:activate']);
    const extension = {
      format: EXTENSION_FORMAT,
      context: id,
      terms: {
        [`${termPrefix(id)}:related`]: {
          description: { en: 'Native erasure extension body' },
          labels: { en: 'related to' },
          domain: ['schema:Person'],
          targets: ['schema:Person'],
          multivalued: true,
          relation: { group: 'association', inverse: 'none' },
        },
      },
    };
    const published = await f.call(publisher, 'POST', `/v1/contexts/${id}/definitions/extensions`, { extension });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const activated = await f.call(
      publisher,
      'POST',
      `/v1/contexts/${id}/definitions/extensions/${published.body.digest}:activate`,
      { expected_head: null },
    );
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    return published.body.digest as string;
  };
  const privateExtension = await publishExtension(context.body.context.id);
  const privateComposed = await effectiveRelease(f.db.pool, context.body.context.id, true);
  expect(privateComposed).not.toBeNull();
  expect(await readRelease(f.db.pool, privateComposed!.digest)).not.toBeNull();
  const transferred = await f.call(author, 'POST', '/v1/contexts', {
    labels: { en: 'Transferred communal Context' },
  });
  expect(transferred.status, JSON.stringify(transferred.body)).toBe(201);
  const transferredId = transferred.body.context.id as string;
  const communalExtension = await publishExtension(transferredId);
  const communalComposed = await effectiveRelease(f.db.pool, transferredId, true);
  expect(communalComposed).not.toBeNull();
  const roleRows = await f.db.admin.query(
    `SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
    AND subject_id=$3 AND grant_role='semantic.context.owner' AND upper_inf(valid)`,
    [routeOf(transferredId), transferredId, author.accountId],
  );
  const originalRole = {
    resource: { route: routeOf(transferredId), id: transferredId },
    subject: { kind: 'account', id: author.accountId },
    role: 'semantic.context.owner',
    valid: roleRows.rows[0].valid,
  };
  const newRole = {
    ...originalRole,
    subject: { kind: 'account', id: other.accountId },
  };
  expect((await f.call(author, 'POST', '/v1/roleGrants', newRole)).status).toBe(201);
  expect((await f.call(author, 'POST', '/v1/roleGrants:revoke', originalRole)).status).toBe(200);
  const transferredBefore = await f.db.admin.query('SELECT * FROM semantic.context WHERE route=$1 AND context_id=$2', [
    routeOf(transferredId),
    transferredId,
  ]);
  const inherited = await f.call(other, 'POST', '/v1/contexts', { labels: { en: 'Inherited private payload' } });
  expect(inherited.status, JSON.stringify(inherited.body)).toBe(201);
  const inheritedId = inherited.body.context.id as string;
  const inheritedExtension = await publishExtension(inheritedId, other);
  const inheritedComposed = await effectiveRelease(f.db.pool, inheritedId, true);
  expect(inheritedComposed).not.toBeNull();
  const inheritedRoles = await f.db.admin.query(
    `SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
     AND subject_id=$3 AND grant_role='semantic.context.owner' AND upper_inf(valid)`,
    [routeOf(inheritedId), inheritedId, other.accountId],
  );
  const inheritedRole = {
    resource: { route: routeOf(inheritedId), id: inheritedId },
    subject: { kind: 'account', id: other.accountId },
    role: 'semantic.context.owner',
    valid: inheritedRoles.rows[0].valid,
  };
  expect(
    (
      await f.call(other, 'POST', '/v1/roleGrants', {
        ...inheritedRole,
        subject: { kind: 'account', id: author.accountId },
      })
    ).status,
  ).toBe(201);
  expect((await f.call(other, 'POST', '/v1/roleGrants:revoke', inheritedRole)).status).toBe(200);

  await f.tombstone(author);
  expect(await readRelease(f.db.pool, privateComposed!.digest)).toBeNull();
  expect(await readRelease(f.db.pool, inheritedComposed!.digest)).toBeNull();
  expect(await readRelease(f.db.pool, communalComposed!.digest)).not.toBeNull();

  await beginSemanticErasure(f.db.pool, author.accountId);
  const worker = await accountErasureWorker(f.db.url);
  try {
    const deadline = Date.now() + 150_000;
    while ((await readSemanticErasure(f.db.pool, author.accountId))?.state !== 'pending-shared-custody') {
      if (Date.now() > deadline) throw new Error('Default Context cleanup did not converge');
      await Bun.sleep(20);
    }
  } finally {
    // Shared custody deliberately leaves the account coordinator active after local convergence.
    await worker.crash();
  }
  expect(
    (
      await f.db.admin.query(
        'SELECT body FROM semantic.context_extension WHERE route=$1 AND context_id=$2 AND digest=$3',
        [routeOf(context.body.context.id), context.body.context.id, privateExtension],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await f.db.admin.query(
        'SELECT 1 FROM semantic.context_extension_activation WHERE route=$1 AND context_id=$2 AND digest=$3',
        [routeOf(context.body.context.id), context.body.context.id, privateExtension],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await f.db.admin.query(
        'SELECT 1 FROM semantic.context_extension WHERE route=$1 AND context_id=$2 AND digest=$3',
        [routeOf(transferredId), transferredId, communalExtension],
      )
    ).rowCount,
  ).toBe(1);
  for (const store of ['context_extension', 'context_extension_activation'])
    expect(
      (
        await f.db.admin.query(`SELECT 1 FROM semantic.${store} WHERE route=$1 AND context_id=$2 AND digest=$3`, [
          routeOf(inheritedId),
          inheritedId,
          inheritedExtension,
        ])
      ).rows,
    ).toEqual([]);
  expect(
    (await f.db.admin.query('SELECT 1 FROM semantic.release_composite WHERE digest=$1', [inheritedComposed!.digest]))
      .rows,
  ).toEqual([]);
  expect(
    (
      await f.db.admin.query(
        'SELECT labels,settings_id,defaults FROM semantic.context WHERE route=$1 AND context_id=$2',
        [routeOf(inheritedId), inheritedId],
      )
    ).rows,
  ).toEqual([{ labels: {}, settings_id: null, defaults: {} }]);

  expect(
    (
      await f.db.admin.query('SELECT * FROM semantic.context WHERE route=$1 AND context_id=$2', [
        routeOf(transferredId),
        transferredId,
      ])
    ).rows,
  ).toEqual(transferredBefore.rows);
  expect((await f.status(author.accountId))!.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
}, 180_000);

test('default native relation copies retain indexed source roles after an adoption', async () => {
  const author = await f.author();
  await f.grant(GLOBAL_CONTEXT, author, ['context:accept', 'context:adopt']);
  const create = async (label: string, target?: string) => {
    const response = await f.call(author, 'POST', '/v1/subjects', {
      type: target ? 'bf:Instance' : 'schema:Book',
      labels: { en: label },
      ...(target
        ? {
            statements: {
              'schema:exampleOfWork': [
                {
                  property: { id: 'schema:exampleOfWork' },
                  value: { type: 'value', content: target },
                },
              ],
            },
          }
        : {}),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.subject.id as string;
  };
  const original = await create('Original public work');
  const target = await create('Selected public work');
  const subject = await create('Native public edition', original);
  const worker = await accountErasureWorker(f.db.url);
  const untilCopy = async (id: string, candidate?: string) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const row = await f.db.admin.query(
        `SELECT erasure_key::text FROM semantic.inbound_link
        WHERE route=$1 AND subject_id=$2 AND source_subject_id=$3 AND present
        AND ($4::uuid IS NULL OR statement_id=$4)`,
        [routeOf(id), id, subject, candidate ?? null],
      );
      if (row.rowCount) return row.rows[0].erasure_key as string;
      if (Date.now() > deadline) {
        const native = await f.db.admin.query(
          `SELECT p.partition_no,p.position::text,c.position::text AS checkpoint
          FROM core.partition p LEFT JOIN core.consumer_checkpoint c
            ON c.partition_no=p.partition_no AND c.consumer='semantic_links'
          WHERE p.partition_no IN ($1,$2)`,
          [Math.floor(routeOf(subject)! / 16), Math.floor(routeOf(id)! / 16)],
        );
        throw new Error(`Native relation copy did not converge: ${JSON.stringify(native.rows)}`);
      }
      await Bun.sleep(20);
    }
  };
  try {
    await untilCopy(original);
    const proposal = await f.call(author, 'POST', `/v1/subjects/${subject}/candidates`, {
      statement: {
        property: { id: 'schema:exampleOfWork' },
        value: { type: 'value', content: target },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.test/native-source' },
              },
            ],
          },
        ],
      },
    });
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
    const candidate = proposal.body.candidate as string;
    const accepted = await f.call(author, 'POST', `/v1/subjects/${subject}/candidates/${candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const adopted = await f.call(author, 'POST', `/v1/subjects/${subject}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:exampleOfWork',
      target,
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    const key = await untilCopy(target, candidate);
    const roles = await f.db.admin.query(
      `SELECT account_id::text,role FROM semantic.erasure_locator
      WHERE partition_no=$1 AND store='inbound_link' AND record_key=$2`,
      [Math.floor(routeOf(target)! / 16), key],
    );
    expect(roles.rows).toContainEqual({ account_id: author.accountId, role: 'actor' });
  } finally {
    await worker.crash();
  }
}, 90_000);
