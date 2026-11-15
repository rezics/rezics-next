import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { loadAccountIdentitySource } from '../../../src/access/agent-verification-identity.ts';
import { runCommand } from '../../../src/command/command.ts';
import { withConnection } from '../../../src/database/pool.ts';
import { accountAgentId } from '../../../src/semantic/agents.ts';
import { ensureAccountAgent } from '../../../src/semantic/account-agents.ts';
import { stepIdentityEpochAdmission } from '../../../src/semantic/identity-epoch-admission.ts';
import { stepIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap.ts';
import { installIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap-install.ts';
import { identityEpochStore, identityJobPartition } from '../../../src/semantic/identity-epoch-store.ts';
import type {
  IdentityIntent,
  IdentityJobRef,
  IdentityStepProgress,
} from '../../../src/semantic/identity-epoch-contract.ts';
import { routeOf } from '../../../src/route/route.ts';
import { digest, epochFixture, home, identityEpochDatabase, nativeMappingStep, release } from './identity-epoch.ts';
import { approvedVerification } from './identity-epoch-cutover.ts';
import { appendEdge, type Deployment } from './identity-terminal-closure.ts';

/** All production operations share the guarded native pool; admin only observes source rows. */
export async function createIdentityMappingFixture(options: { poolMax: number; pool?: Pool; url?: string }) {
  const isolated = options.pool === undefined && options.url === undefined ? await identityEpochDatabase() : null;
  try {
    const f = await epochFixture(isolated?.url ?? options.url, {
      ...(options.pool === undefined && isolated === null ? {} : { pool: options.pool ?? isolated!.pool }),
      poolMax: options.poolMax,
    });
    try {
      await installIdentityEpochBootstrap(f.pool);
    } catch (error) {
      await f.close();
      throw error;
    }
    const url = isolated?.url ?? options.url ?? process.env.DATABASE_URL!;
    const terminalWriter = { url } as Deployment;
    const backends = new Set<number>();
    f.pool.on('acquire', (client) => {
      const backend = (client as unknown as { processID: number }).processID;
      backends.add(backend);
    });
    async function prepare(intent: IdentityIntent) {
      const actor = await f.actor();
      const key = randomUUID();
      return identityEpochStore().prepareAdmission(
        f.pool,
        {
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
          authorization: await f.authorization('subject:merge'),
        },
        {
          intent,
          receipt: {
            kind: 'subject.merge',
            command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
          },
        },
      );
    }
    async function admit(intent: IdentityIntent) {
      const job = await prepare(intent);
      for (let attempt = 0; attempt < 16; attempt++) {
        const progress = await stepIdentityEpochAdmission(f.pool, job);
        if (progress.state === 'pending') return job;
        expect(progress.state).toBe('preparing');
      }
      throw new Error('Native admission did not finish within sixteen bounded steps');
    }
    return {
      ...f,
      admit,
      prepare,
      async bootstrapHomes(ids: readonly string[]) {
        const homes = [...new Set([...ids].reverse().map((id) => home(id)))];
        for (let page = 0; page < 1000; page++) {
          let pending = false;
          for (const partition of homes) {
            const progress = await stepIdentityEpochBootstrap(f.pool, partition);
            if (progress.state !== 'caught-up') pending = true;
          }
          if (!pending) return;
        }
        throw new Error('Native fixture bootstrap did not finish its finite source home');
      },
      async admitMerge() {
        const redirected = (await f.create('Mapping original', 0x7310)).subject.id;
        const survivor = (await f.create('Mapping survivor', 0x7320)).subject.id;
        const job = await admit({ kind: 'merge', redirected, survivor, release: release.digest });
        return { job, survivor, redirectedOriginals: [redirected] };
      },
      /** Admission only: mapping drain proves the Accounts job without Search/Library resume.
       * Native appendEdge enrolls the Access merge original (the account agent) under foreign control 0x9e10; ordinary bootstrap then ACKs. */
      async admitAccountAgentVerify() {
        const catalogue = (await f.create('Accounts mapping catalogue', 0x9d10)).subject.id;
        const control = (await f.create('Accounts mapping control', 0x9e10)).subject.id;
        const approved = await approvedVerification(f, catalogue);
        const agent = await ensureAccountAgent(f.pool, {
          account: approved.account,
          kind: 'person',
          name: 'Accounts mapping agent',
        });
        const redirected = agent.subject.id;
        if (redirected !== accountAgentId(approved.account))
          throw new Error('Accounts mapping agent must retain its derived native original');
        if (home(redirected) === home(control))
          throw new Error('Accounts mapping control must occupy a distinct native home from the admitted original');
        await appendEdge(terminalWriter, control, control);
        await appendEdge(terminalWriter, redirected, control);
        await this.bootstrapHomes([catalogue, control, redirected]);
        const receipt = {
          kind: 'account-agent.verify' as const,
          account: approved.account,
          receipt: approved.workflow.receiptId,
        };
        const source = await loadAccountIdentitySource(f.pool, receipt);
        if (source.input.intent.kind !== 'merge' || source.input.intent.redirected !== redirected)
          throw new Error('Accounts mapping original must be the native account agent');
        const job = await identityEpochStore().prepareAdmission(f.pool, {}, source.input);
        for (let attempt = 0; attempt < 16; attempt++) {
          const progress = await stepIdentityEpochAdmission(f.pool, job);
          if (progress.state === 'pending')
            return { job, catalogue, control, account: approved.account, agent: redirected, receipt, source };
          expect(progress.state).toBe('preparing');
        }
        throw new Error('Native Accounts admission did not finish within sixteen bounded steps');
      },

      async drainMapping(job: IdentityJobRef, bound: number) {
        const step = await nativeMappingStep();
        const progress: IdentityStepProgress[] = [];
        for (let attempt = 0; attempt < bound; attempt++) {
          const result = await step(f.pool, job);
          progress.push(result);
          if (result.state === 'complete') return progress;
          if (attempt > 0) expect(result.frontier).not.toEqual(progress[attempt - 1]!.frontier);
        }
        throw new Error(`Native mapping did not finish within ${bound} bounded steps`);
      },
      nativeDirectRedirect: async (original: string) =>
        (
          await f.admin.query(
            'SELECT target::text FROM semantic.redirect WHERE route=$1 AND subject_id=$2 ORDER BY sequence DESC LIMIT 1',
            [routeOf(original)!, original],
          )
        ).rows[0]?.target ?? null,
      async nativeSource(original: string) {
        const row = (
          await f.admin.query<{
            closure_state: string;
            control_partition: number;
            control_group: string;
            source_home: number;
            terminal: string;
            registration: string | null;
            install: string | null;
            ack: string | null;
            original_installed: boolean;
          }>(
            `SELECT m.closure_state, m.control_partition, m.control_group::text AS control_group,
                    m.route/16 AS source_home, m.terminal::text,
                    m.closure_registration_transaction::text AS registration,
                    m.closure_install_transaction::text AS install,
                    m.closure_ack_transaction::text AS ack,
                    EXISTS(
                      SELECT 1 FROM semantic.identity_epoch_original o
                      WHERE o.partition_no=m.control_partition AND o.original=m.original AND o.present
                        AND o.closure_state='installed'
                    ) AS original_installed
             FROM semantic.identity_epoch_mapping m WHERE m.original=$1`,
            [original],
          )
        ).rows[0];
        if (!row) throw new Error('Native mapping source row is missing');
        const commits = (
          await f.admin.query<{ kind: string }>(
            `SELECT kind FROM (
               SELECT 'registration' AS kind FROM semantic.identity_epoch_native_commit
                WHERE partition_no=$1 AND transaction_id=$2::uuid AND purpose='bootstrap'
               UNION ALL
               SELECT 'install' FROM semantic.identity_epoch_native_commit
                WHERE partition_no=$3 AND transaction_id=$4::uuid AND purpose='bootstrap'
               UNION ALL
               SELECT 'ack' FROM semantic.identity_epoch_native_commit
                WHERE partition_no=$3 AND transaction_id=$5::uuid AND purpose='bootstrap'
             ) c`,
            [row.control_partition, row.registration, row.source_home, row.install, row.ack],
          )
        ).rows.map((entry) => entry.kind);
        return { ...row, commits };
      },
      async nativeAdmissionPins(job: IdentityJobRef, partition: number) {
        const row = (
          await f.admin.query<{ attempt: string; prepared: string | null; acquired: string | null }>(
            `SELECT a.state AS attempt, prepared.stage AS prepared, acquired.stage AS acquired
             FROM semantic.identity_epoch_admission_attempt a
             LEFT JOIN semantic.identity_epoch_admission_receipt prepared
               ON prepared.partition_no=a.partition_no AND prepared.job_id=a.job_id
              AND prepared.job_epoch=a.job_epoch AND prepared.scope_digest=a.scope_digest
              AND prepared.stage='prepared' AND prepared.version=1
             LEFT JOIN semantic.identity_epoch_admission_receipt acquired
               ON acquired.partition_no=a.partition_no AND acquired.job_id=a.job_id
              AND acquired.job_epoch=a.job_epoch AND acquired.scope_digest=a.scope_digest
              AND acquired.stage='acquired' AND acquired.version=1
             WHERE a.partition_no=$1 AND a.job_id=$2 AND a.job_epoch=$3`,
            [partition, job.jobId, job.epoch.toString()],
          )
        ).rows[0];
        if (!row) throw new Error('Native admission pins are missing');
        return row;
      },
      async closeAcquiredPin(job: IdentityJobRef, partition: number) {
        const closed = await f.admin.query(
          `UPDATE semantic.identity_epoch_admission_attempt SET state='closed'
           WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND state='acquired'
           RETURNING partition_no`,
          [partition, job.jobId, job.epoch.toString()],
        );
        expect(closed.rowCount).toBe(1);
      },
      readJob: (job: IdentityJobRef) => withConnection(f.pool, (tx) => identityEpochStore().readJob(tx, job)),
      publish: (job: IdentityJobRef) =>
        runCommand(f.pool, { partition: identityJobPartition(job) }, (tx) => identityEpochStore().publish(tx, job)),
      operationBackendIds: () => new Set(backends),
      async nativeRows(job: IdentityJobRef) {
        const home = identityJobPartition(job);
        const head = (
          await f.admin.query(
            'SELECT * FROM semantic.identity_epoch_mapping_head WHERE partition_no=$1 AND job_id=$2',
            [home, job.jobId],
          )
        ).rows[0];
        const custody = (
          await f.admin.query(
            `SELECT * FROM semantic.identity_epoch_effect_receipt WHERE partition_no=$1 AND job_id=$2 ORDER BY effect_key`,
            [home, job.jobId],
          )
        ).rows;
        const effects = (
          await f.admin.query(
            `SELECT e.*,c.epoch,c.position,c.purpose,(c.xmin=e.xmin) same_transaction FROM semantic.identity_epoch_mapping_effect e
        JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id)
        WHERE e.job_id=$1 ORDER BY e.unit`,
            [job.jobId],
          )
        ).rows;
        return { head, custody, effects };
      },
      async close() {
        await f.close();
        await isolated?.close();
      },
    };
  } catch (error) {
    await isolated?.close();
    throw error;
  }
}
