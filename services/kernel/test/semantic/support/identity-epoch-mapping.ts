import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { runCommand } from '../../../src/command/command.ts';
import { withConnection } from '../../../src/database/pool.ts';
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
import { digest, epochFixture, identityEpochDatabase, nativeMappingStep, release } from './identity-epoch.ts';

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
        for (const partition of new Set(ids.map((id) => routeOf(id)! >> 4))) {
          let caughtUp = false;
          for (let page = 0; page < 1000; page++) {
            const progress = await stepIdentityEpochBootstrap(f.pool, partition);
            if (progress.state === 'caught-up') {
              caughtUp = true;
              break;
            }
          }
          if (!caughtUp) throw new Error('Native fixture bootstrap did not finish its finite source home');
        }
      },
      async admitMerge() {
        const redirected = (await f.create('Mapping original', 0x7310)).subject.id;
        const survivor = (await f.create('Mapping survivor', 0x7320)).subject.id;
        const job = await admit({ kind: 'merge', redirected, survivor, release: release.digest });
        return { job, survivor, redirectedOriginals: [redirected] };
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
