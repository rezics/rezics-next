import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  createAuthHost,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const issuer = 'https://media-erase-growth.auth.test';
const audience = 'https://media-erase-growth.api.test';
const password = 'media erase growth registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(41);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(42)]]) };
const scales = [256, 1024, 4096] as const;
const bytes = 256;
const sha256 = 'a'.repeat(64);
let positionBase = 0n;

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let author: { accountId: string; bearer: string };
let homeRoute: number;
let containerId: string;

async function issue(email: string, scopes: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'media-erase-growth-client', scope: scopes }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string, scopes: string[]) {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@media-erase-growth.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@media-erase-growth.test`, scopes) };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 4;
  authDatabaseName = `media_erase_growth_auth_${randomUUID().replaceAll('-', '')}`;
  await db.admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });

  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'media-erase-growth',
  };
  const limiter = createWriteRateLimiter({
    secret: 'media-erase-growth-private-write-rate-secret-32b',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100000, seconds: 86400 } },
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }),
    writeRate: limiter,
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const provisioning = createProvisioningEvidenceVerifier({ database: authPool });
  const internal = createLifecycleInternals({
    pool: db.pool,
    routeKey,
    provisioningEvidence: (evidence) => provisioning.resolve(evidence),
    recoveryEvidence: async () => null,
  });
  const registrationPorts = {
    ...internal,
    async createPending(input: Parameters<typeof internal.createPending>[0]) {
      const outcome = await internal.createPending(input);
      const pair = { accountId: input.accountId, reservationId: input.reservationId };
      if (!(await proofs.pendingReference(pair))) {
        const reference = await registration.createProvisioningReference({ input, outcome });
        if (!reference) throw new Error('Missing native registration reference');
        await proofs.recordPending({ ...pair, reference });
      }
      return outcome;
    },
    async provisioningReference(input: { accountId: string; reservationId: string }) {
      const reference = await proofs.pendingReference(input);
      if (!reference) throw new Error('Missing persisted registration reference');
      return reference;
    },
    provisioningEvidence: (input: { accountId: string; reservationId: string }) => proofs.provisioningEvidence(input),
  };
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'media-erase-growth-auth-persistent-secret-32b',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool: db.pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(43),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'media-erase-growth-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'media-erase-growth-client', firstParty: true, scopes });
  await host.start();
  author = await person('media_erase_growth_author', scopes);

  const homePartition = 231;
  homeRoute = homePartition * 16 + 5;
  containerId = newId(homeRoute);
});

afterAll(async () => {
  await host?.stop();
  if (authDatabaseName) await db?.admin.query(`DROP DATABASE IF EXISTS ${authDatabaseName}`);
  await db?.close();
});

async function createProbe(): Promise<string> {
  const mediaId = newId(homeRoute);
  const transactionId = newId(homeRoute);
  await db.admin.query(
    `INSERT INTO content.media (
       route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type, byte_count,
       declared_sha256, actual_byte_count, sha256, state, key, transaction_id, erased, collection_pending,
       taken_down, security_revision
     ) VALUES ($1,$2,$3,$4,$5,'post-image','image/png',$6,$7,$6,$7,'uploaded',$8,$9,false,false,false,0)`,
    [
      homeRoute,
      mediaId,
      containerId,
      author.accountId,
      randomUUID(),
      bytes,
      sha256,
      `m/${mediaId}/original`,
      transactionId,
    ],
  );
  await db.admin.query(
    `INSERT INTO access.resource_initialization(route,resource_id,resource_type,creator_id,initialized_at)
     VALUES ($1,$2,'content.media',$3,'2026-10-25T00:00:00.000Z')`,
    [homeRoute, mediaId, author.accountId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_role_grant(
       route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id
     ) VALUES ($1,$2,'identity',$3,'','content.media.owner','[2020-01-01 00:00:00+00,)', $4)`,
    [homeRoute, mediaId, author.accountId, transactionId],
  );
  return mediaId;
}

async function eraseThroughKernel(mediaId: string): Promise<void> {
  const response = await kernel.handle(
    new Request(`${audience}/v1/media/${mediaId}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${author.bearer}`,
        [IDEMPOTENCY_HEADER]: JSON.stringify(randomUUID()),
      },
    }),
  );
  expect(response.status).toBe(204);
}

function mediaPopulation(): Population {
  return {
    name: `media-erase-growth-${randomUUID()}`,
    hotPartition: partitionOf(homeRoute),
    hotShare: 0.5,
    rows: ({ route, partition, ordinal }) => {
      const mediaId = newId(route);
      const backgroundAccount = newId(route);
      const container = newId(route);
      const transactionId = newId(route);
      const position = positionBase + BigInt(ordinal) + 1n;
      const requestKey = `media-erase-growth-${ordinal}`;
      const digest = createHash('sha256').update(requestKey).digest();
      return {
        'access.account': [
          {
            route,
            account_id: backgroundAccount,
            kind: 'actor',
            handle: `media_growth_${ordinal}`,
            state: 'active',
            transaction_id: transactionId,
            membership_inverse_complete: true,
          },
        ],
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: container,
            uploader_id: backgroundAccount,
            reservation_request_id: requestKey,
            purpose: 'post-image',
            media_type: 'image/png',
            byte_count: bytes,
            declared_sha256: sha256,
            actual_byte_count: bytes,
            sha256,
            state: 'uploaded',
            key: `m/${mediaId}/original`,
            transaction_id: transactionId,
            erased: false,
            collection_pending: false,
            taken_down: false,
            security_revision: 0,
          },
        ],
        'access.resource_initialization': [
          {
            route,
            resource_id: mediaId,
            resource_type: 'content.media',
            creator_id: backgroundAccount,
            initialized_at: '2026-10-25T00:00:00.000Z',
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: mediaId,
            subject_kind: 'identity',
            subject_id: backgroundAccount,
            subject_role: '',
            grant_role: 'content.media.owner',
            valid: '[2020-01-01 00:00:00+00,)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: container,
            subject_kind: 'identity',
            subject_id: backgroundAccount,
            subject_role: '',
            action: 'media:create',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_denial': [
          {
            route,
            resource_id: mediaId,
            subject_id: author.accountId,
            action: 'media:complete',
            reason: 'resource',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'core.outbox': [
          {
            partition_no: partition,
            position,
            epoch: 1,
            event_seq: 0,
            event_count: 1,
            id: newId(route),
            type: 'com.rezics.content.media.reserved.v1',
            subject: mediaId,
            data: { mediaId, containerId: container, actorId: backgroundAccount },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partition,
            position,
            epoch: 1,
            transaction_id: transactionId,
            principal_kind: 'account',
            principal_id: backgroundAccount,
            client_id: 'media-erase-growth-client',
            requested_by: null,
          },
        ],
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: backgroundAccount,
            command_kind: 'content.media.reserve',
            idempotency_key: requestKey,
            request_digest: digest,
            epoch: 1,
            position,
            transaction_id: transactionId,
            response: { mediaId },
          },
        ],
      };
    },
    finish: async (admin) => {
      await admin.query(
        `UPDATE core.partition p SET position = GREATEST(p.position, v.position)
         FROM (
           SELECT partition_no, max(position)::bigint AS position
           FROM core.outbox WHERE position >= $1 GROUP BY partition_no
         ) v
         WHERE p.partition_no = v.partition_no`,
        [positionBase.toString()],
      );
    },
  };
}

test('Erase media stays within its bound as M grows', async () => {
  const population = mediaPopulation();
  const report = await checkGrowth(db, {
    name: 'Erase media',
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (database, scale, previous) => {
      const latest = await database.admin.query<{ position: string }>(
        'SELECT COALESCE(max(position),0)::text AS position FROM core.outbox',
      );
      positionBase = BigInt(latest.rows[0]!.position) + 1000n;
      await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
    },
    operation: async () => eraseThroughKernel(await createProbe()),
    warmup: async () => eraseThroughKernel(await createProbe()),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 180_000);
