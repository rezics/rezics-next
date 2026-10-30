import type { Pool } from 'pg';
import type { PublicFilterSourceFactory } from '../semantic/public-filter-source-contract.ts';
import { createPublicIdentitySourceCapture } from '../semantic/identity-scoped-public-source.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import { createNativeLibrarySourceCustody } from '../library/native-source-custody.ts';
import { readRelease } from '../semantic/definitions.ts';
import type { IdentityScopeRegistration, IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { createScopePreparationStore, type ScopePreparationRecord } from './scope-preparation-store.ts';
import { ScopeWork, scopeAllowance, zeroScopeWork } from './scope-execution.ts';
import { sameScopeObservation } from './service-scope-order.ts';

/** One bounded structural step under the existing Search WorkModule. No native receiving receipts
 * are constructed here. Expiry stops scheduling but retains unknown native custody for its owner.
 */
export function createScopePreparation(config: Parameters<PublicFilterSourceFactory>[0] & { prefix: string }) {
  const store = createScopePreparationStore(config.pool, config.prefix);
  const observations = createIdentityScopedObservations(config.pool);
  const publicCapture = createPublicIdentitySourceCapture(config);
  const library = createNativeLibrarySourceCustody({ pool: config.pool, clock: config.clock });
  async function step(record: ScopePreparationRecord, deadline: number, work: ScopeWork): Promise<void> {
    async function advance(
      frontier: ScopePreparationRecord['frontier'],
      observation: IdentityScopeObservation | null,
      delay: number,
    ) {
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 20000 });
      return store.advance(record, frontier, observation, delay);
    }
    if (Number(record.expires_at) <= Date.now()) return advance(record.frontier, null, 0);
    let registration: IdentityScopeRegistration;
    let capturedFrontier = record.frontier;
    const definition = record.definition;
    if (definition.kind === 'library') {
      if (record.frontier.kind !== 'library') throw new TypeError('Scope frontier kind changed');
      let frontier = record.frontier.value;
      if (frontier?.driver !== 'done') {
        const page = await library.capturePage({
          identity: definition.identity,
          frontier,
          limit: 100,
          allowance: work.remaining(),
          deadline,
        });
        work.native(page.work);
        if (page.status !== 'pending') return advance(record.frontier, null, 1000);
        frontier = page.frontier;
        // Persist native raw progress before another step. Input count is not completeness.
        if (frontier.driver !== 'done') return advance({ kind: 'library', value: frontier }, null, 0);
      }
      capturedFrontier = { kind: 'library', value: frontier };
      const complete = await library.finishCapture({
        identity: definition.identity,
        frontier,
        allowance: work.remaining(),
        deadline,
      });
      work.native(complete.work);
      if (complete.status !== 'complete') return advance(capturedFrontier, null, 1000);
      registration = {
        key: { source: { kind: 'library', identity: definition.identity }, scopeId: record.scope_id },
        capture: { kind: 'library', capture: complete.capture, frontier, allowance: work.remaining() },
        deadline,
      };
    } else {
      if (record.frontier.kind !== 'public') throw new TypeError('Scope frontier kind changed');
      work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
      const release = await readRelease(config.pool, definition.definition.meaning.digest);
      if (!release) return advance(record.frontier, null, 1000);
      const native = { ...definition.definition, meaning: { ...definition.definition.meaning, release } };
      const page = await publicCapture.capturePage({
        definition: native,
        frontier: record.frontier.value,
        inputLimit: 100,
        context: { deadline },
      });
      work.public(page.cost);
      if (page.status === 'progress') return advance({ kind: 'public', value: page.frontier }, null, 0);
      if (page.status !== 'complete') return advance(record.frontier, null, 1000);
      registration = {
        key: { source: { kind: 'public', identity: native.source }, scopeId: record.scope_id },
        capture: { kind: 'public', capture: page.capture },
        deadline,
      };
    }
    const registered = await observations.register(registration);
    work.identity(registered.work);
    if (registered.status !== 'registered') return advance(capturedFrontier, null, 1000);
    // Registration is not readiness. This actual full observation must remain current through settlement.
    const first = await observations.revalidate({
      key: registered.observation.key,
      expected: registered.observation,
      deadline,
    });
    work.identity(first.work);
    if (first.status !== 'current' || !sameScopeObservation(first.observation, registered.observation))
      return advance(capturedFrontier, null, 1000);
    const final = await observations.revalidate({ key: first.observation.key, expected: first.observation, deadline });
    work.identity(final.work);
    await advance(
      capturedFrontier,
      final.status === 'current' && sameScopeObservation(final.observation, first.observation)
        ? final.observation
        : null,
      1000,
    );
  }
  return {
    async prepare(scopeId: string, deadline: number, work: ScopeWork): Promise<void> {
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 282624 });
      const prior = await store.read(scopeId);
      if (!prior || prior.state === 'retained') return;
      if (prior.state === 'ready') {
        if (!prior.observation) return;
        const expected = { ...prior.observation, committedRevision: BigInt(prior.observation.committedRevision) };
        const current = await observations.revalidate({ key: expected.key, expected, deadline });
        work.identity(current.work);
        if (current.status === 'current' && sameScopeObservation(current.observation, expected)) return;
        const repaired = await observations.repair({ key: expected.key, limit: 100, deadline });
        work.identity(repaired.work);
        if (
          repaired.status !== 'repaired' ||
          !repaired.observation ||
          repaired.observation.key.scopeId !== scopeId ||
          !sameScopeObservation(
            {
              ...expected,
              captureId: repaired.observation.captureId,
              committedRevision: repaired.observation.committedRevision,
            },
            repaired.observation,
          )
        )
          return;
        const final = await observations.revalidate({ key: expected.key, expected: repaired.observation, deadline });
        work.identity(final.work);
        if (final.status === 'current' && sameScopeObservation(final.observation, repaired.observation)) {
          work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 8192 });
          await store.refreshObservation(prior, final.observation);
        }
        return;
      }
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 282624 });
      const record = await store.claim(scopeId, prior.revision, deadline);
      if (record) await step(record, deadline, work);
    },
    async run(scopeId: string, revision: string): Promise<void> {
      const deadline = Date.now() + 30000;
      const work = new ScopeWork(scopeAllowance(256, scopeId));
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 282624 });
      const record = await store.claim(scopeId, revision, deadline);
      if (record) await step(record, deadline, work);
    },
  };
}

export async function readPreparedScopeObservation(
  pool: Pool,
  prefix: string,
  scopeId: string,
): Promise<IdentityScopeObservation | null> {
  const record = await createScopePreparationStore(pool, prefix).read(scopeId);
  if (!record || record.state !== 'ready' || !record.observation || Number(record.expires_at) <= Date.now())
    return null;
  const observation = record.observation;
  if (!/^(0|[1-9][0-9]*)$/.test(observation.committedRevision)) return null;
  return { ...observation, committedRevision: BigInt(observation.committedRevision) };
}
