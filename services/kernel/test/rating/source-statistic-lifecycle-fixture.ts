import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createFigureFixture, type FigureFixture } from './support/figure-fixture.ts';

const issuer = 'https://source-statistic.auth.example.test';
const audience = 'https://api.rezics.test';
const scopes = [
  'rating:vote',
  'source_fence:takedown',
  'source_statistic:write',
  'subject:read',
  'subject:create',
  'subject:merge',
];

export type SourceStatisticLifecycleFixture = Awaited<ReturnType<typeof createSourceStatisticLifecycleFixture>>;

/** Production Kernel and shared Access with signed account tokens over a migrated isolated database.
 * The optional native figure fixture
 * supplies real public figures and worker-produced rating controls for the composed lifecycle acceptance. */
export async function createSourceStatisticLifecycleFixture(options: { nativeFigures?: boolean } = {}) {
  let database: GrowthDatabase | undefined;
  let nativeFigures: FigureFixture | undefined;
  let closeBase: (() => Promise<void>) | undefined;
  try {
    if (options.nativeFigures) {
      nativeFigures = await createFigureFixture({ subjects: 4, partitions: 2 });
      database = nativeFigures.database;
      closeBase = () => nativeFigures!.close();
    } else {
      database = await openGrowthDatabase();
      closeBase = () => database!.close();
    }
    const routeKey =
      nativeFigures === undefined ? new Uint8Array(32).fill(121) : communityFixtureRuntime().system.routeKey;
    const accountId = newId(0x23a1);
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
       VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
      [routeOf(accountId), accountId],
    );
    const keys = await generateKeyPair('ES256', { extractable: true });
    const kid = `source-statistic-${crypto.randomUUID()}`;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid, alg: 'ES256' };
    const clientId = `source-statistic-lifecycle-${crypto.randomUUID()}`;
    const issue = (requestedScopes: readonly string[]) =>
      new SignJWT({
        client_id: clientId,
        scope: requestedScopes.join(' '),
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(accountId)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey);

    let access: ReturnType<typeof createAccess>;
    const app = createKernel({
      receiptKeys: testReceiptKeys(),
      pool: database.pool,
      routeKey,
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(27)]]) },
      writeRate: createWriteRateLimiter({
        secret: 'source-statistic-lifecycle-write-rate-secret-at-least-32-bytes',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
      }),
      ratePeer: () => '127.0.0.1',
      access: (config) =>
        (access = createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
            fetch: async () => Response.json({ keys: [jwk] }),
          },
        })),
    });
    const fullBearer = await issue(scopes);
    const readerBearer = await issue(['subject:read']);

    await database.admin.query(
      `INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       VALUES (0, $1, 'identity', $2, '', 'platform.governance',
               tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $3)`,
      [GLOBAL_CONTEXT, accountId, crypto.randomUUID()],
    );
    await database.admin.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       SELECT 'personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1
       WHERE NOT EXISTS (
         SELECT 1 FROM access.exposure_opening WHERE "group"='personal_library' AND upper_inf(valid)
       )`,
      [crypto.randomUUID()],
    );

    async function identityCommand(action: string) {
      const context = { pool: database!.pool, deadline: Date.now() + 30_000 };
      const actor = await access.authenticate(fullBearer, context);
      if (actor.kind !== 'account') throw new Error('Expected authenticated lifecycle account');
      const authorization = await accessCommandAuthorization(
        access,
        actor,
        action,
        { route: 0, id: GLOBAL_CONTEXT },
        context,
        () => new Error(`Denied lifecycle ${action}`),
      );
      return { actor, authorization, deadline: context.deadline };
    }
    const release = { digest: bundledDigest, release: bundledRelease };
    let closed = false;
    return {
      database,
      app,
      routeKey,
      actorId: accountId,
      bearer: fullBearer,
      readerBearer,
      nativeFigures,
      async createSubject() {
        const key = crypto.randomUUID();
        const command = await identityCommand('subject:create');
        const result = await createSubject(database!.pool, {
          ...command,
          target: subjectTarget(routeKey, accountId, key),
          idempotencyKey: key,
          digest: createHash('sha256').update(key).digest(),
          item: { type: 'schema:Book', labels: { en: 'Alias lifecycle subject' } },
          release,
        });
        return result.subject.id;
      },
      async merge(original: string, survivor: string) {
        const key = crypto.randomUUID();
        return mergeSubjects(database!.pool, {
          ...(await identityCommand('subject:merge')),
          subjects: [original, survivor],
          survivor,
          idempotencyKey: key,
          digest: createHash('sha256').update(key).digest(),
          release,
        });
      },
      async request(
        method: string,
        path: string,
        requestOptions: { body?: unknown; key?: string; bearer?: string; anonymous?: boolean } = {},
      ): Promise<Response> {
        const key = requestOptions.key ?? crypto.randomUUID();
        return app.handle(
          new Request(`http://kernel.test${path}`, {
            method,
            headers: {
              'x-request-id': 'source-statistic-lifecycle-test',
              ...(requestOptions.anonymous ? {} : { authorization: `Bearer ${requestOptions.bearer ?? fullBearer}` }),
              ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
              ...(requestOptions.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
          }),
        );
      },
      async revokeWriter(): Promise<void> {
        await database!.admin.query(
          'DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND grant_role=$3',
          [GLOBAL_CONTEXT, accountId, 'platform.governance'],
        );
      },
      async restoreWriter(): Promise<void> {
        await database!.admin.query(
          `INSERT INTO access.resource_role_grant
             (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
           VALUES (0, $1, 'identity', $2, '', 'platform.governance',
                   tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $3)`,
          [GLOBAL_CONTEXT, accountId, crypto.randomUUID()],
        );
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await closeBase!();
      },
    };
  } catch (error) {
    await closeBase?.();
    throw error;
  }
}
