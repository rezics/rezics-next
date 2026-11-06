import { afterAll, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import * as contentWork from '../../src/content/work.ts';
import { createContentWorkModule } from '../../src/content/register.ts';

const registerContent = createContentWorkModule({ fetch: (request) => fetch(request), now: () => Date.now() });
import { createPool } from '../../src/database/pool.ts';
import { accessCheck, type Access } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { WorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');

const route = 0x4312;
const action = 'post:read';
const issuer = 'https://content-worker-clock.example.test';
const audience = 'https://kernel.test';
const yearMs = 365.25 * 24 * 60 * 60 * 1000;
const routeKey = Buffer.alloc(32, 7).toString('base64url');
const pool = createPool(url);
const accountId = newId(0x1234);
const resourceId = newId(route);

let databaseNow = 0;
let kernelNow = new Date(0);
const clock = () => new Date(kernelNow.getTime());

function twoYearsAhead(base: number): Date {
  const date = new Date(base);
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  return date;
}

afterAll(() => pool.end());

test("the content worker's Access sees a grant written at a command's T on a clock two years ahead of PostgreSQL", async () => {
  const now = await pool.query<{ at: Date }>('SELECT clock_timestamp() AS at');
  databaseNow = now.rows[0]!.at.getTime();
  kernelNow = twoYearsAhead(databaseNow);
  expect(kernelNow.getTime() - databaseNow).toBeGreaterThan(yearMs);

  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(accountId), accountId],
  );

  let workerAccess: Access | undefined;
  const createWork = contentWork.createContentWork;
  const observed = spyOn(contentWork, 'createContentWork').mockImplementation((options) => {
    workerAccess = options.access;
    return createWork(options);
  });
  const pair = await generateKeyPair('ES256');
  const publicKey = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'content-worker-clock',
    alg: 'ES256',
    use: 'sig',
  };
  const fetchKeys = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json({ keys: [publicKey] }), { preconnect() {} }),
  );
  const previous = {
    issuer: process.env.AUTH_ISSUER,
    audience: process.env.AUTH_AUDIENCE,
    jwks: process.env.AUTH_JWKS_URL,
  };
  process.env.AUTH_ISSUER = issuer;
  process.env.AUTH_AUDIENCE = audience;
  process.env.AUTH_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    work = await composeWork([registerContent], {
      databaseUrl: url,
      pool,
      client: {
        async registerQueue() {},
        async applySchedules() {},
      } as unknown as WorkClient,
      env: { KERNEL_ROUTE_KEY: routeKey },
      clock,
    });
    const access = workerAccess;
    expect(access).toBeDefined();

    const written = await runCommand(
      pool,
      { partition: partitionOf(route), clock, deadline: Date.now() + 5_000 },
      async (tx, command) => {
        const at = authoritativeTimeValue(command.time);
        await tx.query(
          `INSERT INTO access.resource_grant
              (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
             VALUES ($1,$2,'identity',$3,'',$4,tstzrange($5::timestamptz, NULL, '[)'),$6)`,
          [route, resourceId, accountId, action, at, command.transactionId],
        );
        return { value: { at }, events: [{ type: 'com.rezics.subject.created.v1', data: { id: resourceId } }] };
      },
    );
    const stored = await pool.query<{ starts: string }>(
      `SELECT lower(valid)::text AS starts FROM access.resource_grant
         WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND action = $4`,
      [route, resourceId, accountId, action],
    );
    const starts = Date.parse(stored.rows[0]!.starts);
    expect(starts).toBe(Date.parse(written.value.at));
    expect(starts).toBeGreaterThan(databaseNow + yearMs);

    const token = await new SignJWT({
      client_id: 'rezics-website',
      scope: action,
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'content-worker-clock' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
    const actor = await access!.authenticate(token, { pool, deadline: Date.now() + 5_000 });
    const check = await accessCheck(
      access!,
      actor,
      action,
      { route, id: resourceId },
      {
        pool,
        deadline: Date.now() + 5_000,
      },
    );
    expect(await check(pool)).toBe(true);
  } finally {
    observed.mockRestore();
    fetchKeys.mockRestore();
    if (previous.issuer === undefined) delete process.env.AUTH_ISSUER;
    else process.env.AUTH_ISSUER = previous.issuer;
    if (previous.audience === undefined) delete process.env.AUTH_AUDIENCE;
    else process.env.AUTH_AUDIENCE = previous.audience;
    if (previous.jwks === undefined) delete process.env.AUTH_JWKS_URL;
    else process.env.AUTH_JWKS_URL = previous.jwks;
    await work?.shutdown();
  }
}, 30_000);
