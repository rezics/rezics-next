import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
} from '../../../services/main/src/modules/outbox/relay.ts';
import { RV, initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { migrateFixtureOwners } from '../../../scripts/fixture/migrate.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { backupRecoverySet } from '../../../scripts/ops/backup.ts';
import { restoreRecoverySet } from '../../../scripts/ops/restore.ts';
import { administratorUrl, openIndex, seal } from '../../../scripts/ops/recovery-set.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';
import {
  captureRecoveryProbes,
  closeRecoveryTestCustody,
  recoveryChecks,
  recoveryTestCustody,
} from './g-727-recovery-checks.ts';

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
test('G-727: encrypted small owner cut replays WAL, retains deletion/revocation, rebuilds text and releases only after verification', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const sourceId = `g727-source-${nonce}`;
  const restoredId = `g727-target-${nonce}`;
  const heldId = `g727-held-${nonce}`;
  const source = { profile: 'qa' as const, runId: sourceId, persistent: true };
  const directory = join(root, '.temp', 'ops', `drill-${nonce}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let custody: ReturnType<typeof recoveryTestCustody> | undefined;
  const frontier = join(directory, 'current-frontier.json');
  const set = join(directory, 'set');
  const pools: Pool[] = [];
  try {
    custody = recoveryTestCustody(directory, nonce);
    const { offhost, publicOnly, recipient: fingerprint } = custody;
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
    const phrase = `PREFIX text: <http://jena.apache.org/text#> SELECT ?s WHERE {
      GRAPH <${PUBLIC_SEARCH_GRAPH}> { (?s ?score ?literal) text:query (<${RV}searchBody> "recovery" 10) } } ORDER BY ?s`;
    const probes = await captureRecoveryProbes(
      { apps, pools: { account, access, content, relay }, fuseki },
      {
        work: sample.works[0]!,
        revisionId: sample.content.revisionId,
        actingSubject: sample.content.actingSubject,
        searchQuery: phrase,
      },
    );
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
    // Fail only encryption, after every owner is fenced and copied. Cleanup
    // must preserve the prior frontier, remove the partial output and reopen
    // its own source fences so the exact same command can be retried.
    const priorFrontier = seal(
      {
        version: 1,
        id: 'prior-cut',
        manifestDigest: 'a'.repeat(64),
        capturedAt: new Date().toISOString(),
      },
      key,
      'ops-recovery-frontier',
    );
    writeFileSync(frontier, priorFrontier, { mode: 0o600 });
    const bin = join(directory, 'fail-encrypt-bin');
    mkdirSync(bin, { mode: 0o700 });
    const gpg = Bun.which('gpg');
    if (!gpg) throw new Error('GnuPG is unavailable');
    writeFileSync(
      join(bin, 'gpg'),
      `#!/usr/bin/env bun
if (process.argv.slice(2).includes('--encrypt')) process.exit(73);
const result = Bun.spawnSync([${JSON.stringify(gpg)}, ...process.argv.slice(2)], { stdout: 'inherit', stderr: 'inherit' });
process.exit(result.exitCode);
`,
      { mode: 0o700 },
    );
    await expect(
      backupRecoverySet({
        out: set,
        recipient: fingerprint,
        frontier,
        key,
        source,
        environment: { ...publicOnly, PATH: `${bin}:${process.env.PATH}` },
      }),
    ).rejects.toThrow('gpg recovery step failed');
    await inFlight;
    expect(readFileSync(frontier, 'utf8')).toBe(priorFrontier);
    expect(existsSync(set)).toBe(false);
    expect(
      (await access.query('SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]?.open,
    ).toBe(true);
    const roles = await account.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('account','access','content','relay')",
    );
    expect(roles.rows).toHaveLength(4);
    expect(roles.rows.every((role) => role.rolcanlogin)).toBe(true);
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
    const restored = await restoreRecoverySet({
      set,
      project: `rezics-qa-${restoredId}`,
      frontier,
      key,
      environment: offhost,
      checks: recoveryChecks(probes, key, async (context) => {
        expect(
          (await context.pools.access.query('SELECT body FROM access.g727_inflight WHERE id = 1'))
            .rows[0]?.body,
        ).toBe('committed before cut');
      }),
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
    if (custody) closeRecoveryTestCustody(custody);
    rmSync(directory, { recursive: true, force: true });
  }
}, 600_000);
