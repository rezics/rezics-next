import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import {
  AccessAdmissionRegistry,
  AdmissionConflict,
  AdmissionDenied,
} from '../src/modules/access/admission.ts';
import { AccessGrants } from '../src/modules/access/grants.ts';
import { AccessPlatformAdministrators } from '../src/modules/access/platform-administrator.ts';
import {
  withZonePageContentTarget,
  zonePageContentAllowed,
  zoneEditScope,
} from '../src/modules/access/zone-content-authority.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `zone-content-owner-${randomUUID()}`);
const data = join(state, 'pgdata');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) });
const resource = () => `https://rezics.com/id/${randomUUID()}`;
let pool: Pool;
let started = false;
let admin: Awaited<ReturnType<typeof controller>>;
let grants: AccessGrants;
let access: AccessAdmissionRegistry;

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
        return reject(new Error('No PostgreSQL test port'));
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
  admin = await controller();
  await new AccessPlatformAdministrators(pool).designateFirst(
    admin.principal.issuer,
    admin.principal.subject,
    () => undefined,
  );
  grants = new AccessGrants(pool);
  access = new AccessAdmissionRegistry(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (started)
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      cwd: state,
      stdio: 'pipe',
    });
});

/** A current controller is sufficient for administrator authority. Deliberately
 * never creates an agent_provision, including for the grant issuer. */
async function controller() {
  const id = randomUUID(),
    actor = resource(),
    control = randomUUID();
  const identity = {
    issuer: 'https://account.zone-content.test',
    subject: randomUUID(),
    emailVerified: false,
  };
  const principal = { ...identity, currentAssertion: async () => identity };
  await pool.query(
    'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [id, identity.issuer, identity.subject],
  );
  await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
  await pool.query(
    `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`,
    [control, id, actor],
  );
  return { id, actor, control, principal };
}

async function context() {
  const epoch = (
    await pool.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'platform:access'",
    )
  ).rows[0]!.authority_epoch;
  return { principal: admin.principal, issuerSubject: admin.actor, expectedAuthorityEpoch: epoch };
}

async function authorize(zone: string, expiry: Date | null = null, administrator = true) {
  const person = await controller();
  if (administrator)
    await grants.platform.create(
      await context(),
      randomUUID(),
      'platform:use:platform-admin',
      { principalId: person.id },
      null,
      receipt(),
    );
  const permission = await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:resource:zone.edit',
    { principalId: person.id },
    expiry,
    receipt(),
    zoneEditScope(zone),
  );
  return { ...person, permission };
}

function request(
  person: Awaited<ReturnType<typeof controller>>,
  zone: string,
  action: 'content.draft' | 'content.publish' = 'content.draft',
) {
  const page = resource();
  return withZonePageContentTarget(
    {
      principal: person.principal,
      actingSubject: person.actor,
      scope: `${action.replace('.', ':')}:${page}`,
      action,
      idempotencyKey: randomUUID(),
      requestDigest: digest([action, page, zone]),
    },
    zone,
  );
}

test('a live zone.edit administrator registers, replays and claims draft and publish without an Agent provision', async () => {
  const zone = resource(),
    person = await authorize(zone);
  expect((await pool.query('SELECT 1 FROM access.agent_provision')).rowCount).toBe(0);
  // The same controller can use ordinary Zone editing, including with an
  // unverified account; Content must select that same administrator path.
  await access.assertAuthority({
    principal: person.principal,
    actingSubject: person.actor,
    action: 'zone.edit',
    scope: zoneEditScope(zone),
  });
  for (const action of ['content.draft', 'content.publish'] as const) {
    const input = request(person, zone, action);
    const registered = await access.register(input);
    expect(registered).toMatchObject({
      state: 'registered',
      dispatchEligible: true,
      replayed: false,
    });
    const saved = (
      await pool.query(
        `SELECT resolved_zone_page FROM access.platform_administrator_admission
      WHERE admission_id = $1`,
        [registered.id],
      )
    ).rows[0];
    expect(saved.resolved_zone_page).toBe(zone);
    expect(
      (
        await pool.query('SELECT 1 FROM access.baseline_admission WHERE admission_id = $1', [
          registered.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await access.register(input)).toMatchObject({
      id: registered.id,
      replayed: true,
      dispatchEligible: true,
    });
    const claimed = await access.claim(registered.id, input.requestDigest, person.principal);
    expect(claimed).toMatchObject({ id: registered.id, state: 'claimed' });
    expect(await access.claim(registered.id, input.requestDigest, person.principal)).toMatchObject({
      claimedAt: claimed.claimedAt,
    });
    expect(await access.register(input)).toMatchObject({
      id: registered.id,
      state: 'claimed',
      dispatchEligible: true,
    });
  }
  const client = await pool.connect();
  try {
    expect(
      await zonePageContentAllowed(client, undefined, person.id, person.actor, zone, false),
    ).toBe(true);
  } finally {
    client.release();
  }
});

test('administrator replay and the immutable proof refuse a changed or omitted resolved Zone', async () => {
  const zone = resource(),
    person = await authorize(zone),
    input = request(person, zone);
  const registered = await access.register(input);
  await expect(access.register({ ...input, resolvedZonePage: resource() })).rejects.toBeInstanceOf(
    AdmissionConflict,
  );
  const { resolvedZonePage: _zone, ...omitted } = input;
  await expect(access.register(omitted)).rejects.toBeInstanceOf(AdmissionConflict);
  await expect(
    access.register({ ...input, baselineRelatedWork: resource() }),
  ).rejects.toBeInstanceOf(AdmissionConflict);
  await expect(
    pool.query(
      'UPDATE access.platform_administrator_admission SET resolved_zone_page = $2 WHERE admission_id = $1',
      [registered.id, resource()],
    ),
  ).rejects.toThrow();
  expect(await access.claim(registered.id, input.requestDigest, person.principal)).toMatchObject({
    state: 'claimed',
  });
});

test('revoked or replacement zone.edit grants cannot dispatch the saved administrator admission', async () => {
  const zone = resource(),
    person = await authorize(zone),
    input = request(person, zone, 'content.publish');
  const registered = await access.register(input);
  await grants.platform.revoke(
    await context(),
    person.permission.grant.id,
    person.permission.grant.generation,
    receipt(),
  );
  expect(await access.register(input)).toMatchObject({
    id: registered.id,
    replayed: true,
    dispatchEligible: false,
  });
  await expect(
    access.claim(registered.id, input.requestDigest, person.principal),
  ).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(access.register(request(person, zone))).rejects.toBeInstanceOf(AdmissionDenied);
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:resource:zone.edit',
    { principalId: person.id },
    null,
    receipt(),
    zoneEditScope(zone),
  );
  expect(await access.register(input)).toMatchObject({
    id: registered.id,
    dispatchEligible: false,
  });
  await expect(
    access.claim(registered.id, input.requestDigest, person.principal),
  ).rejects.toBeInstanceOf(AdmissionDenied);
  expect(await access.register(request(person, zone))).toMatchObject({ dispatchEligible: true });
});

test('zone.edit expiry makes replay ineligible and refuses claim while the admission lease remains live', async () => {
  const zone = resource(),
    expiry = new Date(Date.now() + 2000),
    person = await authorize(zone, expiry);
  const input = request(person, zone),
    registered = await access.register(input);
  expect(await access.register(input)).toMatchObject({ dispatchEligible: true });
  // Owner clock, bounded to two seconds: exercise natural grant expiry without
  // mutating its immutable episode or expiring the thirty-second admission.
  await pool.query(
    'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.02)',
    [expiry],
  );
  expect(
    (
      await pool.query(
        'SELECT expires_at > clock_timestamp() AS live FROM access.admission WHERE id = $1',
        [registered.id],
      )
    ).rows[0].live,
  ).toBe(true);
  expect(await access.register(input)).toMatchObject({
    id: registered.id,
    dispatchEligible: false,
  });
  await expect(
    access.claim(registered.id, input.requestDigest, person.principal),
  ).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(access.register(request(person, zone))).rejects.toBeInstanceOf(AdmissionDenied);
});

test('Content refuses missing administrator use, the wrong Zone grant and missing current Account assertion', async () => {
  const zone = resource(),
    resourceOnly = await authorize(zone, null, false);
  await expect(access.register(request(resourceOnly, zone))).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  const person = await authorize(zone);
  await expect(access.register(request(person, resource()))).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  const input = request(person, zone),
    registered = await access.register(input);
  // Without server resolution this remains an ordinary Work/Post Content
  // request, which a zone.edit grant alone cannot authorize.
  const { resolvedZonePage: _zone, ...ordinaryContent } = request(person, zone);
  await expect(access.register(ordinaryContent)).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(access.claim(registered.id, input.requestDigest)).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  await expect(
    access.claim(registered.id, input.requestDigest, {
      ...person.principal,
      currentAssertion: async () => ({ ...person.principal, subject: randomUUID() }),
    }),
  ).rejects.toBeInstanceOf(AdmissionDenied);
  expect(await access.claim(registered.id, input.requestDigest, person.principal)).toMatchObject({
    state: 'claimed',
  });
});

test('a changed controller episode cannot replay or claim a provision-free administrator admission', async () => {
  const zone = resource(),
    person = await authorize(zone),
    input = request(person, zone);
  const registered = await access.register(input);
  await pool.query('UPDATE access.representation SET generation = generation + 1 WHERE id = $1', [
    person.control,
  ]);
  expect(await access.register(input)).toMatchObject({
    id: registered.id,
    dispatchEligible: false,
  });
  await expect(
    access.claim(registered.id, input.requestDigest, person.principal),
  ).rejects.toBeInstanceOf(AdmissionDenied);
  expect(await access.register(request(person, zone))).toMatchObject({ dispatchEligible: true });
});
