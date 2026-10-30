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
