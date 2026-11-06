import type { GrowthCheck, GrowthDatabase } from '../../../kernel/test/support/growth.ts';

/** One selected native neighbourhood per physical invocation, including cold-backend retries.
 * Warm-ups have their own namespace and equivalent state; setup never enters a measured capture.
 */
export function consumableGrowth<T>(options: {
  name: string;
  setup(db: GrowthDatabase, scale: number, id: string): Promise<T>;
  run(db: GrowthDatabase, scale: number, id: string, target: T): Promise<unknown>;
}) {
  let serial = 0;
  let prepared: { scale: number; repetition: number; id: string; target: T } | undefined;
  const invocations: {
    id: string;
    scale: number;
    repetition: number;
    kind: 'warmup' | 'measured';
    outcome: 'running' | 'succeeded' | 'failed';
  }[] = [];
  async function setup(db: GrowthDatabase, scale: number, repetition: number, kind: 'warmup' | 'measured') {
    const id = `${options.name}-${kind}-${scale}-${repetition}-${serial++}`;
    const target = await options.setup(db, scale, id);
    return { id, target, scale, repetition, kind };
  }
  async function invoke(
    db: GrowthDatabase,
    selected: { id: string; target: T; scale: number; repetition: number; kind: 'warmup' | 'measured' },
  ) {
    const invocation = {
      id: selected.id,
      scale: selected.scale,
      repetition: selected.repetition,
      kind: selected.kind,
      outcome: 'running' as 'running' | 'succeeded' | 'failed',
    };
    invocations.push(invocation);
    try {
      const result = await options.run(db, selected.scale, selected.id, selected.target);
      invocation.outcome = 'succeeded';
      return result;
    } catch (error) {
      // Failure may follow a committed destructive step. Retain that physical
      // invocation, but never make its consumed target available for replay.
      invocation.outcome = 'failed';
      throw error;
    }
  }
  const hooks = {
    async prepare(db, scale, repetition) {
      if (prepared) throw new Error('Unconsumed native target');
      prepared = await setup(db, scale, repetition, 'measured');
    },
    async warmup(db, scale, repetition) {
      if (prepared) throw new Error('Warmup cannot consume a measured target');
      const spare = await setup(db, scale, repetition, 'warmup');
      return invoke(db, spare);
    },
    async operation(db, scale, repetition) {
      const selected = prepared;
      if (!selected || selected.scale !== scale || selected.repetition !== repetition)
        throw new Error('Fresh native target required');
      // A failed physical invocation must also get fresh state on any retry.
      prepared = undefined;
      return invoke(db, { ...selected, kind: 'measured' });
    },
  } satisfies Pick<GrowthCheck, 'prepare' | 'warmup' | 'operation'>;
  return { hooks, invocations };
}

export async function prepareMaintenanceTarget(db: GrowthDatabase, id: string, history: string, clients: number) {
  const tag = `${id}-`;
  const date = new Date('1990-01-01');
  // These fixture accounts are already absent. Their legitimate native delayed-erasure
  // neighbourhood is due; no real user's 310-second deadline is changed.
  await db.admin.query(
    `INSERT INTO auth_consent_erasure (account_id,due_at)
     SELECT $1||i,$2 FROM generate_series(1,100) i`,
    [tag, date],
  );
  await db.admin.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes)
     SELECT $1||i,$2||j,ARRAY['read'] FROM generate_series(1,100) i CROSS JOIN generate_series(1,$3::int) j`,
    [tag, history, clients],
  );
  await db.admin.query(
    `INSERT INTO session
     (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
     SELECT $1||i,$1||i,$2||i,$2||i,$3,now(),'read',1,1,'pwd' FROM generate_series(1,1000) i`,
    [tag, history, date],
  );
  await db.admin.query(
    `INSERT INTO verification (id,identifier,value,"expiresAt")
     SELECT $1||i,$1||i,'due',$2 FROM generate_series(1,1000) i`,
    [tag, date],
  );
}

export const protocolTables = [
  '"oauthAccessToken"',
  '"oauthRefreshToken"',
  '"oauthRefreshFamily"',
  '"oauthClientAssertion"',
  'auth_recent_oidc_session',
] as const;

export async function protocolRows(db: GrowthDatabase, tag: string, from: number, to: number, date: Date) {
  const range = [tag, from, to, date];
  // Both the hot client/owner and other client/owner partitions grow. Families
  // are intentionally retained independently from their newest token's expiry.
  const client = `CASE WHEN i%2=0 THEN 'protocol-hot' ELSE 'protocol-other' END`;
  await db.admin.query(
    `INSERT INTO "oauthRefreshFamily" (id,"clientId",revoked,sequence,"expiresAt")
    SELECT $1||i,${client},false,1,$4 FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO "oauthRefreshToken" (id,token,"clientId","userId","authorizationCodeId","expiresAt","createdAt",scopes)
    SELECT $1||i,$1||i,${client},${client},$1||i,$4,now(),'["read"]'::jsonb FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO "oauthAccessToken" (id,token,"clientId","userId","refreshId","expiresAt","createdAt",scopes)
    SELECT $1||i,$1||i,${client},${client},$1||i,$4,now(),'["read"]'::jsonb FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO "oauthClientAssertion" (id,"expiresAt")
    SELECT $1||i,$4 FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_recent_oidc_session (session_id,account_id,expires_at)
    SELECT $1||i,${client},$4 FROM generate_series($2::int,$3::int) i`,
    range,
  );
}

export const retentionScales = [256, 1024, 4096] as const;
export const retentionAxes = ['workflows', 'long-lived', 'requests', 'accounts'] as const;
export type RetentionAxis = (typeof retentionAxes)[number];

/** Replace independent history populations, keeping every other axis at 256. All
 * workflow keys sort beyond the fixed raw target page. The long-lived axis would
 * precede targets under the former creation-ordered completion-filtered SDK plan.
 */
export async function seedRetentionAxes(db: GrowthDatabase, axis: RetentionAxis, scale: number, now: number) {
  for (const current of retentionAxes) {
    const tag = `z:retention-history:${current}:`;
    const count = current === axis ? scale : 256;
    await db.admin.query('DELETE FROM auth_dbos.workflow_status WHERE workflow_uuid LIKE $1', [`${tag}%`]);
    await db.admin.query('DELETE FROM auth_workflow_request WHERE workflow_id LIKE $1', [`${tag}%`]);
    if (current === 'requests') {
      await db.admin.query(
        `INSERT INTO auth_workflow_request(workflow_id,digest,request)
        SELECT $1||lpad(i::text,6,'0'),decode('00','hex'),'{}' FROM generate_series(1,$2::int) i`,
        [tag, count],
      );
    } else if (current === 'accounts') {
      await db.admin.query('DELETE FROM auth_copy_role WHERE workflow_id LIKE $1', [`${tag}%`]);
      await db.admin.query('DELETE FROM auth_copy_work WHERE workflow_id LIKE $1', [`${tag}%`]);
      await db.admin.query('DELETE FROM "user" WHERE id LIKE $1', [`${tag}%`]);
      await db.admin.query(
        `INSERT INTO "user"(id,name,"emailVerified")
        SELECT $1||lpad(i::text,6,'0'),'',false FROM generate_series(1,$2::int) i`,
        [tag, count],
      );
      await db.admin.query(
        `INSERT INTO auth_copy_work(workflow_id,name,digest,scope_count)
        SELECT $1||lpad(i::text,6,'0'),'accounts.operation',decode(repeat('00',32),'hex'),1
        FROM generate_series(1,$2::int) i`,
        [tag, count],
      );
      await db.admin.query(
        `INSERT INTO auth_copy_role(account_id,workflow_id,role)
        SELECT id,id,'subject' FROM "user" WHERE id LIKE $1`,
        [`${tag}%`],
      );
    } else {
      await db.admin.query(
        `INSERT INTO auth_dbos.workflow_status
        (workflow_uuid,status,name,created_at,updated_at,completed_at,application_name)
        SELECT $1||lpad(i::text,6,'0'),'SUCCESS','auth.maintenance.tick',$3,$4,$4,'rezics-auth-accounts'
        FROM generate_series(1,$2::int) i`,
        [tag, count, current === 'long-lived' ? now - 90 * 86400000 : now, now],
      );
    }
  }
}

/** One fresh raw page, with either 1000 or 10 eligible copies. Preparation is
 * outside the capture, but cutoff/upper-key initialization is part of retention.
 * Personal targets are real registrations prepared by the native host.
 */
export async function prepareRetentionPage(
  db: GrowthDatabase,
  id: string,
  eligible: number,
  personal: boolean | number,
  now: number,
  rawCount = 1000,
) {
  for (const table of ['workflow_input', 'workflow_output', 'operation_outputs'])
    await db.admin.query(`DELETE FROM auth_dbos.${table} WHERE workflow_uuid LIKE '!retention-page:%'`);
  await db.admin.query("DELETE FROM auth_dbos.workflow_status WHERE workflow_uuid LIKE '!retention-page:%'");
  await db.admin.query("DELETE FROM auth_workflow_request WHERE workflow_id LIKE '!retention-page:%'");
  await db.admin.query('UPDATE auth_workflow_retention SET cutoff=NULL,through_key=NULL,after_key=NULL');
  const tag = `!retention-page:${id}:`;
  await db.admin.query(
    `INSERT INTO auth_dbos.workflow_status
    (workflow_uuid,status,name,created_at,updated_at,completed_at,application_name)
    SELECT $1||lpad(i::text,6,'0'),'SUCCESS','auth.maintenance.tick',$3,$3,
      CASE WHEN i<=$4 THEN $3::bigint ELSE $5::bigint END,'rezics-auth-accounts'
    FROM generate_series(1,$2::int) i`,
    [tag, rawCount - Number(personal), now - 90 * 86400000, eligible - Number(personal), now],
  );
  await db.admin.query(
    `INSERT INTO auth_workflow_request(workflow_id,digest,request)
    SELECT workflow_uuid,decode('00','hex'),'{}'::jsonb FROM auth_dbos.workflow_status WHERE workflow_uuid LIKE $1`,
    [`${tag}%`],
  );
  for (const [table, columns, values] of [
    ['workflow_input', 'inputs', "'[]'"],
    ['workflow_output', 'output', "'null'"],
    ['operation_outputs', 'function_id,function_name,output', "1,'retention-fixture','null'"],
    ['workflow_events', 'key,value', "'fixture','null'"],
    ['workflow_events_history', 'function_id,key,value', "1,'fixture','null'"],
  ])
    await db.admin.query(
      `INSERT INTO auth_dbos.${table}(workflow_uuid,${columns})
      SELECT workflow_uuid,${values} FROM auth_dbos.workflow_status WHERE workflow_uuid LIKE $1`,
      [`${tag}%`],
    );
  return tag;
}
