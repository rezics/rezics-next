import type { Pool } from 'pg';
import type { OpenSearch } from './opensearch.ts';
import { createOrderedScopePreparation } from './scope-preparation-ordered.ts';
import { createFacetPopulationSource } from '../semantic/facet-population.ts';
import { ProblemError } from '../http/problem.ts';
import type { PublicFilterSourceFactory } from '../semantic/public-filter-source-contract.ts';
import { createPublicIdentitySourceCapture } from '../semantic/identity-scoped-public-source.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import { createNativeLibrarySourceCustody } from '../library/native-source-custody.ts';
import { readRelease } from '../semantic/definitions.ts';
import type { IdentityScopeRegistration, IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { createScopePreparationStore, type ScopePreparationRecord } from './scope-preparation-store.ts';
import { ScopeWork, scopeAllowance, zeroScopeWork } from './scope-execution.ts';
import { sameScopeObservation } from './service-scope-order.ts';
import {
  advanceConceptBrowse,
  CONCEPT_BROWSE_WORKER_LIMITS,
  type ConceptBrowseSource,
  type ConceptBrowseState,
} from './concept-browse.ts';
import { createConceptBrowseStore } from './concept-browse-store.ts';

/** One bounded structural step under the existing Search WorkModule. No native receiving receipts
 * are constructed here. Expiry stops scheduling but retains unknown native custody for its owner.
 */
export function createScopePreparation(
  config: Parameters<PublicFilterSourceFactory>[0] & {
    prefix: string;
    search?: OpenSearch;
    conceptSource?: (
      definition: Extract<ScopePreparationRecord['definition'], { kind: 'concept' }>,
      context: Readonly<{ deadline: number; work: ScopeWork }>,
    ) => Promise<ConceptBrowseSource>;
  },
) {
  const store = createScopePreparationStore(config.pool, config.prefix);
  const observations = createIdentityScopedObservations(config.pool);
  const publicCapture = createPublicIdentitySourceCapture(config);
  const library = createNativeLibrarySourceCustody({ pool: config.pool, clock: config.clock });
  const ordered = config.search ? createOrderedScopePreparation({ ...config, search: config.search }) : null;
  const population = createFacetPopulationSource(config);
  async function orderedStep(
    record: ScopePreparationRecord,
    observation: IdentityScopeObservation,
    frontier: ScopePreparationRecord['frontier'],
    deadline: number,
    work: ScopeWork,
  ) {
    const definition = record.definition;
    if (!ordered || definition.kind !== 'public' || !definition.ordered)
      throw new ProblemError('dependency_unavailable');
    const current = await observations.revalidate({ key: observation.key, expected: observation, deadline });
    work.identity(current.work);
    if (current.status !== 'current' || !sameScopeObservation(current.observation, observation))
      throw new ProblemError('semantic_not_ready');
    work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
    const release = await readRelease(config.pool, definition.definition.meaning.digest);
    if (!release) throw new ProblemError('semantic_not_ready');
    const nativeDefinition = { ...definition.definition, meaning: { ...definition.definition.meaning, release } };
    const native = ordered.native(nativeDefinition, record);
    const previous = await ordered.state(record.scope_id, work);
    const capture = await native.capture(nativeDefinition.capture, previous, work, deadline);
    if (!capture.ready || !previous.queried) {
      await ordered.save(record, frontier, capture.state, observation, [], work);
      return;
    }
    const q = capture.state.queried!;
    // This existing Source producer retains immutable replayable windows, including empty
    // home/bridge/seal progress. Structural capture originals are not a population cursor.
    const input = await population.readFacetPopulationPage({
      population: nativeDefinition.readDefinition,
      frontier: previous.populationFrontier ?? null,
      inputLimit: Math.min(8, work.remaining().remaining.candidateKeys),
      capture: { kind: 'population', queried: q, start: null, context: { deadline } },
    });
    work.public(input.cost);
    if (
      (input.status !== 'progress' && input.status !== 'complete') ||
      input.observation !== q.snapshot.observation ||
      (input.status === 'progress' && input.frontier === previous.populationFrontier)
    )
      throw new ProblemError('semantic_not_ready');
    const keys = [...new Set(input.subjects.map((row) => row.subject))];
    const result = await native.keys(capture.state, keys, work, deadline, keys.length ? undefined : []);
    if (!keys.length) {
      work.consume({ ...zeroScopeWork(), emptySeeks: 1 });
    }
    const final = await observations.revalidate({ key: observation.key, expected: observation, deadline });
    work.identity(final.work);
    if (final.status !== 'current' || !sameScopeObservation(final.observation, observation))
      throw new ProblemError('semantic_not_ready');
    await ordered.save(
      record,
      frontier,
      {
        ...(result?.state ?? capture.state),
        populationFrontier: input.frontier,
        populationComplete: input.status === 'complete',
      },
      observation,
      result?.hits ?? [],
      work,
      input.status === 'complete',
    );
  }
  async function step(record: ScopePreparationRecord, deadline: number, work: ScopeWork): Promise<void> {
    if (record.definition.kind === 'concept') {
      const state: ConceptBrowseState = {
        version: 2,
        selection: record.definition.selection,
        binding: record.definition.binding,
        retained: { id: record.scope_id, revision: record.revision },
      };
      const retained = createConceptBrowseStore(config.pool, config.prefix, record.scope_id, {
        expiresAt: Number(record.expires_at),
        leaseUntil: deadline,
        reserve: ({ statements, rows, bytes }) =>
          work.consume({ ...zeroScopeWork(), statements, nativeRows: rows, bytes }),
      });
      if (Number(record.expires_at) <= Date.now()) return retained.retire(state);
      // The native adapter must observe the live release and source and account for its own work.
      // Absence of that adapter cannot seal an empty hierarchy or enable concept Search.
      if (!config.conceptSource) return retained.checkpoint(state, 30000);
      const source = await config.conceptSource(record.definition, { deadline, work });
      const result = await advanceConceptBrowse(source, retained, state, CONCEPT_BROWSE_WORKER_LIMITS);
      if (result.status === 'preparing') await retained.checkpoint(result.state, 1000);
      return;
    }
    async function advance(
      frontier: ScopePreparationRecord['frontier'],
      observation: IdentityScopeObservation | null,
      delay: number,
    ) {
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 20000 });
      return store.advance(record, frontier, observation, delay);
    }
    if (Number(record.expires_at) <= Date.now()) return advance(record.frontier, null, 0);
    if (record.definition.ordered && record.observation) {
      await orderedStep(
        record,
        { ...record.observation, committedRevision: BigInt(record.observation.committedRevision) },
        record.frontier,
        deadline,
        work,
      );
      return;
    }
    let registration: IdentityScopeRegistration;
    let capturedFrontier = record.frontier;
    const definition = record.definition;
    if (definition.kind === 'realm') throw new ProblemError('dependency_unavailable');
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
        inputLimit: record.definition.ordered ? Math.min(8, work.remaining().remaining.candidateKeys) : 100,
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
    if (
      record.definition.ordered &&
      final.status === 'current' &&
      sameScopeObservation(final.observation, first.observation)
    ) {
      await orderedStep(record, final.observation, capturedFrontier, deadline, work);
      return;
    }
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
        // An ordered build keeps its actual old observation. Repair cannot silently repin it.
        if (prior.definition.ordered) return;
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
      const work = new ScopeWork(scopeAllowance(100, scopeId));
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
