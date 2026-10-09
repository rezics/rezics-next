// sql-relations-allow: access.g924_audit -- G924 creates this disposable audit view to verify dependency preservation.
// sql-relations-allow: access.g924_unknown_audit -- G924 creates an unknown disposable view to verify refusal before rewriting.
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { rewritePrincipalSubjectFormat } from '../../../services/main/src/operations/format-upgrade.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

test('G924: offline subject rewrite retains audit values, dependent views and grants; a stopped copy restores v1', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access'], 'owner');
  let pool = new Pool({ connectionString: databases.urls.access });
  const principal = randomUUID(),
    caseId = randomUUID(),
    report = randomUUID(),
    step = randomUUID();
  const subject = `样本-阅读者-${randomUUID()}`;
  const metadata = () =>
    pool.query(`SELECT oid,relowner,relacl::text,reloptions,
    obj_description(oid) AS comment FROM pg_class WHERE oid='access.safety_alert_delivery'::regclass`);
  try {
    await pool.query(
      `INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,'g924',$2)`,
      [principal, subject],
    );
    await pool.query(
      `INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1::uuid,'content_report','platform','governance:platform','urn:rezics:context:global','content',$1::text,'body','private')`,
      [caseId],
    );
    await pool.query(
      `INSERT INTO access.governance_report
      (id,case_id,idempotency_key,request_digest,reason_code,evidence_count,evidence_digest)
      VALUES ($1::uuid,$2,$1::text,$3,'ncii',1,$3)`,
      [report, caseId, 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO access.governance_process_step
      (id,case_id,report_id,process,step,idempotency_key,request_digest,occurred_at,due_at)
      VALUES ($1::uuid,$2,$3,'ncii','removal_deadline',$1::text,$4,now(),now()+interval '1 day')`,
      [step, caseId, report, 'b'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO access.safety_alert
      (step_id,case_id,case_generation,principal_id,responder,reason,due_at,created_at)
      VALUES ($1,$2,0,$3,'primary','approaching',now()+interval '1 day',now())`,
      [step, caseId, principal],
    );
    await pool.query(`ALTER VIEW access.safety_alert_delivery SET (security_barrier=true);
      GRANT SELECT ON access.safety_alert_delivery TO PUBLIC;
      COMMENT ON VIEW access.safety_alert_delivery IS 'G924 retained audit';
      CREATE VIEW access.g924_audit AS SELECT account_subject,intake_state,delivery_state
        FROM access.safety_alert_delivery`);
    const before = (await metadata()).rows;
    const audit = (await pool.query('SELECT * FROM access.g924_audit')).rows;
    expect(audit).toEqual([
      { account_subject: subject, intake_state: 'pending', delivery_state: null },
    ]);
    const restoredUrl = await databases.snapshot('access', () => pool.end());
    pool = new Pool({ connectionString: databases.urls.access });
    await expect(
      rewritePrincipalSubjectFormat(
        { accessUrl: databases.urls.access },
        async () => {
          expect((await pool.query('SELECT open FROM access.recovery_fence')).rows[0].open).toBe(
            false,
          );
        },
        'after-rewrite-commit',
      ),
    ).rejects.toThrow('Injected failure after incompatible format commit');
    expect((await metadata()).rows).toEqual(before);
    expect((await pool.query('SELECT * FROM access.g924_audit')).rows).toEqual(audit);
    expect(
      (
        await pool.query(
          "SELECT convert_from(account_subject,'UTF8') AS subject FROM access.principal WHERE id=$1",
          [principal],
        )
      ).rows[0].subject,
    ).toBe(subject);
    expect(
      (await pool.query('SELECT version,state,target_version FROM access.storage_format')).rows,
    ).toEqual([{ version: 2, state: 'upgrade-pending', target_version: 2 }]);
    await expect(
      pool.query('UPDATE access.recovery_fence SET open=true WHERE id=true'),
    ).rejects.toThrow('incompatible with this runtime');
    const restored = new Pool({ connectionString: restoredUrl });
    try {
      expect(
        (
          await restored.query('SELECT account_subject FROM access.principal WHERE id=$1', [
            principal,
          ])
        ).rows,
      ).toEqual([{ account_subject: subject }]);
      expect((await restored.query('SELECT * FROM access.g924_audit')).rows).toEqual(audit);
      expect(
        (await restored.query('SELECT version,state,target_version FROM access.storage_format'))
          .rows,
      ).toEqual([{ version: 1, state: 'ready', target_version: null }]);
    } finally {
      await restored.end();
    }
  } finally {
    await pool.end();
    await databases.close();
  }
});

test('G924: an unknown subject-dependent view fails closed and rolls the audit projection back atomically', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access'], 'owner');
  const pool = new Pool({ connectionString: databases.urls.access });
  try {
    await pool.query(
      'CREATE VIEW access.g924_unknown_audit AS SELECT account_subject FROM access.principal',
    );
    const before = (
      await pool.query(
        "SELECT pg_get_viewdef('access.safety_alert_delivery'::regclass) AS definition",
      )
    ).rows;
    await expect(
      rewritePrincipalSubjectFormat({ accessUrl: databases.urls.access }, async () => {}),
    ).rejects.toThrow('cannot alter type of a column used by a view or rule');
    expect(
      (
        await pool.query(
          "SELECT pg_get_viewdef('access.safety_alert_delivery'::regclass) AS definition",
        )
      ).rows,
    ).toEqual(before);
    expect((await pool.query('SELECT version,state FROM access.storage_format')).rows).toEqual([
      { version: 1, state: 'upgrade-pending' },
    ]);
    expect((await pool.query('SELECT open FROM access.recovery_fence')).rows[0].open).toBe(false);
  } finally {
    await pool.end();
    await databases.close();
  }
});
