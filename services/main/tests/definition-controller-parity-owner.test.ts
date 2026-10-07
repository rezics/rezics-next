import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry,
  type VerifiedPrincipal,
} from '../src/modules/access/admission.ts';
import { definitionCreatorAllowed } from '../src/modules/access/definition-creator.ts';
import { REFERENCE_DISCLOSURE_COST } from '../src/modules/access/semantic-disclosure.ts';
import { referenceReader } from '../src/modules/semantic/admitted.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `definition-controller-parity-${randomUUID()}`);
const data = join(state, 'pgdata');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Controller = { id: string; actor: string; mandate: string; principal: VerifiedPrincipal };
const expired: Controller = {
  id: randomUUID(),
  actor: native(),
  mandate: randomUUID(),
  principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true },
};
let pool: Pool;
let started = false;

async function insertController(client: Pick<Pool, 'query'>, owner: Controller, legacy = false) {
  await client.query(
    'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [owner.id, owner.principal.issuer, owner.principal.subject],
  );
  await client.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
    owner.actor,
  ]);
  await client.query(
    `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control',${legacy ? "clock_timestamp() - interval '1 hour'" : "'infinity'"})`,
    [owner.mandate, owner.id, owner.actor],
  );
}

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
        return reject(new Error('missing PostgreSQL port'));
      server.close(() => resolvePort(address.port));
    });
  });
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
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      // Legacy finite mandates remain finite under the permanent-controller migration.
      if (file === '054_agent_control.sql') await insertController(client, expired, true);
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await provision(expired);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (started)
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      cwd: state,
      stdio: 'pipe',
    });
});

async function provision(owner: Controller) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Definition controller fixture',0,'active','fixture',1,$5)`,
    [id, owner.id, digest(id), owner.actor, owner.mandate],
  );
  await pool.query('SELECT access.seed_platform_grants($1,$2)', [
    owner.id,
    `urn:rezics:access-receipt:${digest(id)}`,
  ]);
}

async function controller(): Promise<Controller> {
  const owner: Controller = {
    id: randomUUID(),
    actor: native(),
    mandate: randomUUID(),
    principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true },
  };
  await insertController(pool, owner);
  await provision(owner);
  return owner;
}

async function retainController(owner: Controller) {
  const standby = await controller();
  await pool.query(
    `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`,
    [standby.id, owner.actor],
  );
}

async function policy(owner: Controller, scope: string, ended: boolean) {
  const client = await pool.connect(),
    id = randomUUID(),
    grant = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [
      scope,
    ]);
    await client.query(
      `INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'semantic.read','infinity')`,
      [grant, owner.actor, scope],
    );
    await client.query(
      `INSERT INTO access.policy (id,scope_id,owner_subject,head_revision,ended_at)
      VALUES ($1,$2,$3,1,CASE WHEN $4 THEN now() END)`,
      [id, scope, owner.actor, ended],
    );
    await client.query(
      `INSERT INTO access.policy_revision (policy_id,revision,scope_id,profile,
      combining_algorithm,default_effect,mandatory_count,ordered_count,reference_count,max_states,max_input_rows,
      deadline_ms,digest,published_by_principal,publisher_subject,publisher_representation_id,
      publisher_representation_generation,publisher_grant_id,publisher_grant_generation,result_authority_epoch)
      VALUES ($1,1,$2,'access-policy-v1','first-applicable','deny',0,0,0,1,1,100,$3,$4,$5,$6,0,$7,0,1)`,
      [id, scope, digest(id), owner.id, owner.actor, owner.mandate, grant],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type Definition = {
  resource: string;
  admission: string;
  receipt: string;
  digest: string;
  erased?: boolean;
  protected?: boolean;
  inactive?: boolean;
  missingHead?: boolean;
  predecessor?: boolean;
  expectedHead?: boolean;
  ambiguous?: boolean;
};
async function definitions(
  owner: Controller,
  count = 1,
  options: { action?: string; scope?: string; sealed?: boolean; cancelled?: boolean } = {},
): Promise<Definition[]> {
  const scope = options.scope ?? 'semantic:create:root';
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    scope,
  ]);
  const rows = (
    await pool.query<{ id: string; graph_receipt: string | null; request_digest: string }>(
      `
    INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,idempotency_key,
      request_digest,authority_epoch,expires_at,state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
    SELECT id,$1,$2,$3,$4,id::text,$5,0,now(),$6,
      CASE WHEN $6 = 'sealed' THEN $7 || replace(id::text,'-','') END,
      CASE WHEN $6 = 'sealed' THEN $8 END,CASE WHEN $6 = 'sealed' THEN 'fixture' END,
      CASE WHEN $6 = 'sealed' THEN '1' END,CASE WHEN $6 = 'sealed' THEN now() END
    FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,$9)) ids
    RETURNING id,graph_receipt,request_digest`,
      [
        owner.id,
        owner.actor,
        scope,
        options.action ?? 'semantic.change',
        digest('definition fixture'),
        options.sealed === false ? 'registered' : 'sealed',
        `urn:rezics:receipt:${digest('receipt').slice(0, 32)}`,
        options.cancelled ? 'cancelled' : 'succeeded',
        count,
      ],
    )
  ).rows;
  return rows.map((row) => ({
    resource: native(),
    admission: row.id,
    receipt: row.graph_receipt ?? `urn:rezics:receipt:${digest(row.id)}`,
    digest: row.request_digest,
  }));
}

/** PostgreSQL qualifies the live authority and locks. Graph facts are an owner
 * boundary fixture; the companion test compares the batch and scalar SPARQL. */
function reader(targets: readonly Definition[]) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const proofs: { query: string; bytes: number | undefined }[] = [];
  let fail = false;
  const graph: Pick<FusekiClient, 'query'> = {
    async query(query, bytes) {
      proofs.push({ query, bytes });
      if (!query.includes('rv:admittedScope "semantic:create:root"'))
        return query.includes('ASK') ? { boolean: false } : { results: { bindings: [] } };
      if (fail) throw new Error('definition receipt unavailable');
      const requested = targets.filter((target) => query.includes(`<${target.resource}>`));
      const bindings = requested.flatMap((target) => {
        if (
          target.erased ||
          target.protected ||
          target.inactive ||
          target.missingHead ||
          target.predecessor ||
          target.expectedHead
        )
          return [];
        const row = {
          resource: { type: 'uri', value: target.resource },
          admission: { type: 'literal', value: target.admission },
          receipt: { type: 'uri', value: target.receipt },
          digest: { type: 'literal', value: target.digest },
        };
        return target.ambiguous ? [row, row] : [row];
      });
      expect(Buffer.byteLength(JSON.stringify({ results: { bindings } }))).toBeLessThanOrEqual(
        bytes!,
      );
      return { results: { bindings } };
    },
  };
  const measured = {
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(sql: string, values: unknown[] = []) {
          statements.push({ sql, values });
          return client.query(sql, values);
        },
      };
    },
  } as unknown as Pool;
  const access = new AccessAdmissionRegistry(measured);
  access.configureBaseline(graph);
  return {
    access,
    graph,
    statements,
    proofs,
    fail: (value: boolean) => {
      fail = value;
    },
    clear: () => {
      statements.length = 0;
      proofs.length = 0;
    },
  };
}

async function parity(
  r: ReturnType<typeof reader>,
  owner: Controller,
  targets: readonly Definition[],
  allowed: readonly Definition[],
) {
  expect(
    await r.access.canReadReferences(
      owner.principal,
      owner.actor,
      targets.map((row) => row.resource),
    ),
  ).toEqual(new Set(allowed.map((row) => row.resource)));
  const scalar = referenceReader(r.access, owner.principal, owner.actor);
  for (const target of targets)
    expect(await scalar(target.resource)).toBe(allowed.includes(target));
}

test('current controllers inherit private definition reads and management, without changing creator identity', async () => {
  const old = await controller(),
    next = await controller(),
    targets = await definitions(old, 2);
  const r = reader(targets);
  await parity(r, old, targets, targets);
  await parity(r, next, targets, []);
  await pool.query(
    `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`,
    [next.id, old.actor],
  );
  const successor = { ...next, actor: old.actor };
  await parity(r, successor, targets, targets);
  await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [old.mandate]);
  await parity(r, old, targets, []);
  await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [old.id]);
  await parity(r, successor, targets, targets);
  const edit = (who: Controller) => ({
    principal: who.principal,
    actingSubject: who.actor,
    action: 'semantic.change',
    scope: `semantic:edit:${targets[0]!.resource}`,
    idempotencyKey: randomUUID(),
    requestDigest: digest(randomUUID()),
  });
  expect((await r.access.register(edit(successor))).dispatchEligible).toBe(true);
  await expect(r.access.register(edit(old))).rejects.toThrow();
  expect(
    (
      await pool.query('SELECT principal_id,acting_subject FROM access.admission WHERE id = $1', [
        targets[0]!.admission,
      ])
    ).rows[0],
  ).toEqual({ principal_id: old.id, acting_subject: old.actor });
});

test('revoked and expired mandates, inactive principals and inactive Agents deny both read paths', async () => {
  const expiredTargets = await definitions(expired),
    expiredReader = reader(expiredTargets);
  await parity(expiredReader, expired, expiredTargets, []);
  const client = await pool.connect();
  try {
    expect(
      await definitionCreatorAllowed(
        client,
        expiredReader.graph,
        expired.id,
        expired.actor,
        expiredTargets[0]!.resource,
      ),
    ).toBe(false);
  } finally {
    client.release();
  }
  for (const kind of ['mandate', 'principal', 'agent'] as const) {
    const owner = await controller(),
      targets = await definitions(owner),
      r = reader(targets);
    await retainController(owner);
    await parity(r, owner, targets, targets);
    if (kind === 'mandate')
      await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [
        owner.mandate,
      ]);
    if (kind === 'principal')
      await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [owner.id]);
    if (kind === 'agent')
      await pool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [
        owner.actor,
      ]);
    await parity(r, owner, targets, []);
  }
});

test('receipt, digest, lifecycle and protection failures isolate denied definitions within the batch', async () => {
  const owner = await controller(),
    valid = (await definitions(owner))[0]!;
  const damaged: Definition[] = [];
  for (const flag of [
    'erased',
    'protected',
    'inactive',
    'missingHead',
    'predecessor',
    'expectedHead',
    'ambiguous',
  ] as const)
    damaged.push({ ...(await definitions(owner))[0]!, [flag]: true });
  for (const field of ['admission', 'receipt', 'digest'] as const) {
    damaged.push({ ...(await definitions(owner))[0]!, [field]: 'invalid' });
    damaged.push({
      ...(await definitions(owner))[0]!,
      [field]:
        field === 'admission'
          ? randomUUID()
          : field === 'receipt'
            ? `urn:rezics:receipt:${'e'.repeat(64)}`
            : 'e'.repeat(64),
    });
  }
  damaged.push(
    ...(await definitions(owner, 1, { sealed: false })),
    ...(await definitions(owner, 1, { cancelled: true })),
    ...(await definitions(owner, 1, { action: 'semantic.read' })),
    ...(await definitions(owner, 1, { scope: 'semantic:create:wrong' })),
  );
  const targets = [valid, ...damaged];
  await parity(reader(targets), owner, targets, [valid]);
});

test('private definitions require existing platform read authority and honor closed gates and policies', async () => {
  const owner = await controller(),
    targets = await definitions(owner, 3),
    r = reader(targets);
  expect(
    await r.access.canReadReferences(
      null,
      null,
      targets.map((row) => row.resource),
    ),
  ).toEqual(new Set());
  await pool.query(
    'UPDATE access.principal_permission_grant SET active = false WHERE principal_id = $1 AND action = $2',
    [owner.id, 'platform:resource:semantic.read'],
  );
  await parity(r, owner, targets, []);
  const withAuthority = await controller(),
    privateTargets = await definitions(withAuthority, 4),
    guarded = reader(privateTargets);
  await pool.query('INSERT INTO access.scope_gate (id,open) VALUES ($1,false),($2,true)', [
    `semantic:read:${privateTargets[1]!.resource}`,
    `semantic:read:${privateTargets[2]!.resource}`,
  ]);
  await policy(withAuthority, `semantic:read:${privateTargets[2]!.resource}`, false);
  await policy(withAuthority, `semantic:read:${privateTargets[3]!.resource}`, true);
  await parity(guarded, withAuthority, privateTargets, [privateTargets[0]!]);
});

test('65 private definitions use one bounded receipt batch and one indexed creation/controller batch', async () => {
  const owner = await controller(),
    targets = await definitions(owner, 65),
    r = reader(targets);
  expect(
    await r.access.canReadReferences(
      owner.principal,
      owner.actor,
      targets.map((row) => row.resource),
    ),
  ).toEqual(new Set(targets.map((row) => row.resource)));
  const receiptQueries = r.proofs.filter((row) =>
    row.query.includes('rv:admittedScope "semantic:create:root"'),
  );
  const candidates = r.statements.filter((row) => row.sql.includes('jsonb_to_recordset'));
  expect(receiptQueries).toHaveLength(1);
  expect(candidates).toHaveLength(1);
  expect(receiptQueries[0]!.query.match(/LIMIT 2/g)).toHaveLength(65);
  expect(receiptQueries[0]!.bytes).toBe(66 * REFERENCE_DISCLOSURE_COST.receiptBytesPerResource);
  expect(r.proofs.length).toBeLessThanOrEqual(REFERENCE_DISCLOSURE_COST.graphReads);
  expect(JSON.parse(candidates[0]!.values[0] as string)).toHaveLength(65);
  await expect(
    r.access.canReadReferences(owner.principal, owner.actor, [
      ...targets.map((row) => row.resource),
      native(),
    ]),
  ).rejects.toThrow('batch exceeds');
});

test('graph failure rolls back and a restored owner receipt permits the next bounded read', async () => {
  const owner = await controller(),
    targets = await definitions(owner),
    r = reader(targets);
  r.fail(true);
  await expect(
    r.access.canReadReferences(owner.principal, owner.actor, [targets[0]!.resource]),
  ).rejects.toThrow('definition receipt unavailable');
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  r.fail(false);
  await parity(r, owner, targets, targets);
});

test('a controller revocation waits for the batch proof locks, then denies the next read', async () => {
  const owner = await controller(),
    targets = await definitions(owner);
  await retainController(owner);
  const proof = targets[0]!,
    r = reader(targets),
    client = await pool.connect();
  // Exercise the actual batch statement in an open transaction after a normal read.
  await parity(r, owner, targets, targets);
  const query = r.statements.find((row) => row.sql.includes('jsonb_to_recordset'))!;
  try {
    await client.query('BEGIN');
    expect((await client.query(query.sql, query.values)).rows).toEqual([
      { resource: proof.resource },
    ]);
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        revoker.query('UPDATE access.representation SET active = false WHERE id = $1', [
          owner.mandate,
        ]),
      ).rejects.toMatchObject({ code: '55P03' });
      await revoker.query('ROLLBACK');
    } finally {
      revoker.release();
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [
    owner.mandate,
  ]);
  await parity(r, owner, targets, []);
});
