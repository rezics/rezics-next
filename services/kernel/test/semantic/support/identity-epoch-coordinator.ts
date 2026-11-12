import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../../../src/route/route.ts';
import {
  cutoverFixture,
  crossHomeLegacy,
  installIdentityEpochPublication,
  ordinaryAdmission,
} from './identity-epoch-cutover.ts';
import { nativeEpochStore, release } from './identity-epoch.ts';
import type { IdentityJobRef } from '../../../src/semantic/identity-epoch-contract.ts';
import { identityJobPartition } from '../../../src/semantic/identity-epoch-store.ts';
import { activeIdentitySourceConsumerMaintenance } from '../../../src/semantic/identity-source-consumer-maintenance.ts';
import supportControl from '../../../src/semantic/identity-epoch-store-select-control.sql';
import { readIdentityMapping } from '../../../src/semantic/identity-adapters/read.ts';
import { resolveSubject } from '../../../src/library/subject-anchor.ts';
import { readSubject } from '../../../src/semantic/subject.ts';

type Admission = Readonly<{
  job: IdentityJobRef;
  redirected: string;
  terminal: string;
  originalBefore: unknown;
}>;

/** Adapts the established native Semantic fixture for the coordinator's frozen API. */
export async function createIdentityCoordinatorFixture(_options: { poolMax: number }) {
  const fixture = await cutoverFixture();
  const store = await nativeEpochStore();
  const pool = fixture.pool as Pool;
  const backendIds = new Set<number>();
  const wrapped = new Map<PoolClient, PoolClient['query']>();
  let worker: Awaited<ReturnType<typeof installIdentityEpochPublication>> | undefined;
  let closing: Promise<void> | undefined;
  let fault: Readonly<{ gate: Promise<void> }> | undefined;
  let markFaultReached: (() => void) | undefined;
  let releaseFault: (() => void) | undefined;
  let faultSeen = false;
  let admission: Admission | undefined;

  const supportControlKey = supportControl.sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
  const observeClient = (client: PoolClient) => {
    const processID = (client as PoolClient & { readonly processID?: unknown }).processID;
    if (typeof processID === 'number') backendIds.add(processID);
    if (wrapped.has(client)) return;
    const query = client.query;
    wrapped.set(client, query);
    client.query = new Proxy(query, {
      apply(target, self, args: unknown[]) {
        const input = args[0];
        const sql = typeof input === 'string' ? input : ((input as { text?: string } | undefined)?.text ?? '');
        const key = sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
        if (
          fault &&
          !faultSeen &&
          key === supportControlKey &&
          activeIdentitySourceConsumerMaintenance(pool) !== null
        ) {
          faultSeen = true;
          markFaultReached?.();
          const currentFault = fault;
          if (!currentFault) throw new Error('Source support failure lost its gate');
          return (async () => {
            await currentFault.gate;
            throw new Error('coordinator fixture: transient Source support read failure');
          })();
        }
        return Reflect.apply(target, self, args);
      },
    }) as PoolClient['query'];
  };
  pool.on('acquire', observeClient);

  async function originalState(original: string, terminal: string) {
    const route = routeOf(original)!;
    const terminalRoute = routeOf(terminal)!;
    const result = await fixture.admin.query(
      `SELECT
         (SELECT to_jsonb(s) FROM semantic.subject s WHERE s.route=$1 AND s.subject_id=$2) AS subject,
         coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.revision) FROM semantic.revision r
           WHERE r.route=$1 AND r.subject_id=$2),'[]'::jsonb) AS revisions,
         coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.sequence) FROM semantic.redirect r
           WHERE r.route=$1 AND r.subject_id=$2),'[]'::jsonb) AS redirects,
         coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.member_id) FROM semantic.merge_member m
           WHERE m.route=$3 AND (m.subject_id=$4 OR m.member_id=$2)),'[]'::jsonb) AS members`,
      [route, original, terminalRoute, terminal],
    );
    return result.rows[0];
  }

  const close = () =>
    (closing ??= (async () => {
      releaseFault?.();
      try {
        await worker?.stop();
      } finally {
        pool.off('acquire', observeClient);
        for (const [client, query] of wrapped) client.query = query;
        await fixture.close();
      }
    })());
  return {
    pool,
    async startCoordinator() {
      worker ??= await installIdentityEpochPublication(fixture);
    },
    async admitRealCrossHomeMergeWithAllRoleFacts(): Promise<Admission> {
      const terminal = (await fixture.create('Coordinator survivor', 0x5f11)).id;
      const redirected = await crossHomeLegacy(fixture, terminal, 0x5f12);
      const originalBefore = await originalState(redirected, terminal);
      const intent = {
        kind: 'merge' as const,
        redirected,
        survivor: terminal,
        release: Buffer.from(release.digest).toString('hex'),
      };
      const admitted = await ordinaryAdmission(fixture, store, intent);
      const result = await admitted.execute();
      admission = { job: result.value, redirected, terminal, originalBefore };
      return admission;
    },
    armTransientSourceSupportFailure() {
      if (fault) throw new Error('Source support failure is already armed');
      let reach!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      markFaultReached = reach;
      releaseFault = release;
      fault = Object.freeze({ gate });
      return Object.freeze({
        reached: reached.then(() => undefined),
        release: () => {
          releaseFault?.();
          fault = undefined;
        },
      });
    },
    sourceSupportFailureSeen() {
      return faultSeen;
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
      const result = await fixture.pool.query(
        'SELECT state FROM semantic.identity_epoch_job WHERE partition_no = $1 AND job_id = $2 AND epoch = $3',
        [identityJobPartition(job), job.jobId, job.epoch.toString()],
      );
      return result.rows[0]?.state === 'published' ? 1 : 0;
    },
    async assertRealCanonicalEffectsAndImmutableOriginals(job: IdentityJobRef) {
      if (!admission || admission.job.jobId !== job.jobId || admission.job.epoch !== job.epoch)
        throw new Error('Canonical outcome must be read for the admitted coordinator job');
      const mapping = await readIdentityMapping(pool, admission.redirected);
      const redirect = await resolveSubject(
        { pool, access: fixture.access },
        await fixture.actor(),
        admission.redirected,
      );
      const canonical = await readSubject(
        pool,
        admission.terminal,
        async () => true,
        undefined,
        new Uint8Array(32).fill(1),
      );
      const originalAfter = await originalState(admission.redirected, admission.terminal);
      return { mapping, redirect, canonical, originalBefore: admission.originalBefore, originalAfter };
    },
    operationBackendIds() {
      return new Set(backendIds);
    },
    close,
  };
}
