import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { exportAccountData } from '../../../services/account/src/data-export.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { OwnerOperations } from '../../../services/main/src/modules/owner/operations.ts';
import { mirrorAccountDeletionIntent } from '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
} from '../../../services/main/src/modules/outbox/relay.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  initializeFreshGraph,
} from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { migrateFixtureOwners } from '../../../scripts/fixture/migrate.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { backupRecoverySet } from '../../../scripts/ops/backup.ts';
import { restoreRecoverySet } from '../../../scripts/ops/restore.ts';
import { administratorUrl, openIndex, seal } from '../../../scripts/ops/recovery-set.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';

const key = 'd9'.repeat(32);
function run(program: string, args: string[], environment = process.env): string {
  const result = spawnSync(program, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 3_000_000,
  });
  if (result.status !== 0 || result.error)
    throw new Error(`${program} failed: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout.trim();
}
function archiveBasis(value: Awaited<ReturnType<typeof exportAccountData>>) {
  const { exportedAt: _exportedAt, ...basis } = value;
  return basis;
}

test('G-727: encrypted small owner cut replays WAL, retains deletion/revocation, rebuilds text and releases only after verification', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const sourceId = `g727-source-${nonce}`;
  const restoredId = `g727-target-${nonce}`;
  const heldId = `g727-held-${nonce}`;
  const source = { profile: 'qa' as const, runId: sourceId, persistent: true };
  const directory = join(root, '.temp', 'ops', `drill-${nonce}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secretHome = join(directory, 'offhost-keys');
  const publicHome = join(directory, 'backup-public-keys');
  for (const home of [secretHome, publicHome]) mkdirSync(home, { mode: 0o700 });
  const offhost = { ...process.env, GNUPGHOME: secretHome };
  const publicOnly = { ...process.env, GNUPGHOME: publicHome };
  const frontier = join(directory, 'current-frontier.json');
  const set = join(directory, 'set');
  const pools: Pool[] = [];
  try {
    run(
      'gpg',
      [
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        '--quick-generate-key',
        `G727 recovery ${nonce} <g727-${nonce}@example.test>`,
        'rsa2048',
        'encr',
        '1d',
      ],
      offhost,
    );
    const fingerprint = run('gpg', ['--batch', '--with-colons', '--list-keys'], offhost)
      .split('\n')
      .find((line) => line.startsWith('fpr:'))!
      .split(':')[9]!;
    const publicKey = join(directory, 'recipient.asc');
    run('gpg', ['--batch', '--armor', '--output', publicKey, '--export', fingerprint], offhost);
    run('gpg', ['--batch', '--import', publicKey], publicOnly);
    run('bun', [
      'scripts/dev/cli.ts',
      'stack:up',
      '--profile',
      'qa',
      '--run-id',
      sourceId,
      '--persistent',
    ]);
    const sourceDirectory = stackDirectory(root, source);
    const apps = readEnv(join(sourceDirectory, 'apps.env'));
    const saved = readEnv(join(sourceDirectory, 'compose.env'));
    await migrateFixtureOwners(apps);
    const owner = (name: string) => {
      const pool = new Pool({ connectionString: administratorUrl(saved, name), max: 2 });
      pool.on('error', () => {});
      pools.push(pool);
      return pool;
    };
    const account = owner('account');
    const access = owner('access');
    const content = owner('content');
    const relay = owner('relay');
    const fuseki = new FusekiClient(
      apps.FUSEKI_URL!,
      apps.FUSEKI_MAINTENANCE_TOKEN,
      apps.FUSEKI_COMMAND_TOKEN,
    );
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    const sample = await seedRecoveryContent(
      { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! },
      content,
      access,
    );
    await initializeRelayCheckpoint(relay, apps.MAIN_RELAY_CONSUMER!, lineage.dataEpoch);
    while (await relayMainOutboxOnce(fuseki, relay, apps.MAIN_RELAY_CONSUMER!)) {
      /* complete ordered handoff */
    }
    const person = randomUUID();
    const deleted = randomUUID();
    for (const id of [person, deleted])
      await account.query(
        `INSERT INTO public."user"
      (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1,'Restored reader',$2,true,now(),now())`,
        [id, `${id}@example.test`],
      );
    const operator = { issuer: apps.ACCOUNT_ISSUER!, subject: person };
    const deletedPrincipal = randomUUID();
    await access.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)',
      [randomUUID(), operator.issuer, person, deletedPrincipal, deleted],
    );
    const deletion = await new AccessAdmissionRegistry(access).strongDeactivateAccountSubject(
      operator.issuer,
      deleted,
    );
    if (!deletion) throw new Error('deletion fence was not created');
    await mirrorAccountDeletionIntent(
      access,
      relay,
      deletion.principalId,
      deletion.enforcementEpoch,
    );
    await retainAccountSubjectDeletion(relay, operator.issuer, deleted);
    await account.query('DELETE FROM public."user" WHERE id = $1', [deleted]);
    const revoked = randomUUID();
    const readScope = `work:read:${sample.works[0]}`;
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await access.query(
      `INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until, active)
      VALUES ($1,$2,$2,$3,'work.read',now() + interval '1 hour',false)`,
      [revoked, sample.content.actingSubject, readScope],
    );
    const beforeArchive = archiveBasis(
      await exportAccountData(account, apps.ACCOUNT_SECRET!, person, 'none'),
    );
    const exactBefore = await new ContentCore(content).readExactBatch(
      [sample.content.revisionId],
      async (ids) => new Set(ids),
    );
    const phrase = `PREFIX text: <http://jena.apache.org/text#> SELECT ?s WHERE {
      GRAPH <${PUBLIC_SEARCH_GRAPH}> { (?s ?score ?literal) text:query (<${RV}searchBody> "recovery" 10) } } ORDER BY ?s`;
    const searchBefore = await fuseki.query(phrase);
    expect(searchBefore.results?.bindings.length).toBeGreaterThan(0);
    // A transaction already dispatched before the maintenance cut must commit
    // before role fencing terminates idle sessions and catalog capture begins.
    await access.query(
      'CREATE TABLE access.g727_inflight (id integer PRIMARY KEY, body text NOT NULL); ALTER TABLE access.g727_inflight OWNER TO access',
    );
    const writer = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 1 });
    writer.on('error', () => {});
    pools.push(writer);
    const writerClient = await writer.connect();
    try {
      await writerClient.query('BEGIN');
      await writerClient.query(
        "INSERT INTO access.g727_inflight VALUES (1, 'committed before cut')",
      );
    } catch (error) {
      writerClient.release(true);
      throw error;
    }
    const inFlight = writerClient
      .query('SELECT pg_sleep(3)')
      .then(() => writerClient.query('COMMIT'))
      .finally(() => writerClient.release());
    const backup = await backupRecoverySet({
      out: set,
      recipient: fingerprint,
      frontier,
      key,
      source,
      environment: publicOnly,
    });
    await inFlight;
    expect(backup.phases['postgres-base-and-wal']).toBeGreaterThan(0);
    expect(readFileSync(join(set, 'set.json'), 'utf8')).not.toContain(saved.POSTGRES_PASSWORD!);
    // Both early refusals happen before any target volume is made.
    await expect(
      restoreRecoverySet({
        set,
        project: `rezics-qa-${sourceId}`,
        frontier,
        key,
        environment: offhost,
      }),
    ).rejects.toThrow('distinct from the original');
    const stale = join(directory, 'stale-frontier.json');
    const index = openIndex(readFileSync(join(set, 'set.json'), 'utf8'), key);
    writeFileSync(
      stale,
      seal(
        {
          version: 1,
          id: 'newer-capture',
          manifestDigest: index.manifestDigest,
          capturedAt: new Date().toISOString(),
        },
        key,
        'ops-recovery-frontier',
      ),
    );
    await expect(
      restoreRecoverySet({
        set,
        project: `rezics-qa-${restoredId}`,
        frontier: stale,
        key,
        environment: offhost,
      }),
    ).rejects.toThrow('older');
    // Missing deployment checks never make a staged target serving-ready.
    await expect(
      restoreRecoverySet({
        set,
        project: `rezics-qa-${heldId}`,
        frontier,
        key,
        environment: offhost,
      }),
    ).rejects.toThrow('Restore is held');
    const heldEvidence = JSON.parse(
      readFileSync(
        join(
          stackDirectory(root, { profile: 'qa', runId: heldId, persistent: true }),
          'recovery-evidence.json',
        ),
        'utf8',
      ),
    );
    expect(heldEvidence.state).toBe('held');
    // Avoid keeping two JVMs resident: the failed copy above has already stopped.
    let verifiedBeforeRelease = false;
    const restored = await restoreRecoverySet({
      set,
      project: `rezics-qa-${restoredId}`,
      frontier,
      key,
      environment: offhost,
      checks: {
        verify: async (context) => {
          expect(
            archiveBasis(
              await exportAccountData(
                context.pools.account,
                context.apps.ACCOUNT_SECRET!,
                person,
                'none',
              ),
            ),
          ).toEqual(beforeArchive);
          expect(
            (
              await context.pools.account.query('SELECT id FROM public."user" WHERE id = $1', [
                deleted,
              ])
            ).rowCount,
          ).toBe(0);
          expect(
            (
              await context.pools.access.query(
                'SELECT active FROM access.principal WHERE id = $1',
                [deletedPrincipal],
              )
            ).rows[0]?.active,
          ).toBe(false);
          expect(
            (
              await context.pools.access.query(
                'SELECT active FROM access.permission_grant WHERE id = $1',
                [revoked],
              )
            ).rows[0]?.active,
          ).toBe(false);
          const core = new ContentCore(context.pools.content);
          expect(
            await core.readExactBatch([sample.content.revisionId], async (ids) => new Set(ids)),
          ).toEqual(exactBefore);
          expect(
            await core.readExactBatch([sample.content.revisionId], async () => new Set()),
          ).toEqual([{ revisionId: sample.content.revisionId, status: 'denied' }]);
          expect(await context.fuseki.query(phrase)).toEqual(searchBefore);
          expect(
            (
              await context.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
            <${DATASET}> rv:restoreHold true } }`)
            ).boolean,
          ).toBe(true);
          expect(
            (await context.pools.access.query('SELECT body FROM access.g727_inflight WHERE id = 1'))
              .rows[0]?.body,
          ).toBe('committed before cut');
          verifiedBeforeRelease = true;
        },
        reconcile: async (context, body, idempotencyKey) => {
          expect(verifiedBeforeRelease).toBe(true);
          const env = {
            fuseki: context.fuseki,
            lineage: {
              dataEpoch: context.apps.MAIN_DATA_EPOCH!,
              routingEpoch: context.apps.MAIN_ROUTING_EPOCH!,
            },
            objectDirectory: context.apps.MAIN_OBJECT_DIRECTORY!,
          };
          const registry = new AccessAdmissionRegistry(context.pools.access);
          const operations = new OwnerOperations(context.pools.relay, env, {
            accountPool: context.pools.account,
            accessPool: context.pools.access,
            contentPool: context.pools.content,
            hmacKey: key,
            objectStore: { directory: env.objectDirectory },
          });
          const app = createMainApp(context.fuseki, {
            environment: env,
            account: {
              verify: async (request) => {
                if (request.headers.get('authorization') !== 'Bearer qa-owner')
                  throw new AccountAssertionDenied('denied');
                return operator;
              },
            },
            access: registry,
            content: new ContentCore(context.pools.content),
            ownerOperations: operations,
          });
          expect((await app.handle(new Request('http://localhost/health/ready'))).status).toBe(503);
          const request = (authorization: string) =>
            new Request('http://localhost/v1/owners/reconciliations', {
              method: 'POST',
              headers: {
                authorization,
                'content-type': 'application/json',
                'idempotency-key': idempotencyKey,
              },
              body: JSON.stringify(body),
            });
          expect((await app.handle(request('Bearer denied'))).status).toBe(401);
          return app.handle(request('Bearer qa-owner'));
        },
      },
    });
    expect(restored.state).toBe('verified');
    expect(restored.elapsedMs).toBeLessThanOrEqual(600_000);
    const targetApps = readEnv(
      join(
        stackDirectory(root, { profile: 'qa', runId: restoredId, persistent: true }),
        'apps.env',
      ),
    );
    expect(targetApps.MAIN_DATA_EPOCH).not.toBe(lineage.dataEpoch);
    writeFileSync(
      join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'g-727-small-restore.json'),
      JSON.stringify({ backup, restored }, null, 2),
    );
  } finally {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    for (const runId of [sourceId, heldId, restoredId]) {
      try {
        run('bun', [
          'scripts/dev/cli.ts',
          'stack:reset',
          '--profile',
          'qa',
          '--run-id',
          runId,
          '--persistent',
        ]);
      } catch {
        /* report primary error */
      }
    }
    for (const environment of [offhost, publicOnly])
      run('gpgconf', ['--kill', 'gpg-agent'], environment);
    rmSync(directory, { recursive: true, force: true });
  }
}, 600_000);
