/** Disposable, admitted fixture setup for the one Account used by Semantic consent. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  developmentJwksFetch,
  firstPublicWebWalk,
  issuerPublicJwksUrl,
  kernelEnvironment,
  localDatabase,
  origins,
  readLocalDeveloperAccountId,
  semanticWalkClientRegistration,
} from '../../../services/auth/scripts/dev-stack.ts';
import { withDevelopmentDatabase } from '../../../services/auth/scripts/dev-stack-native.ts';
import { walkAcceptanceId, walkStackAdmitted } from '../../../scripts/stack-run.ts';
import {
  SEED_JOURNAL_IDENTITY_FILE,
  seedJournalDatabaseIdentity,
  walkStackPorts,
} from '../../../scripts/walk-stack.ts';

const root = resolve(import.meta.dir, '../../..');
let stage = 'admission';
try {
  if (
    !firstPublicWebWalk() ||
    !walkAcceptanceId(process.env, 'native') ||
    !walkAcceptanceId(process.env, 'browser') ||
    !walkStackAdmitted(process.env, root)
  )
    throw new Error();

  stage = 'stack-binding';
  const env = await kernelEnvironment();
  const url = localDatabase(env.DATABASE_URL!);
  const ports = walkStackPorts(Number(process.env.REZICS_WALK_STACK_SLOT));
  const loopback = (port: number) => `http://127.0.0.1:${port}`;
  const databaseIdentity = await readFile(resolve(root, '.temp/cross-media-seed', SEED_JOURNAL_IDENTITY_FILE), 'utf8');
  if (
    url.port !== String(ports.database) ||
    databaseIdentity.trim() !== seedJournalDatabaseIdentity(url.href) ||
    origins.kernel !== loopback(ports.kernel) ||
    origins.issuer !== loopback(ports.issuer) ||
    origins.native !== loopback(ports.native)
  )
    throw new Error();

  stage = 'fixture-input';
  const input: unknown = await Bun.stdin.json();
  if (
    !input ||
    typeof input !== 'object' ||
    !('bearer' in input) ||
    typeof input.bearer !== 'string' ||
    !('digest' in input) ||
    typeof input.digest !== 'string' ||
    !('head' in input) ||
    typeof input.head !== 'number' ||
    input.head < 1
  )
    throw new Error();
  const { bearer, digest, head } = input;
  const accountId = await readLocalDeveloperAccountId();
  if (!accountId) throw new Error();

  stage = 'native-preparation';
  await withDevelopmentDatabase(env, async () => {
    const [{ createAuthenticator }, { readAccount }, { synchronizeAccountAgent }, { activeRelease }, { routeOf }] =
      await Promise.all([
        import('../../../services/kernel/src/access/authenticate.ts'),
        import('../../../services/kernel/src/access/account-data.ts'),
        import('../../../services/kernel/src/access/account-agent-effect.ts'),
        import('../../../services/kernel/src/semantic/definition-release-read.ts'),
        import('../../../services/kernel/src/route/route.ts'),
      ]);
    const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    try {
      stage = 'active-release';
      const release = await activeRelease(pool);
      if (release?.digest !== digest || release.head !== head) throw new Error();

      stage = 'editor-authentication';
      const jwksUrl = issuerPublicJwksUrl(origins.issuer);
      const { authenticate } = createAuthenticator({
        issuer: origins.issuer,
        audience: origins.audience,
        jwksUrl,
        fetch: developmentJwksFetch(jwksUrl, origins.native),
      });
      const actor = await authenticate(bearer, { pool, deadline: Date.now() + 2_000 });
      const route = routeOf(accountId);
      if (
        actor.kind !== 'account' ||
        actor.accountId !== accountId ||
        actor.clientId !== semanticWalkClientRegistration().clientId ||
        actor.requestedBy !== null ||
        route === null
      )
        throw new Error();
      const client = await pool.connect();
      try {
        const account = await readAccount(client, route, accountId);
        if (
          account?.state !== 'active' ||
          account.kind !== 'actor' ||
          account.fenced ||
          account.operatorAccountId !== null
        )
          throw new Error();
      } finally {
        client.release();
      }

      // This disposable fixture owns the same command adapters and receipt keys as the native Kernel.
      stage = 'native-command-composition';
      const [{ installNativeHistoryPreload }, { configureReceiptKeys, readReceiptKeyRing }] = await Promise.all([
        import('../../../services/kernel/src/composition/preload.ts'),
        import('../../../services/kernel/src/command/receipt-key.ts'),
      ]);
      installNativeHistoryPreload();
      configureReceiptKeys(pool, readReceiptKeyRing(env));

      stage = 'one-account-synchronization';
      await synchronizeAccountAgent(pool, actor.accountId);
    } finally {
      await pool.end();
    }
  });
  console.info('semantic editor Agent fixture: synchronization completed; original activation delivery unobserved');
} catch {
  console.error(`semantic editor Agent fixture: blocked at ${stage}`);
  process.exitCode = 1;
}
