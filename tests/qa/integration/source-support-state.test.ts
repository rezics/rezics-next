import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const migrations = resolve(import.meta.dir, '../../../services/content/migrations');

test('LIVE01/LIVE03/LIVE05: source support migration, exact guards and indexed owner growth', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const schema = `source_withdraw_${randomUUID().replaceAll('-', '')}`;
  // A private schema exercises the exact old/new DDL without changing the API fixture's owner.
  const sql = (text: string) => text.replace(/\bsource\./g, `${schema}.`)
    .replace('CREATE SCHEMA IF NOT EXISTS source;', `CREATE SCHEMA IF NOT EXISTS ${schema};`);
  const run = (text: string, params: unknown[] = []) => pool.query(sql(text), params);
  try {
    for (const name of ['005_source_intake.sql', '006_source_capture.sql',
      '007_source_conversion.sql', '008_source_native_work_proposal.sql',
      '009_source_native_work_adoption.sql', '010_source_native_work_title_application.sql']) {
      await pool.query(sql(readFileSync(resolve(migrations, name), 'utf8')));
    }
    // One bulk-built background source fixture, then geometric insertion cuts; no API command seeding.
    await run(`CREATE TABLE source.fixture AS SELECT n, gen_random_uuid() AS record,
      gen_random_uuid() AS observation, gen_random_uuid() AS conversion, gen_random_uuid() AS proposal,
      gen_random_uuid() AS intent, gen_random_uuid() AS binding, gen_random_uuid() AS principal,
      gen_random_uuid() AS second_record, gen_random_uuid() AS second_observation,
      gen_random_uuid() AS second_conversion, gen_random_uuid() AS second_proposal,
      'https://rezics.com/id/' || gen_random_uuid() AS work,
      'https://rezics.com/id/' || gen_random_uuid() AS revision,
      'urn:rezics:receipt:' || md5(n::text) || md5(n::text) AS receipt
      FROM generate_series(1,512) n`);
    const seed = async (from: number, to: number) => {
      const range = `n BETWEEN ${from} AND ${to}`;
      await run(`INSERT INTO source.record (id, provider, namespace, external_id)
        SELECT record, 'fixture', 'work', n::text FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.observation (id, record_id, principal_id, media_type,
        retention, coverage, rights_evidence) SELECT observation, record, principal,
        'application/json', 'not-retained', '{}', '{}' FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.conversion (id, observation_id, principal_id,
        mapping_revision, source_digest, projection, field_inventory)
        SELECT conversion, observation, principal, 'open-library-work-map-v1', repeat('a',64),
        '{}', '[]' FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.native_work_proposal (id, conversion_id, observation_id,
        record_id, principal_id, source_digest, candidate_title, rights_evidence,
        graph_receipt, graph_data_epoch, graph_sequence)
        SELECT proposal, conversion, observation, record, principal, repeat('a',64), 'Title', '{}',
        'urn:rezics:receipt:source-projection:' || repeat('b',64), gen_random_uuid(), n
        FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.native_work_adoption_intent (id, proposal_id, principal_id,
        acting_subject, authority_path, confirmed_title, title_language, work_idempotency_key)
        SELECT intent, proposal, principal, work, 'represented-agent', 'Title', 'en',
        'source-adopt-' || gen_random_uuid() FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.native_work_binding (id, intent_id, proposal_id, principal_id,
        work, main_version, work_revision, main_revision, graph_receipt, admission_id, data_epoch, sequence)
        SELECT binding, intent, proposal, principal, work, work, revision, revision,
        receipt, gen_random_uuid(), gen_random_uuid(), n FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.record (id, provider, namespace, external_id)
        SELECT second_record, 'fixture-second', 'work', n::text FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.observation (id, record_id, principal_id, media_type,
        retention, coverage, rights_evidence) SELECT second_observation, second_record, principal,
        'application/json', 'not-retained', '{}', '{}' FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.conversion (id, observation_id, principal_id,
        mapping_revision, source_digest, projection, field_inventory)
        SELECT second_conversion, second_observation, principal, 'open-library-work-map-v1', repeat('a',64),
        '{}', '[]' FROM source.fixture WHERE ${range}`);
      await run(`INSERT INTO source.native_work_proposal (id, conversion_id, observation_id,
        record_id, principal_id, source_digest, candidate_title, rights_evidence,
        graph_receipt, graph_data_epoch, graph_sequence)
        SELECT second_proposal, second_conversion, second_observation, second_record, principal,
        repeat('a',64), 'Title', '{}', 'urn:rezics:receipt:source-projection:' || repeat('b',64),
        gen_random_uuid(), n FROM source.fixture WHERE ${range}`);
    };
    await seed(1, 8);
    const target = (await run('SELECT * FROM source.fixture WHERE n = 1')).rows[0]!;
    const pendingTarget = (await run('SELECT * FROM source.fixture WHERE n = 2')).rows[0]!;
    const intent = randomUUID();
    const application = randomUUID();
    const revision = `https://rezics.com/id/${randomUUID()}`;
    const reserve = (item: typeof target, id: string) => run(`INSERT INTO source.native_work_title_intent
      (id, proposal_id, principal_id, work, expected_head, acting_subject, confirmed_title, work_idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$4,'New title',$6)`,
    [id, item.proposal, item.principal, item.work, item.revision, `source-title-${randomUUID()}`]);
    await reserve(target, intent);
    await run(`INSERT INTO source.native_work_title_application (id, intent_id, proposal_id, principal_id,
      work, expected_head, work_revision, graph_receipt, admission_id, data_epoch, sequence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,10)`,
    [application, intent, target.proposal, target.principal, target.work, target.revision,
      revision, `urn:rezics:receipt:${'c'.repeat(64)}`, randomUUID(), randomUUID()]);
    await reserve(pendingTarget, randomUUID());
    // Pre-017 tables lacked this cross-owner binding check. A foreign application must
    // neither become the support head nor hide the legitimate predecessor during upgrade.
    const foreign = (await run('SELECT * FROM source.fixture WHERE n = 3')).rows[0]!;
    const foreignIntent = randomUUID();
    await reserve(foreign, foreignIntent);
    await run(`INSERT INTO source.native_work_title_application (id, intent_id, proposal_id, principal_id,
      work, expected_head, work_revision, graph_receipt, admission_id, data_epoch, sequence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,11)`,
    [randomUUID(), foreignIntent, foreign.proposal, foreign.principal, target.work, revision,
      `https://rezics.com/id/${randomUUID()}`, `urn:rezics:receipt:${'d'.repeat(64)}`,
      randomUUID(), randomUUID()]);
    await pool.query(sql(readFileSync(resolve(migrations, '017_source_title_support_withdrawal.sql'), 'utf8')));
    await pool.query(sql(readFileSync(resolve(migrations, '018_source_title_support_attachment.sql'), 'utf8')));
    expect((await run('SELECT application_id FROM source.native_work_support_head WHERE binding_id = $1',
      [target.binding])).rows[0]?.application_id).toBe(application);
    expect((await run('SELECT intent_id FROM source.native_work_title_pending WHERE binding_id = $1',
      [target.binding])).rowCount).toBe(0);
    expect((await run('SELECT intent_id FROM source.native_work_title_pending WHERE binding_id = $1',
      [pendingTarget.binding])).rowCount).toBe(1);
    const withdraw = (item: typeof target, app: string | null, key = randomUUID()) => run(
      `INSERT INTO source.native_work_support_withdrawal
        (id, binding_id, principal_id, application_id, idempotency_key, reason)
        VALUES ($1,$2,$3,$4,$5,'Explicit disposition') RETURNING id`,
      [randomUUID(), item.binding, item.principal, app, key]);
    await expect(withdraw(target, null)).rejects.toMatchObject({ constraint: 'native_work_support_exact' });
    await expect(withdraw(pendingTarget, null)).rejects.toMatchObject({ constraint: 'native_work_support_settled' });
    await expect(withdraw({ ...target, principal: randomUUID() }, application))
      .rejects.toMatchObject({ constraint: 'native_work_support_exact' });
    const races = await Promise.allSettled([withdraw(target, application), withdraw(target, application)]);
    expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(races.filter(result => result.status === 'rejected')).toHaveLength(1);
    // Reservation and withdrawal use the same database-owned row lock. No graph dispatch can
    // be admitted by a new source intent after this terminal disposition.
    const nextProposal = (await run('SELECT proposal FROM source.fixture WHERE n = 3')).rows[0]!.proposal;
    await expect(reserve({ ...target, proposal: nextProposal, revision }, randomUUID()))
      .rejects.toMatchObject({ constraint: 'native_work_support_active' });

    const attach = (item: typeof target, attachment = randomUUID()) => run(`INSERT INTO source.native_work_support_attachment
      (id, binding_id, proposal_id, record_id, principal_id, work, work_revision, title,
       acting_subject, authority_proof, idempotency_key) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,'Title',$6,$8,$1::text) RETURNING id`,
    [attachment, item.binding, item.second_proposal, item.second_record, item.principal, item.work, item.revision,
      JSON.stringify({ principalId: item.principal, principalEpoch: '0', actingSubject: item.work,
        subjectGeneration: '0', scope: `work:edit:${item.work}`, action: 'work.edit',
        authorityEpoch: '0', recoveryGeneration: '0', representationId: randomUUID(), representationGeneration: '0',
        grantId: randomUUID(), grantGeneration: '0', validUntil: new Date(Date.now() + 60_000).toISOString() })]);
    await expect(attach(pendingTarget)).rejects.toMatchObject({ constraint: 'native_work_attachment_pending' });
    await expect(attach({ ...target, second_record: target.record, second_proposal: target.proposal }))
      .rejects.toMatchObject({ constraint: 'native_work_attachment_binding' });
    await expect(attach({ ...target, work: foreign.work })).rejects.toMatchObject({ constraint: 'native_work_attachment_binding' });
    await expect(attach({ ...target, principal: foreign.principal }))
      .rejects.toMatchObject({ constraint: 'native_work_attachment_binding' });
    const attached = (await attach(target)).rows[0]!.id;
    await expect(attach(target)).rejects.toMatchObject({ code: '23505' });
    const independent = (await run('SELECT * FROM source.fixture WHERE n = 4')).rows[0]!;
    const concurrent = await Promise.allSettled([attach(independent), withdraw(independent, null)]);
    expect(concurrent.every(result => result.status === 'fulfilled')).toBe(true);
    await expect(run(`INSERT INTO source.native_work_adoption_intent
      (id, proposal_id, principal_id, acting_subject, authority_path, confirmed_title, title_language, work_idempotency_key)
      VALUES ($1,$2,$3,$4,'represented-agent','Title','en',$5)`,
    [randomUUID(), target.second_proposal, target.principal, target.work, `source-adopt-${randomUUID()}`]))
      .rejects.toMatchObject({ constraint: 'native_work_attachment_proposal' });
    await run(`INSERT INTO source.native_work_attachment_withdrawal
      (id, attachment_id, principal_id, idempotency_key, reason) VALUES ($1,$2,$3,'withdraw-second','Independent withdrawal')`,
    [randomUUID(), attached, target.principal]);
    await expect(run('DELETE FROM source.native_work_attachment_withdrawal WHERE attachment_id = $1', [attached]))
      .rejects.toThrow('immutable');
    expect((await run('SELECT id FROM source.native_work_support_withdrawal WHERE binding_id = $1', [target.binding])).rowCount).toBe(1);

    for (const [from, to] of [[9, 64], [65, 512]]) {
      await seed(from!, to!);
      await run('ANALYZE source.native_work_binding');
      await run('ANALYZE source.native_work_support_head');
      await run('ANALYZE source.native_work_title_pending');
      await run('ANALYZE source.native_work_support_withdrawal');
      await run(`INSERT INTO source.native_work_support_attachment
        (id, binding_id, proposal_id, record_id, principal_id, work, work_revision,
         title, acting_subject, authority_proof, idempotency_key)
        SELECT gen_random_uuid(), binding, second_proposal, second_record, principal, work, revision, 'Title', work,
          jsonb_build_object('principalId',principal,'principalEpoch','0','actingSubject',work,
            'subjectGeneration','0','scope','work:edit:' || work,'action','work.edit',
            'authorityEpoch','0','recoveryGeneration','0','representationId',gen_random_uuid(),
            'representationGeneration','0','grantId',gen_random_uuid(),'grantGeneration','0',
            'validUntil',clock_timestamp() + interval '1 hour'), 'attach-' || n
        FROM source.fixture WHERE n BETWEEN ${from} AND ${to}`);
      await run('ANALYZE source.native_work_support_attachment');
      const attachmentPlan = (await run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT a.*, w.id FROM source.native_work_support_attachment a
        LEFT JOIN source.native_work_attachment_withdrawal w ON w.attachment_id = a.id
        WHERE a.work = $1 AND a.principal_id = $2`, [target.work, target.principal])).rows[0]!['QUERY PLAN'][0].Plan;
      expect(attachmentPlan['Actual Rows']).toBe(1);
      expect(attachmentPlan['Shared Hit Blocks'] + attachmentPlan['Shared Read Blocks']).toBeLessThan(32);
      expect(attachmentPlan['Temp Read Blocks']).toBe(0);
      const plans = await run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT h.application_id, w.id, EXISTS (SELECT 1 FROM source.native_work_title_pending p
          WHERE p.binding_id = b.id) AS pending
        FROM source.native_work_binding b
        JOIN source.native_work_support_head h ON h.binding_id = b.id
        LEFT JOIN source.native_work_support_withdrawal w ON w.binding_id = b.id
        WHERE b.work = $1 AND b.principal_id = $2`, [target.work, target.principal]);
      const plan = plans.rows[0]!['QUERY PLAN'][0].Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(32);
      expect(plan['Temp Read Blocks']).toBe(0);
      expect((await run('SELECT count(*)::int AS total FROM source.native_work_support_head'))
        .rows[0]?.total).toBe(to);
    }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
}, 30_000);
