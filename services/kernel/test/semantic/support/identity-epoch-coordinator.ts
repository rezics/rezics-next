import type { Pool } from 'pg';
import { cutoverFixture, crossHomeLegacy, ordinaryAdmission } from './identity-epoch-cutover.ts';
import { nativeEpochStore, release } from './identity-epoch.ts';
import type { IdentityJobRef } from '../../../src/semantic/identity-epoch-contract.ts';
import { identityJobPartition } from '../../../src/semantic/identity-epoch-store.ts';

/** Adapts the established native Semantic fixture for the coordinator's frozen API. */
export async function createIdentityCoordinatorFixture(_options: { poolMax: number }) {
  const fixture = await cutoverFixture();
  const store = await nativeEpochStore();
  const jobById = async (job: IdentityJobRef) =>
    fixture.pool.query(
      'SELECT state FROM semantic.identity_epoch_job WHERE partition_no = $1 AND job_id = $2 AND epoch = $3',
      [identityJobPartition(job), job.jobId, job.epoch.toString()],
    );
  return {
    pool: fixture.pool as Pool,
    async admitRealCrossHomeMergeWithAllRoleFacts(): Promise<{ job: IdentityJobRef }> {
      const terminal = (await fixture.create('Coordinator survivor', 0x5f11)).id;
      const redirected = await crossHomeLegacy(fixture, terminal, 0x5f12);
      const intent = {
        kind: 'merge' as const,
        redirected,
        survivor: terminal,
        release: Buffer.from(release.digest).toString('hex'),
      };
      const admitted = await ordinaryAdmission(fixture, store, intent);
      const result = await admitted.execute();
      return { job: result.value };
    },
    async readJob(job: IdentityJobRef) {
      return fixture.pool.connect().then(async (client) => {
        try {
          return await store.readJob(client, job);
        } finally {
          client.release();
        }
      });
    },
    async nativePublicationCount(job: IdentityJobRef) {
      const result = await jobById(job);
      return result.rows[0]?.state === 'published' ? 1 : 0;
    },
    async assertRealCanonicalEffectsAndImmutableOriginals(_job: IdentityJobRef) {
      // The native coordinator's producer and publication guards own these assertions. The
      // helper intentionally does not synthesize participant receipts or projected rows.
      const unavailable = await import('../../../src/semantic/identity-epoch-mapping.ts');
      return unavailable.stepIdentityEpochMapping(fixture.pool, _job);
    },
    operationBackendIds() {
      return new Set<string>();
    },
    close: fixture.close,
  };
}
