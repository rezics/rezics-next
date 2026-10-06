import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import {
  AccessAdmissionRegistry,
  AdmissionDenied,
  AdmissionUnavailable,
  type AdmissionRequest,
} from '../src/modules/access/admission.ts';
import { AccessPolicyOwner } from '../src/modules/access/policy-owner.ts';
import { directWorkCreateProof } from '../src/modules/access/direct-principal.ts';
import { type RuleInput } from '../src/modules/access/policy-evaluator.ts';
import { accessPolicyRoutes } from '../src/routes/access-policy.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `access-admission-policy-${randomUUID()}`);
const data = join(state, 'pgdata');
let pool: Pool;
let started = false;

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], {
    cwd: state,
    stdio: 'pipe',
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
  // PostgreSQL's socket path cannot include the full worktree name.
  execFileSync(
    'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(state, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      '-w',
      'start',
    ],
    { cwd: state, stdio: 'pipe' },
  );
  started = true;
  pool = new Pool({
    host: '127.0.0.1',
    port,
    user: process.env.USER,
    database: 'postgres',
    max: 4,
    connectionTimeoutMillis: 1000,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (started)
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      cwd: state,
      stdio: 'pipe',
    });
});

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const condition = (op: 'authenticated' | 'represents') => ({
  ruleId: randomUUID(),
  actions: ['work.create'],
  condition: { op },
});
const allow = (): RuleInput => ({
  ruleId: randomUUID(),
  actions: ['work.create'],
  effect: 'allow',
  condition: { op: 'has-grant', action: 'work.create' },
});
const deny = (): RuleInput => ({
  ruleId: randomUUID(),
  actions: ['work.create'],
  effect: 'deny',
  condition: { op: 'authenticated' },
});

async function fixture(ownerPool = pool, scopeOverride?: string) {
  const principalId = randomUUID();
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const scope = scopeOverride ?? `work:create:${randomUUID()}`;
  const representationId = randomUUID();
  const grantId = randomUUID();
  const principal = { issuer: 'https://account.rezics.test', subject: randomUUID() };
  await pool.query(
    'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject],
  );
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [
    scope,
  ]);
  for (const [id, action] of [
    [representationId, 'work.create'],
    [randomUUID(), 'access.policy.manage'],
  ]) {
    await pool.query(
      `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`,
      [id, principalId, actor, action],
    );
  }
  for (const [id, action] of [
    [grantId, 'work.create'],
    [randomUUID(), 'access.policy.manage'],
  ]) {
    await pool.query(
      `INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`,
      [id, actor, scope, action],
    );
  }
  const registry = new AccessAdmissionRegistry(ownerPool);
  const policy = new AccessPolicyOwner(ownerPool);
  // Account verification is a fixture boundary; publication and decision use
  // the production HTTP handlers and real Access owner transactions.
  const app = accessPolicyRoutes({
    accessPolicy: policy,
    account: { verify: async () => principal },
  } as unknown as MainWorkDependencies);
  const call = async (path: string, body: object) => {
    const response = await app.handle(
      new Request(`http://main.local${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify(body),
      }),
    );
    const result = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200) throw new Error(`${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const policyId = randomUUID();
  let head = '0';
  const publish = async (mandatory: RuleInput[], ordered: RuleInput[], limits?: object) => {
    const epoch = (
      await pool.query('SELECT authority_epoch FROM access.scope_gate WHERE id=$1', [scope])
    ).rows[0]!.authority_epoch;
    const result = await call('/v1/access/policy-changes', {
      profile: 'access-policy-change-v1',
      action: 'publish-revision',
      issuerSubject: actor,
      scopeId: scope,
      policyId,
      expectedAuthorityEpoch: epoch,
      expectedHeadRevision: head,
      mandatory,
      ordered,
      ...(limits ? { limits } : {}),
    });
    head = String(result.revision);
    return result;
  };
  const preview = (extra: object = {}) =>
    call('/v1/access/policy-decisions', {
      profile: 'access-policy-decision-v1',
      scopeId: scope,
      action: 'work.create',
      actingSubject: actor,
      ...extra,
    });
  const request = (key = randomUUID()): AdmissionRequest => ({
    principal,
    actingSubject: actor,
    scope,
    action: 'work.create',
    idempotencyKey: key,
    requestDigest: digest(key),
  });
  const writes = async () =>
    (
      await pool.query(
        `SELECT
    (SELECT count(*) FROM access.admission WHERE scope_id=$1) AS admissions,
    (SELECT count(*) FROM access.admission_receipt r JOIN access.admission a ON a.id=r.admission_id
      WHERE a.scope_id=$1) AS receipts,
    (SELECT count(*) FROM access.outbox WHERE scope_id=$1) AS events`,
        [scope],
      )
    ).rows[0];
  return {
    registry,
    policy,
    actor,
    scope,
    principalId,
    representationId,
    grantId,
    request,
    publish,
    preview,
    writes,
  };
}

test('C1: published deny between register and claim rejects dispatch without writes; retry recovers only its receipt', async () => {
  const h = await fixture();
  await h.publish([condition('authenticated'), condition('represents')], [allow()]);
  expect((await h.preview()).result).toBe('allow');
  const request = h.request();
  const registered = await h.registry.register(request);
  await h.publish([condition('authenticated'), condition('represents')], [deny(), allow()]);
  expect((await h.preview()).result).toBe('deny');
  const before = await h.writes();
  await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  expect(await h.registry.register(request)).toMatchObject({
    id: registered.id,
    replayed: true,
    dispatchEligible: false,
  });
  await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionDenied);
  expect(await h.writes()).toEqual(before);
});

test('C1: mandatory restrictions and first-applicable order have the same result in preview and admission', async () => {
  const h = await fixture();
  await h.publish(
    [
      {
        ruleId: randomUUID(),
        actions: ['work.create'],
        condition: { op: 'subject-is', subject: `https://rezics.com/id/${randomUUID()}` },
      },
    ],
    [allow()],
  );
  expect((await h.preview()).result).toBe('deny');
  await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(h.registry.assertAuthority(h.request())).rejects.toBeInstanceOf(AdmissionDenied);
  await h.publish([condition('represents')], [allow(), deny()]);
  expect((await h.preview()).result).toBe('allow');
  const request = h.request();
  const registered = await h.registry.register(request);
  expect((await h.registry.claim(registered.id, request.requestDigest)).dispatchEligible).toBe(
    true,
  );
  await h.publish([], []);
  expect((await h.preview()).result).toBe('deny');
  await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionDenied);
});

test('C1: grant expiry with unchanged generation denies claim and caps the lease below thirty seconds', async () => {
  const h = await fixture();
  await h.publish([condition('represents')], [allow()]);
  const deadline = (
    await pool.query(
      `UPDATE access.permission_grant
    SET valid_until=clock_timestamp() + interval '1 second' WHERE id=$1
    RETURNING valid_until,generation`,
      [h.grantId],
    )
  ).rows[0]!;
  const request = h.request();
  const registered = await h.registry.register(request);
  expect(Date.parse(registered.expiresAt)).toBeLessThanOrEqual(deadline.valid_until.getTime());
  expect(Date.parse(registered.expiresAt) - Date.parse(registered.registeredAt!)).toBeLessThan(
    1000,
  );
  const before = await h.writes();
  await pool.query(
    'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())) + 0.02)',
    [deadline.valid_until],
  );
  expect(
    (await pool.query('SELECT generation FROM access.permission_grant WHERE id=$1', [h.grantId]))
      .rows[0]!.generation,
  ).toBe(deadline.generation);
  await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  expect((await h.registry.register(request)).dispatchEligible).toBe(false);
  expect(await h.writes()).toEqual(before);
});

test('C1: representation expiry is also the lease deadline and is rechecked without a generation change', async () => {
  const h = await fixture();
  const deadline = (
    await pool.query(
      `UPDATE access.representation
    SET valid_until=clock_timestamp() + interval '1 second' WHERE id=$1
    RETURNING valid_until,generation`,
      [h.representationId],
    )
  ).rows[0]!;
  const request = h.request();
  const registered = await h.registry.register(request);
  expect(Date.parse(registered.expiresAt)).toBeLessThanOrEqual(deadline.valid_until.getTime());
  await pool.query(
    'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())) + 0.02)',
    [deadline.valid_until],
  );
  await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  expect(
    (
      await pool.query('SELECT generation FROM access.representation WHERE id=$1', [
        h.representationId,
      ])
    ).rows[0]!.generation,
  ).toBe(deadline.generation);
});

test('C1: revoking either selected source denies claim; an alternative grant cannot repair a retry', async () => {
  for (const table of ['permission_grant', 'representation'] as const) {
    const h = await fixture();
    await h.publish([condition('represents')], [allow()]);
    const request = h.request();
    const registered = await h.registry.register(request);
    await pool.query(
      `UPDATE access.${table} SET active=false, generation=generation+1 WHERE id=$1`,
      [table === 'permission_grant' ? h.grantId : h.representationId],
    );
    if (table === 'permission_grant')
      await pool.query(
        `INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.create',clock_timestamp()+interval '1 hour')`,
        [randomUUID(), h.actor, h.scope],
      );
    const before = await h.writes();
    await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
      AdmissionDenied,
    );
    expect(await h.registry.register(request)).toMatchObject({
      id: registered.id,
      replayed: true,
      dispatchEligible: false,
    });
    expect(await h.writes()).toEqual(before);
  }
});

test('C1: unavailable policy or witness reads fail closed at register, retry and claim', async () => {
  const h = await fixture();
  await h.publish([condition('represents')], [allow()]);
  const request = h.request();
  const registered = await h.registry.register(request);
  const before = await h.writes();
  for (const table of ['policy', 'permission_grant'] as const) {
    await pool.query(`ALTER TABLE access.${table} RENAME TO unavailable_${table}`);
    try {
      await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionUnavailable);
      await expect(h.registry.register(request)).rejects.toBeInstanceOf(AdmissionUnavailable);
      await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
        AdmissionUnavailable,
      );
    } finally {
      await pool.query(`ALTER TABLE access.unavailable_${table} RENAME TO ${table}`);
    }
  }
  expect(await h.writes()).toEqual(before);
  expect((await h.registry.claim(registered.id, request.requestDigest)).dispatchEligible).toBe(
    true,
  );
});

test('C1: policy exhaustion is unavailable and a policy allow never replaces capability eligibility', async () => {
  const h = await fixture();
  await h.publish([condition('authenticated'), condition('represents')], [allow()], {
    maxStates: 1,
  });
  expect((await h.preview()).result).toBe('unavailable');
  await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionUnavailable);
  await h.publish([], [{ ...allow(), condition: { op: 'authenticated' } }]);
  await pool.query('UPDATE access.permission_grant SET active=false WHERE id=$1', [h.grantId]);
  expect((await h.preview()).result).toBe('deny');
  await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionDenied);
}, 30_000);

test('C1: preview and admission charge the same selected authority facts against the input budget', async () => {
  const h = await fixture();
  await h.publish([condition('authenticated'), condition('represents')], [allow()], {
    maxInputRows: 2,
  });
  expect((await h.preview()).result).toBe('allow');
  const request = h.request();
  const admission = await h.registry.register(request);
  expect((await h.registry.register(request)).dispatchEligible).toBe(true);
  expect((await h.registry.claim(admission.id, request.requestDigest)).dispatchEligible).toBe(true);
  await h.publish([condition('authenticated'), condition('represents')], [allow()], {
    maxInputRows: 1,
  });
  expect((await h.preview()).result).toBe('unavailable');
  await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionUnavailable);
}, 30_000);

test('C1: claim and retry reevaluate a time restriction even when the policy and authority generations are unchanged', async () => {
  const h = await fixture();
  const end = new Date(Date.now() + 1000);
  await h.publish(
    [
      {
        ruleId: randomUUID(),
        actions: ['work.create'],
        condition: { op: 'time-window', notAfter: end.toISOString() },
      },
    ],
    [allow()],
  );
  const request = h.request();
  const registered = await h.registry.register(request);
  const before = await h.writes();
  await pool.query(
    'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())) + 0.02)',
    [end],
  );
  expect((await h.preview()).result).toBe('deny');
  await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  expect((await h.registry.register(request)).dispatchEligible).toBe(false);
  expect(await h.writes()).toEqual(before);
});

test('C1: unbounded grants and mandates retain the thirty-second maximum lease', async () => {
  const h = await fixture();
  await pool.query("UPDATE access.permission_grant SET valid_until='infinity' WHERE id=$1", [
    h.grantId,
  ]);
  await pool.query("UPDATE access.representation SET valid_until='infinity' WHERE id=$1", [
    h.representationId,
  ]);
  const request = h.request();
  const registered = await h.registry.register(request);
  expect(Date.parse(registered.expiresAt) - Date.parse(registered.registeredAt!)).toBeLessThan(
    30_100,
  );
  expect((await h.registry.claim(registered.id, request.requestDigest)).dispatchEligible).toBe(
    true,
  );
});

test('C1: a selected group grant caps admission expiry and its policy preview cannot issue an incomplete reusable handle', async () => {
  const h = await fixture(pool, 'work:create:root');
  await pool.query('UPDATE access.permission_grant SET active=false WHERE id=$1', [h.grantId]);
  const groupId = randomUUID();
  const grantId = randomUUID();
  await pool.query('INSERT INTO access.recipient_group (id,scope_id) VALUES ($1,$2)', [
    groupId,
    h.scope,
  ]);
  await pool.query(
    'INSERT INTO access.group_member (id,group_id,agent_subject) VALUES ($1,$2,$3)',
    [randomUUID(), groupId, h.actor],
  );
  await pool.query(
    `INSERT INTO access.group_permission_grant
    (id,group_id,issuer_subject,scope_id,action,valid_until)
    VALUES ($1,$2,$3,$4,'work.create',clock_timestamp()+interval '1 hour')`,
    [grantId, groupId, h.actor, h.scope],
  );
  await h.publish([condition('represents')], [allow()]);
  expect(await h.preview({ reusable: true })).toMatchObject({ result: 'allow', reusable: false });
  const familyId = randomUUID();
  await pool.query(
    `WITH family AS (
    INSERT INTO access.role_family (id,owner_subject,scope_id,head_revision) VALUES ($1,$2,$3,1)
    RETURNING id)
    INSERT INTO access.role_revision (family_id,revision,permissions)
    SELECT id,1,ARRAY['work.create','work.edit'] FROM family`,
    [familyId, h.actor, h.scope],
  );
  await pool.query(
    `INSERT INTO access.role_binding
    (id,family_id,role_revision,issuer_subject,recipient_subject,valid_until,assigned_by_principal)
    VALUES ($1,$2,1,$3,$3,clock_timestamp()+interval '1 hour',$4)`,
    [randomUUID(), familyId, h.actor, h.principalId],
  );
  await h.publish(
    [{ ...condition('represents'), condition: { op: 'has-grant', action: 'work.edit' } }],
    [allow()],
  );
  expect((await h.preview()).result).toBe('deny');
  await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionDenied);
  await h.publish([condition('represents')], [allow()]);
  const deadline = (
    await pool.query(
      `UPDATE access.group_permission_grant
    SET valid_until=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING valid_until,generation`,
      [grantId],
    )
  ).rows[0]!;
  const request = h.request();
  const registered = await h.registry.register(request);
  expect(Date.parse(registered.expiresAt)).toBeLessThanOrEqual(deadline.valid_until.getTime());
  expect((await h.registry.claim(registered.id, request.requestDigest)).dispatchEligible).toBe(
    true,
  );
  await pool.query(
    'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())) + 0.02)',
    [deadline.valid_until],
  );
  await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  expect(
    (
      await pool.query('SELECT generation FROM access.group_permission_grant WHERE id=$1', [
        grantId,
      ])
    ).rows[0]!.generation,
  ).toBe(deadline.generation);
});

test('C1: direct principal selection reads one indexed grant and retains attribution eligibility', async () => {
  const h = await fixture();
  const grantId = randomUUID();
  await pool.query(
    "INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING",
  );
  await pool.query(
    `INSERT INTO access.principal_permission_grant
    (id,issuer_subject,principal_id,scope_id,action,valid_until)
    VALUES ($1,$2,$3,'work:create:root','work.create',clock_timestamp()+interval '1 hour')`,
    [grantId, h.actor, h.principalId],
  );
  await pool.query(
    `INSERT INTO access.principal_agent_attribution
    (id,principal_id,agent_subject,action,valid_until)
    VALUES ($1,$2,$3,'work.create',clock_timestamp()+interval '1 hour')`,
    [randomUUID(), h.principalId, h.actor],
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    expect(await directWorkCreateProof(client, h.principalId, h.actor)).toMatchObject({ grantId });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('C1: an atomic membership switch cannot compose two deny snapshots into an allow', async () => {
  let switchAfterRead: (() => Promise<void>) | undefined;
  let switched = false;
  const observed = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (
            switchAfterRead &&
            !switched &&
            (sql.includes('FROM access.policy_rule_set_reference ref') ||
              sql.includes('FROM access.membership\n'))
          ) {
            switched = true;
            await switchAfterRead();
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  const h = await fixture(observed);
  const members: string[] = [];
  const sets: string[] = [];
  for (let at = 0; at < 2; at++) {
    const owner = `https://rezics.com/id/${randomUUID()}`;
    const memberId = randomUUID();
    const setId = randomUUID();
    await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution')", [
      owner,
    ]);
    await pool.query(
      `INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('org',$1,1,'terms')`,
      [owner],
    );
    await pool.query(
      `INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'org',$2,$3,'left',1,1,'terms',$4)`,
      [memberId, owner, h.actor, randomUUID()],
    );
    await pool.query(
      `INSERT INTO access.policy_set_admission
      (id,set_kind,set_owner_subject,basis,referencing_scope_id,purpose,admitted_by_principal,
        admitting_representation_id,admitting_representation_generation,valid_until)
      VALUES ($1,'org',$2,'acting_subject',$3,'resource-exclusion',$4,$5,0,clock_timestamp()+interval '1 hour')`,
      [setId, owner, h.scope, h.principalId, h.representationId],
    );
    members.push(memberId);
    sets.push(setId);
  }
  await h.publish(
    [condition('represents')],
    [
      ...sets.map((admission) => ({
        ruleId: randomUUID(),
        actions: ['work.create'],
        effect: 'deny' as const,
        condition: { op: 'member-of', admission, basis: 'acting_subject' },
      })),
      allow(),
    ],
  );
  const request = h.request();
  const registered = await h.registry.register(request);
  const update = (firstJoined: boolean) =>
    pool.query(
      `UPDATE access.membership
    SET state=CASE WHEN id=$1 THEN $2 ELSE $3 END,generation=generation+1
    WHERE id=ANY($4::uuid[]) AND state<>CASE WHEN id=$1 THEN $2 ELSE $3 END`,
      [members[0], firstJoined ? 'joined' : 'left', firstJoined ? 'left' : 'joined', members],
    );
  for (const phase of ['register', 'retry', 'claim'] as const) {
    await update(false);
    switched = false;
    switchAfterRead = async () => {
      await update(true);
    };
    const before = await h.writes();
    if (phase === 'claim') {
      await expect(h.registry.claim(registered.id, request.requestDigest)).rejects.toBeInstanceOf(
        AdmissionDenied,
      );
    } else if (phase === 'retry') {
      expect((await h.registry.register(request)).dispatchEligible).toBe(false);
    } else {
      await expect(h.registry.register(h.request())).rejects.toBeInstanceOf(AdmissionDenied);
    }
    expect(switched).toBe(true);
    expect(await h.writes()).toEqual(before);
  }
});

test('C1: register, retry and claim keep constant selected rows and statements as unrelated authority grows', async () => {
  const costs = { calls: 0, rows: 0 };
  let grantProbe: { sql: string; values: unknown[] } | undefined;
  const measured = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          costs.calls++;
          costs.rows += result.rows.length;
          if (
            sql.includes('FROM access.permission_grant') &&
            sql.includes('WHERE recipient_subject')
          ) {
            grantProbe = { sql, values: values! };
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  const h = await fixture(measured);
  await h.publish([condition('authenticated'), condition('represents')], [allow()]);
  const samples: { register: typeof costs; retry: typeof costs; claim: typeof costs }[] = [];
  for (const added of [0, 32, 256]) {
    for (let at = 0; at < added; at++) {
      const other = `https://rezics.com/id/${randomUUID()}`;
      const otherScope = `work:create:${randomUUID()}`;
      await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
        other,
      ]);
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [otherScope]);
      await pool.query(
        `INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'work.create',clock_timestamp()+interval '1 hour')`,
        [randomUUID(), other, otherScope],
      );
      // Same-key alternatives expose an accidental inventory sort that counts
      // of returned rows alone cannot detect. They expire after the chosen one.
      await pool.query(
        `INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'work.create',clock_timestamp()+interval '2 hours')`,
        [randomUUID(), h.actor, h.scope],
      );
      await pool.query(
        `INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'work.create',clock_timestamp()-interval '1 day')`,
        [randomUUID(), h.actor, h.scope],
      );
      await pool.query(
        `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'work.create',clock_timestamp()-interval '1 day')`,
        [randomUUID(), h.principalId, h.actor],
      );
    }
    const request = h.request();
    Object.assign(costs, { calls: 0, rows: 0 });
    const registered = await h.registry.register(request);
    const registration = { ...costs };
    Object.assign(costs, { calls: 0, rows: 0 });
    await h.registry.register(request);
    const retry = { ...costs };
    Object.assign(costs, { calls: 0, rows: 0 });
    await h.registry.claim(registered.id, request.requestDigest);
    samples.push({ register: registration, retry, claim: { ...costs } });
  }
  expect(samples[1]).toEqual(samples[0]);
  expect(samples[2]).toEqual(samples[0]);
  for (const operation of Object.values(samples[0]!)) {
    expect(operation.calls).toBeLessThanOrEqual(40);
    expect(operation.rows).toBeLessThanOrEqual(24);
  }
  expect(grantProbe).toBeDefined();
  const plan = (
    await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${grantProbe!.sql}`, grantProbe!.values)
  ).rows[0]!['QUERY PLAN'][0].Plan;
  type Plan = {
    'Node Type': string;
    'Index Name'?: string;
    'Actual Rows': number;
    'Rows Removed by Filter'?: number;
    'Index Cond'?: string;
    Plans?: Plan[];
  };
  const nodes = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
  expect(nodes(plan).some((node) => node['Index Name'] === 'permission_grant_active_lookup')).toBe(
    true,
  );
  expect(nodes(plan).filter((node) => node['Node Type'] === 'Seq Scan')).toEqual([]);
  expect(nodes(plan).every((node) => node['Actual Rows'] <= 1)).toBe(true);
  expect(nodes(plan).every((node) => (node['Rows Removed by Filter'] ?? 0) === 0)).toBe(true);
  expect(
    nodes(plan).some((node) => node['Index Cond']?.includes('valid_until > statement_timestamp()')),
  ).toBe(true);
  writeFileSync(join(state, 'costs.json'), JSON.stringify({ samples, grantPlan: plan }, null, 2));
}, 60_000);
