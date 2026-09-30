import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { backupRecoverySet } from '../../../scripts/ops/backup.ts';
import { deploymentRestoreChecks, restoreRecoverySet } from '../../../scripts/ops/restore.ts';

// This drill consumes a manager-prepared, receipt-complete launch stack. It
// never builds a corpus or silently substitutes the small command fixture.
const sourceId = Bun.env.G727_LAUNCH_SOURCE_RUN_ID;
test.skipIf(!sourceId)(
  'G-727: launch-count owner restore meets its timed budget and deployment read/takeout probes',
  async () => {
    const expected = Bun.env.G727_LAUNCH_EXPECTED_WORKS;
    const recipient = Bun.env.OPS_RECOVERY_RECIPIENT;
    const frontier = Bun.env.OPS_RECOVERY_FRONTIER;
    const key = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
    const offhost = Bun.env.OPS_RECOVERY_OFFHOST_GNUPGHOME;
    const checks = deploymentRestoreChecks();
    if (
      !Bun.env.REZICS_QA_RUN_ID ||
      !sourceId ||
      !/^[a-z0-9][a-z0-9-]{0,30}$/.test(sourceId) ||
      !/^[1-9][0-9]*$/.test(expected ?? '') ||
      !recipient ||
      !frontier ||
      !key ||
      !offhost ||
      !checks
    ) {
      throw new Error(
        'Launch drill needs recorded counts, a prepared isolated source, independent custody, public/off-host keys and deployment read/takeout checks',
      );
    }
    const source = { profile: 'qa' as const, runId: sourceId, persistent: true };
    const apps = readEnv(join(stackDirectory(root, source), 'apps.env'));
    const fuseki = new FusekiClient(
      apps.FUSEKI_URL!,
      apps.FUSEKI_MAINTENANCE_TOKEN,
      apps.FUSEKI_COMMAND_TOKEN,
    );
    const count =
      await fuseki.query(`SELECT (COUNT(?work) AS ?n) WHERE { GRAPH <${GRAPHS.current}> {
    ?work a <https://schema.org/CreativeWork> } }`);
    expect(count.results?.bindings[0]?.n?.value).toBe(expected!);
    const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
    const targetId = `g727-launch-${nonce}`;
    const set = join(root, '.temp', 'ops', `launch-set-${nonce}`);
    try {
      const backup = await backupRecoverySet({ out: set, recipient, frontier, key, source });
      const restored = await restoreRecoverySet({
        set,
        project: `rezics-qa-${targetId}`,
        frontier,
        key,
        checks,
        environment: { ...process.env, GNUPGHOME: offhost },
      });
      expect(restored.state).toBe('verified');
      expect(restored.elapsedMs).toBeLessThanOrEqual(600_000);
      writeFileSync(
        join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'g-727-launch-restore.json'),
        JSON.stringify(
          {
            expectedWorks: expected,
            set,
            backup,
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
      const result = spawnSync(
        'bun',
        [
          'scripts/dev/cli.ts',
          'stack:reset',
          '--profile',
          'qa',
          '--run-id',
          targetId,
          '--persistent',
        ],
        { cwd: root, encoding: 'utf8', timeout: 120_000 },
      );
      if (result.error || result.status !== 0)
        throw new Error('Launch drill target cleanup failed');
    }
  },
  1_260_000,
);
