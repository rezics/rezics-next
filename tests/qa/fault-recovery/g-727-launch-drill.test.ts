import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
} from '../../../services/main/src/modules/outbox/relay.ts';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { readManifest } from '../../../scripts/fixture/build.ts';
import { workToken, type FixtureProfile } from '../../../scripts/fixture/corpus.ts';
import {
  compatibleFixture,
  type FixtureRestoreEvidence,
} from '../../../scripts/fixture/restore.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { backupRecoverySet } from '../../../scripts/ops/backup.ts';
import { administratorUrl } from '../../../scripts/ops/recovery-set.ts';
import { restoreRecoverySet } from '../../../scripts/ops/restore.ts';
import {
  captureRecoveryProbes,
  closeRecoveryTestCustody,
  recoveryChecks,
  recoveryTestCustody,
} from './g-727-recovery-checks.ts';

function task(name: string, args: string[], timeout = 120_000): void {
  const result = spawnSync('task', [name, '--', ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed; inspect fixture/stack evidence`);
}

// No corpus build and no skip: routine QA restores a retained small fixture;
// the manager supplies a prepared medium copy for the exclusive launch run.
test('G-727: fixture owner restore meets its timed budget and source read/takeout probes', async () => {
  const retainedRecipient = Bun.env.OPS_RECOVERY_RECIPIENT;
  const retainedOffhost = Bun.env.OPS_RECOVERY_OFFHOST_GNUPGHOME;
  const expected = Bun.env.G727_LAUNCH_EXPECTED_WORKS;
  const requestedProfile = Bun.env.G727_LAUNCH_PROFILE;
  if (
    !Bun.env.REZICS_QA_RUN_ID ||
    Boolean(retainedRecipient) !== Boolean(retainedOffhost) ||
    (expected !== undefined && !/^[1-9][0-9]*$/.test(expected)) ||
    (requestedProfile !== undefined && !['small', 'medium'].includes(requestedProfile))
  ) {
    throw new Error(
      'Drill needs paired public/off-host keys when supplied; optional fixture profile is small or medium',
    );
  }
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const preparedSource = Bun.env.G727_LAUNCH_SOURCE_RUN_ID;
  const sourceId = preparedSource ?? `fixture-g727-${nonce}`;
  if (!/^fixture-[a-z0-9-]{1,27}$/.test(sourceId))
    throw new Error('Source must be a task fixture:restore copy with a fixture-* run ID');
  const source = { profile: 'qa' as const, runId: sourceId, persistent: true };
  const targetId = `g727-launch-${nonce}`;
  const set = join(root, '.temp', 'ops', `launch-set-${nonce}`);
  const custodyDirectory = join(root, '.temp', 'ops', `launch-custody-${nonce}`);
  const frontier = Bun.env.OPS_RECOVERY_FRONTIER ?? join(custodyDirectory, 'current-frontier.json');
  const key = Bun.env.RECOVERY_MANIFEST_HMAC_KEY ?? randomBytes(32).toString('hex');
  let custody: ReturnType<typeof recoveryTestCustody> | undefined;
  const pools: Pool[] = [];
  try {
    if (!preparedSource) {
      const profile = (requestedProfile ?? 'small') as FixtureProfile;
      const fixture = Bun.env.G727_LAUNCH_FIXTURE ?? compatibleFixture(profile)?.id;
      const manifest = fixture ? readManifest(fixture) : undefined;
      if (!manifest || manifest.profile !== profile)
        throw new Error(
          `Prepare a compatible ${profile} backup with task fixture:build -- --profile ${profile}`,
        );
      // Preparation is outside the backup/restore timers. Never rebuild or write
      // to the retained fixture; only fixture:restore creates the writable copy.
      task('fixture:restore', ['--fixture', manifest.id, '--run-id', sourceId], 600_000);
    }
    const preparation = JSON.parse(
      readFileSync(join(root, '.artifacts', 'fixture-restore', sourceId, 'run.json'), 'utf8'),
    ) as FixtureRestoreEvidence;
    const manifest = readManifest(preparation.fixture);
    if (
      preparation.failure ||
      preparation.target !== sourceId ||
      !preparation.completedAt ||
      !manifest ||
      preparation.works !== manifest.entities.works ||
      (requestedProfile && preparation.profile !== requestedProfile)
    )
      throw new Error('Source lacks successful matching fixture:restore evidence');
    const expectedWorks = expected ?? String(manifest.entities.works);
    expect(String(preparation.works)).toBe(expectedWorks);
    const sample = manifest.samples[0];
    if (!sample) throw new Error('Fixture has no exact read sample');
    const sourceDirectory = stackDirectory(root, source);
    const apps = readEnv(join(sourceDirectory, 'apps.env'));
    const saved = readEnv(join(sourceDirectory, 'compose.env'));
    const owner = (name: string) => {
      const pool = new Pool({ connectionString: administratorUrl(saved, name), max: 4 });
      pool.on('error', () => {});
      pools.push(pool);
      return pool;
    };
    const owners = {
      account: owner('account'),
      access: owner('access'),
      content: owner('content'),
      relay: owner('relay'),
    };
    const fuseki = new FusekiClient(
      apps.FUSEKI_URL!,
      apps.FUSEKI_MAINTENANCE_TOKEN,
      apps.FUSEKI_COMMAND_TOKEN,
    );
    const count =
      await fuseki.query(`SELECT (COUNT(?work) AS ?n) WHERE { GRAPH <${GRAPHS.current}> {
      ?work a <https://schema.org/CreativeWork> } }`);
    expect(count.results?.bindings[0]?.n?.value).toBe(expectedWorks);
    await initializeRelayCheckpoint(owners.relay, apps.MAIN_RELAY_CONSUMER!, apps.MAIN_DATA_EPOCH!);
    while (await relayMainOutboxOnce(fuseki, owners.relay, apps.MAIN_RELAY_CONSUMER!)) {
      /* drain handoff */
    }
    const probes = await captureRecoveryProbes(
      { apps, pools: owners, fuseki },
      {
        work: sample.work,
        revisionId: sample.contentRevision,
        actingSubject: sample.agent,
        searchQuery: `PREFIX text: <http://jena.apache.org/text#> SELECT ?s WHERE {
        GRAPH <${GRAPHS.current}> { (?s ?score ?literal) text:query
        (<http://www.w3.org/2000/01/rdf-schema#label> "${workToken(sample.index)}" 10) } } ORDER BY ?s`,
      },
    );
    if (!retainedRecipient) custody = recoveryTestCustody(custodyDirectory, nonce);
    const backup = await backupRecoverySet({
      out: set,
      recipient: retainedRecipient ?? custody!.recipient,
      frontier,
      key,
      source,
      environment: custody?.publicOnly,
    });
    const backupEvidence = JSON.parse(readFileSync(join(set, 'backup-evidence.json'), 'utf8'));
    expect(backupEvidence.elapsedMs).toBeLessThanOrEqual(600_000);
    const restored = await restoreRecoverySet({
      set,
      project: `rezics-qa-${targetId}`,
      frontier,
      key,
      checks: recoveryChecks(probes, key),
      environment: custody?.offhost ?? { ...process.env, GNUPGHOME: retainedOffhost },
    });
    expect(restored.state).toBe('verified');
    expect(restored.elapsedMs).toBeLessThanOrEqual(600_000);
    writeFileSync(
      join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'g-727-launch-restore.json'),
      JSON.stringify(
        {
          expectedWorks,
          sourceFixture: manifest.id,
          preparation,
          set,
          backup,
          backupEvidence,
          restored,
          targetEvidence: JSON.parse(
            readFileSync(
              join(
                stackDirectory(root, { profile: 'qa', runId: targetId, persistent: true }),
                'recovery-evidence.json',
              ),
              'utf8',
            ),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    try {
      task('stack:reset', ['--profile', 'qa', '--run-id', targetId, '--persistent']);
    } finally {
      try {
        if (!preparedSource)
          task('stack:reset', ['--profile', 'qa', '--run-id', sourceId, '--persistent']);
      } finally {
        if (custody) {
          closeRecoveryTestCustody(custody);
          rmSync(custodyDirectory, { recursive: true, force: true });
          rmSync(set, { recursive: true, force: true });
        }
      }
    }
  }
}, 1_260_000);
