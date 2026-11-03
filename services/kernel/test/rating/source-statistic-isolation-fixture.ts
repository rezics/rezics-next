import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { AuthenticationConfig } from '../../src/access/authenticate.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { ContentCredential } from '../content/support/system.ts';
import { createNativeContentSystemWithOrdinaryScopes } from '../content/support/native-system.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testAccess, testKernel } from '../support/test-kernel.ts';
import { workerTestEnv } from '../support/worker-env.ts';

export const SOURCE_STATISTIC_GROWTH_SCALES = [256, 1024, 4096] as const;

const operationScopes = [
  'access:grant',
  'definitions:read',
  'exposure:open',
  'moderation:hide',
  'rating:vote',
  'source_statistic:write',
  'subject:create',
  'subject:read',
];
// Native setup grants these actions to its personas; exercised actors receive only operationScopes.
const nativeFixtureScopes = [...operationScopes, 'account:suspend', 'space:create', 'realm:create'];

export type IsolationActor = ContentCredential;
export type IsolationRequestOptions = {
  readonly actor?: IsolationActor | null;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly key?: string;
};

type WorkerHandle = { stop(): Promise<void> };

export async function createSourceStatisticIsolationFixture(
  options: { withRatingWorker?: boolean; sourceFences?: boolean } = {},
) {
  const scopes = options.sourceFences ? [...operationScopes, 'source_fence:takedown'] : operationScopes;
  const configuredDatabaseUrl = process.env.DATABASE_URL;
  if (!configuredDatabaseUrl) throw new Error('DATABASE_URL must name the migrated /rezics template');
  const templateUrl = new URL(configuredDatabaseUrl);
  templateUrl.pathname = '/rezics';
  const native = await createNativeContentSystemWithOrdinaryScopes(
    {
      databaseUrl: templateUrl.href,
      namespace: `rating_source_isolation_${randomUUID().replaceAll('-', '')}`,
    },
    options.sourceFences ? [...nativeFixtureScopes, 'source_fence:takedown'] : nativeFixtureScopes,
  );

  let database: GrowthDatabase | undefined;
  let worker: WorkerHandle | undefined;
  try {
    const additionalVoters = await provisionVoters(native, scopes, 2);
    database = await openGrowthDatabase(native.database.pool.options.connectionString);
    database.pool.options.max = 1;
    await bootstrapRelease(database.pool, bundledRelease);

    const auth: AuthenticationConfig = {
      issuer: native.nativeAuth.verifier.issuer,
      audience: native.nativeAuth.verifier.audience,
      jwksUrl: native.nativeAuth.verifier.jwksUrl,
      fetch: (input, init) => native.nativeAuth.handler(new Request(input, init)),
    };
    const app = testKernel({
      pool: database.pool,
      auth,
      writeRate: createWriteRateLimiter({
        secret: `${randomUUID()}${randomUUID()}`,
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
      }),
      ratePeer: () => '127.0.0.1',
    });
    const access = testAccess({ pool: database.pool, actions: actionCatalogue(app), auth });

    const governanceRow = await database.admin.query<{ account_id: string }>(
      'SELECT account_id::text FROM access.governance_bootstrap WHERE route = 0 AND resource_id = $1',
      [GLOBAL_CONTEXT.id],
    );
    const governanceId = governanceRow.rows[0]?.account_id;
    if (!governanceId) throw new Error('Native governance bootstrap did not identify its account');
    const governance = await native.auth.issue({
      accountId: governanceId,
      clientId: native.auth.ordinaryClient.id,
      scopes,
    });

    const narrowCredential = (credential: ContentCredential): Promise<ContentCredential> =>
      native.auth.issue({
        accountId: credential.actor.accountId,
        clientId: native.auth.ordinaryClient.id,
        scopes,
      });
    const author = await narrowCredential(native.actors.author);
    const importer = await narrowCredential(native.actors.other);
    const secondImporter = await narrowCredential(native.actors.moderator);
    const actors = {
      author,
      importer,
      secondImporter,
      governance,
      voters: [author, importer, secondImporter, ...additionalVoters],
    } as const;
    for (const actor of [actors.author, actors.importer, actors.secondImporter, actors.governance, ...actors.voters]) {
      const authenticated = await access.authenticate(actor.bearer, {
        pool: database.pool,
        deadline: Date.now() + 10_000,
      });
      if (authenticated.kind !== 'account' || authenticated.accountId !== actor.actor.accountId)
        throw new Error('Production Access did not authenticate a native fixture account');
    }

    const request = (method: string, path: string, requestOptions: IsolationRequestOptions = {}): Promise<Response> => {
      const actor = requestOptions.actor === undefined ? actors.author : requestOptions.actor;
      const hasBody = requestOptions.body !== undefined || requestOptions.rawBody !== undefined;
      return app.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            'x-request-id': 'rating-source-statistic-isolation',
            ...(actor === null ? {} : { authorization: `Bearer ${actor.bearer}` }),
            ...(requestOptions.key === undefined ? {} : { 'idempotency-key': JSON.stringify(requestOptions.key) }),
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
          },
          ...(hasBody ? { body: requestOptions.rawBody ?? JSON.stringify(requestOptions.body) } : {}),
        }),
      );
    };

    const createSubject = async (label = `Source isolation ${randomUUID()}`): Promise<string> => {
      const response = await request('POST', '/v1/subjects', {
        actor: actors.author,
        key: randomUUID(),
        body: { type: 'schema:Book', labels: { en: label } },
      });
      if (response.status !== 201)
        throw new Error(`Native subject creation failed: HTTP ${response.status}: ${await response.text()}`);
      const result = (await response.json()) as { subject?: { id?: string } };
      if (!result.subject?.id || routeOf(result.subject.id) === null)
        throw new Error('Native subject creation returned no routable subject id');
      return result.subject.id;
    };

    const importerGrantBody = (accountId: string) => ({
      resource: { route: GLOBAL_CONTEXT.route, id: GLOBAL_CONTEXT.id },
      subject: { kind: 'account', id: accountId },
      actions: ['source_statistic:write'],
      valid: '(,)',
    });
    const grantImporter = async (account: IsolationActor): Promise<void> => {
      const response = await request('POST', '/v1/grants', {
        actor: actors.governance,
        key: randomUUID(),
        body: importerGrantBody(account.actor.accountId),
      });
      if (response.status !== 201)
        throw new Error(`Native importer grant failed: HTTP ${response.status}: ${await response.text()}`);
    };
    const revokeImporter = async (account: IsolationActor): Promise<void> => {
      const response = await request('POST', '/v1/grants:revoke', {
        actor: actors.governance,
        key: randomUUID(),
        body: importerGrantBody(account.actor.accountId),
      });
      if (response.status !== 200)
        throw new Error(`Native importer revocation failed: HTTP ${response.status}: ${await response.text()}`);
    };

    const exposure = await request('POST', '/v1/platform/exposure/personal_library:open', {
      actor: actors.governance,
      key: randomUUID(),
    });
    if (exposure.status !== 200)
      throw new Error(`Native personal-library gate opening failed: HTTP ${exposure.status}: ${await exposure.text()}`);

    if (options.withRatingWorker) worker = await startRatingWorker(database.url);

    let closed = false;
    return {
      database,
      app,
      access,
      actors,
      request,
      createSubject,
      grantImporter,
      revokeImporter,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        const errors: unknown[] = [];
        if (worker) {
          try {
            await worker.stop();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await database!.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await native.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Source-statistic isolation fixture cleanup failed');
      },
    };
  } catch (error) {
    try {
      await worker?.stop();
    } catch {
      // Preserve construction failure while releasing only this fixture's worker.
    }
    try {
      await database?.close();
    } catch {
      // Preserve construction failure while releasing only this fixture's database pools.
    }
    await native.close();
    throw error;
  }
}

async function provisionVoters(
  native: Awaited<ReturnType<typeof createNativeContentSystemWithOrdinaryScopes>>,
  scopes: readonly string[],
  count: number,
): Promise<ContentCredential[]> {
  const sourceAccountId = native.actors.author.actor.accountId;
  const credentials: ContentCredential[] = [];
  for (let index = 0; index < count; index++) {
    const accountId = newId(0x7a10 + index);
    await native.database.pool.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
       VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
      [routeOf(accountId), accountId],
    );
    await native.database.authPool.query(`INSERT INTO "user" (id, name, "emailVerified") VALUES ($1, '', false)`, [
      accountId,
    ]);
    const copiedCredential = await native.database.authPool.query(
      `INSERT INTO account (id, "accountId", "providerId", "userId", password, "updatedAt")
       SELECT $1, $1, 'credential', $1, password, now()
       FROM account WHERE "userId" = $2 AND "providerId" = 'credential'`,
      [accountId, sourceAccountId],
    );
    if (copiedCredential.rowCount !== 1) throw new Error('Native Auth fixture could not provision a voter credential');
    credentials.push(
      await native.auth.issue({
        accountId,
        clientId: native.auth.ordinaryClient.id,
        scopes,
      }),
    );
  }
  return credentials;
}

async function startRatingWorker(databaseUrl: string): Promise<WorkerHandle> {
  const workerPath = resolve(import.meta.dir, '../../src/worker.ts');
  const modulePath = resolve(import.meta.dir, '../../src/rating/work-module.ts');
  const env = Object.fromEntries(
    Object.entries(
      workerTestEnv({ DATABASE_URL: databaseUrl, KERNEL_EXECUTOR_ID: `rating-isolation-${randomUUID()}` }),
    ).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const script = `
    import { startWorker, readWorkerConfig } from ${JSON.stringify(workerPath)};
    import { ratingWorkModule } from ${JSON.stringify(modulePath)};
    const env = process.env;
    await startWorker(readWorkerConfig(env), [ratingWorkModule], env);
    console.info('RATING_SOURCE_ISOLATION_WORKER_READY');
  `;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolveReadyWorker) => {
    resolveReady = resolveReadyWorker;
  });
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        output = `${output}${decoder.decode(chunk.value)}`.slice(-16_000);
        if (output.includes('RATING_SOURCE_ISOLATION_WORKER_READY')) resolveReady();
      }
    } finally {
      reader.releaseLock();
    }
  };
  void pump(child.stdout);
  void pump(child.stderr);
  const readyOrExit = await Promise.race([
    ready.then(() => true),
    child.exited.then(() => false),
    Bun.sleep(60_000).then(() => false),
  ]);
  if (!readyOrExit) {
    child.kill('SIGTERM');
    const exitCode = await child.exited;
    throw new Error(`Rating worker failed to become ready (exit ${exitCode}): ${output}`);
  }
  return {
    async stop(): Promise<void> {
      if (child.exitCode === null) child.kill('SIGTERM');
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(`Rating worker exited with ${exitCode}: ${output}`);
    },
  };
}
