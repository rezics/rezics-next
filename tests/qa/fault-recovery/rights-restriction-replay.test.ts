import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { copyRecoveryTree } from '../support/recovery-copy.ts';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { GovernanceStore, type DecisionInput, type ReportInput } from '../../../services/main/src/modules/governance/store.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
  return result.stdout.trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no fixture port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function migrateAccess(pool: Pool): Promise<void> {
  const directory = join(root, 'services/main/migrations/access');
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('GOV25: replaying an Access backup preserves its restriction fence through counter-notice and decision replay', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  const state = join(root, '.temp', `rights-restriction-replay-${randomUUID()}`);
  const socketDirectory = join(root, '.temp', 's');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const pools: Pool[] = [];
  let restoredData: string | undefined;
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const stack = stackDirectory(root, { profile: 'qa', runId });
    const apps = readEnv(join(stack, 'apps.env'));
    const compose = readEnv(join(stack, 'compose.env'));
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    pools.push(access);
    await migrateAccess(access);
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);

    const issuer = 'https://account.example.test';
    const subject = randomUUID();
    const principalId = randomUUID();
    const actingSubject = agent();
    const scope = `governance:platform:rights-replay-${randomUUID()}`;
    const resource = agent();
    const revision = agent();
    const principal = { issuer, subject };
    await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, issuer, subject]);
    await access.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actingSubject]);
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'governance.rights.decide', now() + interval '1 hour')`,
    [randomUUID(), principalId, actingSubject]);
    for (const action of ['governance.rights.decide', 'governance.appeal']) {
      await access.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject,
        scope_id, action, valid_until) VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), actingSubject, scope, action]);
    }

    const rule = { ref: 'urn:rezics:rule:source-rights', revision: 'v1', digest: digest('gov25-rule-v1') };
    const storeFor = (pool: Pool) => new GovernanceStore(pool, { capture: async (_principal, _actor, target) => ({
      ...target, state: 'available', representation: 'source-observation-v1',
      revisionDigest: digest('gov25-observation'), provenance: { test: 'GOV25-backup-replay' },
    }) }, { current: async () => null }, { current: async ref => ref === rule.ref ? rule : null });
    const store = storeFor(access);
    const reportInput: ReportInput = { kind: 'rights_complaint', actingSubject,
      authority: { kind: 'platform', scopeId: scope }, context: 'urn:rezics:context:global',
      target: { owner: 'source', resource, component: 'synopsis' }, disclosure: 'parties',
      reasonCode: 'claimed_synopsis', statement: 'Reported source synopsis.',
      evidence: [{ owner: 'source', resource, component: 'synopsis', revision, locator: null }],
      idempotencyKey: 'gov25-report', complaint: { process: 'dmca_512', claimantKind: 'rights_holder',
        claimantName: 'Fixture claimant', claimantContact: null, claimedWork: 'Reported synopsis',
        claimedRight: 'copyright', noticeDigest: digest('gov25-notice'), noticeReceivedAt: new Date().toISOString() } };
    const report = await store.submitReport(principal, reportInput);
    const targets: DecisionInput['targets'] = [{ owner: 'source', resource, component: 'synopsis', locator: null,
      scopeKind: 'component', revision: null, expectedHead: null, effect: 'export' }];
    const decisionInput: DecisionInput = { caseId: report.caseId, expectedGeneration: '0', actingSubject,
      outcome: 'interim_restrict', targets, rule, evidenceDigest: report.evidenceDigest,
      reversesDecisionId: null, answersStepId: null, rationale: 'Pending rights process.',
      disclosure: 'parties', idempotencyKey: 'gov25-restriction' };
    const restriction = await store.decide(principal, decisionInput);
    expect(restriction.enforcement).toEqual([expect.objectContaining({ state: 'restricted', fenceEpoch: '1',
      effect: 'export', revision: null })]);
    const target = { owner: 'source' as const, resource, component: 'synopsis' as const };
    const restrictedFence = await store.readEnforcement(target);
    expect(restrictedFence).toEqual([expect.objectContaining({ state: 'restricted', fenceEpoch: '1',
      decisionId: restriction.decisionId })]);
    const counter = await store.recordStep(principal, { caseId: report.caseId,
      decisionId: restriction.decisionId, actingSubject, process: 'dmca_512', step: 'counter_notice',
      partySubject: actingSubject, statement: 'Counter-notice recorded before backup.',
      documentDigest: digest('gov25-counter-notice'), occurredAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: 'gov25-counter-notice' });
    expect(counter.replayed).toBe(false);
    expect(await store.readEnforcement(target)).toEqual(restrictedFence);
    const decisionReplay = await store.decide(principal, decisionInput);
    expect(decisionReplay).toMatchObject({ decisionId: restriction.decisionId, replayed: true,
      enforcement: [expect.objectContaining({ state: 'restricted', fenceEpoch: '1' })] });

    await engageAccessRecoveryFence(access);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: (BigInt(lineage.routingEpoch) + 1n).toString() };
    await cutoverRestoredGraphLineage(fuseki, { prior: { ...lineage, sequence: '0' }, next: nextLineage });
    const backup = rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', backup], { cwd: state, timeout: 15_000 });
    restoredData = join(state, 'restored');
    copyRecoveryTree(backup, restoredData);
    appendFileSync(join(restoredData, 'postgresql.auto.conf'), "\narchive_mode = off\nrestore_command = 'false'\n");
    writeFileSync(join(restoredData, 'recovery.signal'), '');
    const replayPort = await freePort();
    execFileSync('pg_ctl', ['-D', restoredData, '-l', join(state, 'restored.log'),
      '-o', `-h 127.0.0.1 -p ${replayPort} -k ${socketDirectory}`, '-t', '60', '-w', 'start'],
    { cwd: state, timeout: 65_000 });
    const restored = new Pool({ host: '127.0.0.1', port: replayPort, database: 'access',
      user: 'postgres', password: compose.POSTGRES_PASSWORD! });
    pools.push(restored);
    let recovering = true;
    for (let attempt = 0; attempt < 100 && recovering; attempt += 1) {
      recovering = (await restored.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
      if (recovering) await Bun.sleep(100);
    }
    expect(recovering).toBe(false);

    const restoredFence = await restored.query<{ context: string; authority_scope_id: string;
      revision: string | null; effect: string; state: string; fence_epoch: string; decision_id: string }>(`SELECT
      e.context, e.authority_scope_id, e.revision, e.effect, e.state, e.fence_epoch::text, e.decision_id::text
      FROM access.governance_enforcement e WHERE e.owner = 'source' AND e.resource = $1
        AND e.component = 'synopsis'`, [resource]);
    expect(restoredFence.rows).toEqual([{ context: 'urn:rezics:context:global', authority_scope_id: scope,
      revision: null, effect: 'export', state: 'restricted', fence_epoch: '1',
      decision_id: restriction.decisionId }]);
    expect((await restored.query<{ outcome: string }>(`SELECT outcome FROM access.moderation_decision
      WHERE case_id = $1 ORDER BY case_sequence`, [report.caseId])).rows).toEqual([{ outcome: 'interim_restrict' }]);
    expect((await restored.query<{ step: string }>(`SELECT step FROM access.governance_process_step
      WHERE case_id = $1`, [report.caseId])).rows).toEqual([{ step: 'counter_notice' }]);
    const outbox = await restored.query<{ kind: string; moderation_decision_id: string }>(`SELECT kind,
      moderation_decision_id FROM access.outbox WHERE moderation_decision_id = $1`, [restriction.decisionId]);
    expect(outbox.rows).toEqual([{ kind: 'moderation.decided', moderation_decision_id: restriction.decisionId }]);

  } finally {
    await Promise.allSettled(pools.map(pool => pool.end()));
    if (restoredData && spawnSync('pg_ctl', ['-D', restoredData, 'status'],
      { cwd: state, timeout: 5_000 }).status === 0) {
      execFileSync('pg_ctl', ['-D', restoredData, '-m', 'immediate', '-t', '10', '-w', 'stop'],
        { cwd: state, timeout: 15_000 });
    }
    try { if (started) rootCommand(['stack:reset', ...stackArgs], 120_000); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 420_000);
