/** Sole whole-query staging producer. Mechanical work never selects a public output or restores an Actor. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import type { QueryResultRow } from 'pg';
import { commandTime, currentCommand, currentCommandResources, type CommandTransaction } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { compileCurrentOwnerFilter } from '../search/current-filter-plan.ts';
import { zeroScopeWork } from '../search/scope-execution.ts';
import { createSearchScopeSource, type ScopeBasis } from '../search/scope-source.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import {
  admitCollectionPublicationStep,
  readCollectionPublicationWorkDefinition,
  type CollectionPublicationLocator,
  type CollectionPublicationWorkDefinition,
} from './collection-publication-work-admission.ts';
import type { CollectionOutputRef } from './collection-source-output.ts';
import type { CollectionSourceObservation, WorkAllowance, WorkReceipt } from './collection-source.ts';
import { readCollectionSourceWorkState } from './collection-source-work-native.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { createNativeLibrarySourceCustody, type NativeSourceIdentity } from './native-source-custody.ts';
import {
  enterCollectionPublicationPrefix,
  initialCollectionPublicationFrontier,
  settleCollectionPublicationSubject,
  type CollectionPublicationFrontier,
} from './collection-publication-staging-state.ts';

type Runtime = Parameters<typeof createSearchScopeSource>[0];
/** The actual Search service configuration, including its server-only work role. No driver/policy callbacks. */
export type CollectionPublicationStagingOptions = Runtime & Readonly<{ allowance: WorkAllowance }>;
type Binding = Readonly<{
  rule: CollectionPublicationWorkDefinition['rule'];
  source: NativeSourceIdentity;
  observation: CollectionSourceObservation;
  identity: Omit<IdentityScopeObservation, 'committedRevision'> & Readonly<{ committedRevision: string }>;
  custody: Readonly<{ captureId: string; holdId: string; transactionId: string }>;
  repair: Readonly<{ partition: number; epoch: number; position: string; transactionId: string }>;
}>;
type Checkpoint = QueryResultRow & {
  route: number;
  collection_id: string;
  generation: string;
  publication_id: string;
  account_id: string;
  definition_digest: string;
  binding: Binding;
  scope_basis: ScopeBasis;
  canonical_generation: string;
  canonical_basis_digest: string;
  fact_fence: string;
  public_inputs: boolean;
  frontier: CollectionPublicationFrontier;
  version: string;
};
export type CollectionPublicationStagingCheckpoint = Readonly<{
  output: CollectionOutputRef;
  version: string;
  frontier: CollectionPublicationFrontier;
}>;
/** Native receipt data only, freshly reread on use; never accepted as an activation input. */
export type CollectionPublicationStagingSeal = Readonly<{
  output: CollectionOutputRef;
  publicationId: string;
  definitionDigest: string;
  members: string;
  version: string;
  nativeXid: string;
  position: string;
}>;
export type CollectionPublicationStagingResult = Readonly<{
  state: 'more' | 'sealed';
  checkpoint: CollectionPublicationStagingCheckpoint;
  work: WorkReceipt;
}>;
const unavailable = () => new ProblemError('dependency_unavailable');
const conflict = () => new ProblemError('conflict');
const json = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(JSON.parse(json(value)))!)
    .digest('hex');
// Scheduling may move staging -> awaiting_activation after sealing. It changes no pinned query/input/output.
// The WHOLE getter result, including phase, is still compared before/after foreign work in each actual step.
function definitionDigest(native: CollectionPublicationWorkDefinition): string {
  const { phase: _phase, ...definition } = native;
  return digest(definition);
}
const output = (row: Checkpoint): CollectionOutputRef => ({
  route: row.route,
  collectionId: row.collection_id,
  generation: row.generation,
});
const publicCheckpoint = (row: Checkpoint): CollectionPublicationStagingCheckpoint => ({
  output: output(row),
  version: row.version,
  frontier: row.frontier,
});
function binding(native: CollectionPublicationWorkDefinition): Binding {
  return {
    rule: native.rule,
    source: native.sourceIdentity,
    observation: native.observation,
    identity: {
      ...native.identityObservation,
      committedRevision: native.identityObservation.committedRevision.toString(),
    },
    custody: {
      captureId: native.custody.captureId,
      holdId: native.custody.holdId,
      transactionId: native.custody.transactionId,
    },
    repair: { ...native.repairReceipt, position: native.repairReceipt.position.toString() },
  };
}

/** Every own point/write has a bounded result and reserves all dimensions before dispatch. Trigger/index work
 * is included in row bounds; rows are never refunded using result.rowCount. Foreign producers settle their own
 * actual receipts through NativeCollectionWork.compose with the SAME reservation ID.
 */
async function query<R extends QueryResultRow>(
  tx: CommandTransaction,
  work: NativeCollectionWork,
  sql: string,
  values: unknown[],
  rows = 32,
  bytes = 32768,
): Promise<R[]> {
  const reservation = work.reserve({
    ...zeroScopeWork(),
    nativeRows: rows,
    nativePoints: 8,
    statements: 1,
    emptySeeks: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(json(values)) + bytes,
  });
  reservation.dispatch();
  try {
    const result = await tx.query<R>(sql, values);
    if (Buffer.byteLength(json(result.rows)) > bytes) throw unavailable();
    return result.rows;
  } finally {
    reservation.settle();
  }
}

/** Core admission and native getter precede any Source/Type work, always on this exact live client. */
async function admit(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
  work: NativeCollectionWork,
): Promise<CollectionPublicationWorkDefinition> {
  if (!hasLiveOperationalTransaction(tx)) throw unavailable();
  const resources = currentOperationalResources(tx);
  if (
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(locator.route) ||
    routeOf(locator.collectionId) !== locator.route ||
    routeOf(locator.ownerAccountId) !== locator.route ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    !commandTime(tx)
  )
    throw unavailable();
  // The native episode port is fixed-size metadata, not a Source traversal or an all-owner scan.
  const reservation = work.reserve({
    ...zeroScopeWork(),
    nativeRows: 8192,
    nativePoints: 128,
    statements: 128,
    bytes: 1048576,
    emptySeeks: 128,
  });
  reservation.dispatch();
  let native: CollectionPublicationWorkDefinition | null;
  try {
    if ((await admitCollectionPublicationStep(tx, locator)) !== true) throw unavailable();
    native = await readCollectionPublicationWorkDefinition(tx, locator);
  } finally {
    reservation.settle();
  }
  if (!native || !hasLiveOperationalTransaction(tx)) throw unavailable();
  const source = native.sourceIdentity;
  if (
    !isDeepStrictEqual(native.locator, locator) ||
    native.input.kind !== 'private_working_source' ||
    source.scope !== 'private_builtin' ||
    !isDeepStrictEqual(source, native.input.identity) ||
    source.route !== locator.route ||
    source.collectionId !== locator.collectionId ||
    source.accountId !== locator.ownerAccountId ||
    source.ownerEpoch !== native.observation.stamp.epoch ||
    native.definition.sort !== 'id' ||
    native.definition.release.digest !== native.releaseDigest ||
    native.rule.releaseDigest !== native.releaseDigest ||
    !native.audience ||
    native.rule.sourceGeneration !== source.generation ||
    native.rule.incarnation !== source.incarnation ||
    native.rule.collectionRevision !== native.observation.revision ||
    native.observation.collectionId !== locator.collectionId ||
    native.observation.route !== locator.route ||
    native.observation.stamp.partition !== resources.partition ||
    !native.observation.basis.profilePins.includes(native.releaseDigest) ||
    native.observation.incarnation !== source.incarnation ||
    native.observation.authority.kind !== 'private_builtin' ||
    native.observation.authority.curatorAccountId !== locator.ownerAccountId ||
    native.target.collectionId !== locator.collectionId ||
    native.target.route !== locator.route ||
    !['public', 'unlisted'].includes(native.target.visibility) ||
    native.output.ref.collectionId !== locator.collectionId ||
    native.output.ref.route !== locator.route ||
    native.output.ref.generation === native.selected?.ref.generation ||
    !isDeepStrictEqual(native.creation.source, {
      locator,
      input: native.input,
      target: native.target,
      rule: native.rule,
      output: native.output.ref,
    }) ||
    native.identityObservation.key.source.kind !== 'library' ||
    !isDeepStrictEqual(native.identityObservation.key.source.identity, source) ||
    !isDeepStrictEqual(native.custody.identity, source) ||
    native.custody.captureId !== native.identityObservation.captureId ||
    native.repairReceipt.partition !== resources.partition ||
    native.repairReceipt.epoch !== source.ownerEpoch ||
    native.repairReceipt.position <= 0n ||
    !native.repairReceipt.transactionId
  )
    throw unavailable();
  return native;
}

async function checkpoint(tx: CommandTransaction, locator: CollectionPublicationLocator, work: NativeCollectionWork) {
  const [row] = await query<Checkpoint>(
    tx,
    work,
    `SELECT route,collection_id::text,generation::text,publication_id::text,account_id::text,
      definition_digest,binding,scope_basis,canonical_generation::text,canonical_basis_digest,
      fact_fence::text,public_inputs,frontier,version::text FROM library.collection_publication_staging
     WHERE route=$1 AND collection_id=$2 AND publication_id=$3 FOR UPDATE`,
    [locator.route, locator.collectionId, locator.publicationId],
  );
  if (row && row.account_id !== locator.ownerAccountId) throw unavailable();
  return row ?? null;
}

export async function readCollectionPublicationStagingCheckpoint(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
  work: NativeCollectionWork,
): Promise<CollectionPublicationStagingCheckpoint | null> {
  const native = await admit(tx, locator, work);
  const row = await checkpoint(tx, locator, work);
  if (!row) return null;
  if (row.definition_digest !== definitionDigest(native) || !isDeepStrictEqual(row.binding, binding(native)))
    throw unavailable();
  return publicCheckpoint(row);
}

/** A single canonical subject (including excluded subjects), or one sparse Source frontier, per bounded step.
 * There is no selected-set fallback, caller list, force/complete flag, second allowance or public Search write.
 * The registered owner worker can repeat this function with its native locator after each committed step.
 */
export async function stageCollectionPublicationStep(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
  options: CollectionPublicationStagingOptions,
): Promise<CollectionPublicationStagingResult> {
  if (!hasLiveOperationalTransaction(tx)) throw unavailable();
  const resources = currentOperationalResources(tx);
  const work = new NativeCollectionWork(options.allowance, resources.deadline);
  try {
    const native = await admit(tx, locator, work);
    const evidence = options.evidence;
    const workRole: unknown = evidence?.work ? Reflect.get(evidence.work, 'kind') : null;
    // Search owns the distinct guarded publication branch. Until it is delivered, the actual union has no
    // such member: refuse explicitly, before Source I/O. Never cast/alias a Members or Kind work context.
    if (
      options.pool !== resources.pool ||
      !evidence?.work ||
      workRole !== 'collection-publication' ||
      evidence.work.tx !== tx ||
      !isDeepStrictEqual(evidence.work.locator, locator) ||
      evidence.deadline > resources.deadline
    )
      throw unavailable();
    const source = await work.compose((allowance) =>
      readCollectionSourceWorkState(options.pool, evidence.work!, {
        access: evidence.access,
        deadline: evidence.deadline,
        allowance,
      }),
    );
    if (!isDeepStrictEqual(source.definition, native) || !isDeepStrictEqual(source.observation, native.observation))
      throw unavailable();
    if (source.metadata.factFence === null) throw unavailable();
    const scope = createSearchScopeSource(options);
    const prepared = await work.compose(async (allowance) => {
      const prepared = await scope.prepare(native.definition.filter, {
        releaseDigest: native.releaseDigest,
        order: { kind: 'id', source: native.sourceIdentity },
        allowance,
        readOnly: true,
      });
      return { prepared, work: scope.work(prepared) };
    });
    const plan = compileCurrentOwnerFilter(native.definition.filter);
    const publicInputs = plan.leaves.some((leaf) => leaf.kind === 'catalogue');
    if (
      prepared.prepared.basis.release !== native.releaseDigest ||
      (!publicInputs &&
        (!prepared.prepared.basis.nativeOwner ||
          !isDeepStrictEqual(prepared.prepared.basis.nativeOwner, {
            source: native.sourceIdentity,
            observation: native.observation,
          })))
    )
      throw unavailable();
    // Reserve the post-evaluation metadata rereads, CAS and possible seal BEFORE foreign page/evaluation.
    // In particular, protecting only the INSERT would let an evaluator starve the mandatory native admissions.
    const settlement = work.reserve({
      ...zeroScopeWork(),
      nativeRows: 65536,
      nativePoints: 1024,
      statements: 512,
      emptySeeks: 512,
      identityMetadataRows: 16384,
      bytes: 2097152,
    });
    let row = await checkpoint(tx, locator, work);
    if (!row) {
      await query(
        tx,
        work,
        `INSERT INTO library.collection_publication_staging
         (route,collection_id,generation,publication_id,account_id,definition_digest,binding,scope_basis,
          canonical_generation,canonical_basis_digest,public_inputs,frontier,fact_fence)
         SELECT g.route,g.collection_id,g.generation,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$14
         FROM library.collection_source_output g
         WHERE g.route=$1 AND g.collection_id=$2 AND g.generation=$3 AND g.account_id=$5
           AND g.source_generation=$13 AND g.output_mode='whole_query' AND g.expected_members IS NULL
           AND g.state='building' AND g.written_members=0 AND g.member_count=0
           AND NOT EXISTS(SELECT 1 FROM library.collection_source_output_head h
             WHERE h.route=g.route AND h.collection_id=g.collection_id AND h.generation=g.generation)
         ON CONFLICT DO NOTHING`,
        [
          locator.route,
          locator.collectionId,
          native.output.ref.generation,
          locator.publicationId,
          locator.ownerAccountId,
          definitionDigest(native),
          json(binding(native)),
          json(prepared.prepared.basis),
          source.generation,
          source.basis.digest,
          publicInputs,
          json(initialCollectionPublicationFrontier()),
          native.rule.sourceGeneration,
          source.metadata.factFence,
        ],
      );
      row = await checkpoint(tx, locator, work);
    }
    if (
      !row ||
      row.generation !== native.output.ref.generation ||
      row.definition_digest !== definitionDigest(native) ||
      !isDeepStrictEqual(row.binding, binding(native)) ||
      !isDeepStrictEqual(row.scope_basis, prepared.prepared.basis) ||
      row.canonical_generation !== source.generation ||
      row.canonical_basis_digest !== source.basis.digest ||
      row.fact_fence !== source.metadata.factFence ||
      row.public_inputs !== publicInputs
    )
      throw unavailable();
    if (row.frontier.exhausted) {
      settlement.cancel();
      const seal = await readCollectionPublicationStagingSeal(tx, locator, work);
      if (!seal) throw unavailable();
      return { state: 'sealed', checkpoint: publicCheckpoint(row), work: work.receipt() };
    }
    let frontier = row.frontier;
    let subject: string | null = null;
    let included: boolean | null = null;
    let references: readonly string[] = [];
    if (!frontier.exhausted && !frontier.pending) {
      const page = await work.compose((allowance) =>
        scope.sourcePrefix(prepared.prepared, {
          afterSubjectId: frontier.after,
          // A narrowed slice of the SAME root, preserving room for the evaluator and its original/terminal work.
          allowance: {
            ...allowance,
            remaining: {
              ...allowance.remaining,
              candidateKeys: Math.min(16, Math.floor(allowance.remaining.candidateKeys / 4)),
            },
          },
        }),
      );
      if (!isDeepStrictEqual(page.basis, row.scope_basis) || !isDeepStrictEqual(page.observation, native.observation))
        throw unavailable();
      frontier = enterCollectionPublicationPrefix(frontier, page);
    }
    if (frontier.pending) {
      subject = frontier.pending.subject;
      const evaluated = await work.compose(async (allowance) => {
        const r = allowance.remaining;
        const evaluation = await scope.evaluate(prepared.prepared, [subject!], {
          rawKeys: Math.min(256, r.candidateKeys),
          allowance,
          native: {
            rows: r.nativeRows,
            points: r.nativePoints,
            witnesses: r.witnessKeys,
            bytes: r.bytes,
            emptySeeks: r.emptySeeks,
          },
          progress: frontier.pending?.progress ?? null,
        });
        return { evaluation, work: scope.work(evaluation) };
      });
      if (!isDeepStrictEqual(evaluated.evaluation.basis, row.scope_basis)) throw unavailable();
      const settled = settleCollectionPublicationSubject(frontier, evaluated.evaluation);
      frontier = settled.frontier;
      included = settled.included;
      references = evaluated.evaluation.evidence;
    }
    // Release the held envelope before dispatching its native rereads/writes. It is the SAME root allowance.
    settlement.cancel();
    // Whole-result equality includes original authority/output/phase, not just its rule digest or Source ID.
    if (!isDeepStrictEqual(await admit(tx, locator, work), native)) throw unavailable();
    const finalSource = await work.compose((allowance) =>
      readCollectionSourceWorkState(options.pool, evidence.work!, {
        access: evidence.access,
        deadline: evidence.deadline,
        allowance,
      }),
    );
    if (
      !isDeepStrictEqual(finalSource.definition, native) ||
      finalSource.generation !== source.generation ||
      !isDeepStrictEqual(finalSource.basis, source.basis)
    )
      throw unavailable();
    await writeCollectionPublicationCheckpoint(tx, locator, row, { frontier, subject, included, references }, work);
    if (frontier.exhausted) await sealCollectionPublicationStaging(tx, locator, work);
    const updated = await checkpoint(tx, locator, work);
    if (!updated) throw conflict();
    return {
      state: frontier.exhausted ? 'sealed' : 'more',
      checkpoint: publicCheckpoint(updated),
      work: work.receipt(),
    };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}

/** Private append/CAS only. Its arguments come from the admitted traversal above, never an HTTP/work payload. */
async function writeCollectionPublicationCheckpoint(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
  row: Checkpoint,
  next: Readonly<{
    frontier: CollectionPublicationFrontier;
    subject: string | null;
    included: boolean | null;
    references: readonly string[];
  }>,
  work: NativeCollectionWork,
) {
  if (Buffer.byteLength(json(next.frontier)) > 4096 || Buffer.byteLength(json(next.references)) > 16384)
    throw unavailable();
  if (next.subject !== null && next.included !== null) {
    await query(
      tx,
      work,
      `INSERT INTO library.collection_publication_staging_evidence
       (route,collection_id,generation,subject_id,included,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [locator.route, locator.collectionId, row.generation, next.subject, next.included, json(next.references)],
    );
    if (next.included) {
      const [appended] = await query<{ subject_id: string }>(
        tx,
        work,
        `WITH admitted AS (
          SELECT g.route,g.collection_id,g.generation FROM library.collection_source_output g
          WHERE g.route=$1 AND g.collection_id=$2 AND g.generation=$3 AND g.account_id=$5
            AND g.state='building' AND g.output_mode='whole_query' AND g.expected_members IS NULL
            AND (g.after_subject_id IS NULL OR g.after_subject_id<$4::uuid)
          FOR UPDATE
        ), inserted AS (
          INSERT INTO library.collection_source_output_member(route,collection_id,generation,subject_id)
          SELECT route,collection_id,generation,$4 FROM admitted RETURNING subject_id
        ) SELECT subject_id::text FROM inserted`,
        [locator.route, locator.collectionId, row.generation, next.subject, locator.ownerAccountId],
        128,
      );
      if (!appended) throw conflict();
      await query(
        tx,
        work,
        `UPDATE library.collection_source_output SET written_members=written_members+1,after_subject_id=$4
         WHERE route=$1 AND collection_id=$2 AND generation=$3`,
        [locator.route, locator.collectionId, row.generation, next.subject],
      );
    }
  }
  const [updated] = await query<{ version: string }>(
    tx,
    work,
    `UPDATE library.collection_publication_staging SET frontier=$5::jsonb,version=version+1
     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND version=$4
       AND NOT EXISTS(SELECT 1 FROM library.collection_publication_staging_seal s
         WHERE s.route=$1 AND s.collection_id=$2 AND s.generation=$3)
     RETURNING version::text`,
    [locator.route, locator.collectionId, row.generation, row.version, json(next.frontier)],
  );
  if (!updated) throw conflict();
}

/** Native source-local checks used both at exhaustion and on every final-command seal read. */
async function currentSource(tx: CommandTransaction, row: Checkpoint, work: NativeCollectionWork) {
  const resources = hasLiveOperationalTransaction(tx) ? currentOperationalResources(tx) : currentCommandResources(tx);
  const time = commandTime(tx);
  if (!time || row.binding.source.scope !== 'private_builtin') throw unavailable();
  const held = await work.compose((allowance) =>
    createNativeLibrarySourceCustody({ pool: resources.pool }).revalidateHold({
      client: tx,
      at: time,
      identity: row.binding.source,
      ...row.binding.custody,
      allowance,
      deadline: resources.deadline,
    }),
  );
  if (held.status !== 'held' || held.custody.transactionId !== row.binding.custody.transactionId) throw unavailable();
  const expected: IdentityScopeObservation = {
    ...row.binding.identity,
    committedRevision: BigInt(row.binding.identity.committedRevision),
  };
  await work.compose(async (allowance) => {
    const result = await createIdentityScopedObservations(resources.pool).revalidate({
      key: expected.key,
      expected,
      tx,
      deadline: resources.deadline,
    });
    const receipt = {
      reservationId: allowance.reservationId,
      used: {
        ...zeroScopeWork(),
        identityMetadataRows: result.work.rows,
        nativePoints: result.work.points,
        statements: result.work.statements,
        bytes: result.work.bytes,
      },
    };
    if (result.status !== 'current' || !isDeepStrictEqual(result.observation, expected)) throw unavailable();
    return { work: receipt };
  });
  const source = row.binding.source;
  const [current] = await query(
    tx,
    work,
    `SELECT c.collection_id FROM library.collection c
     JOIN core.partition p ON p.partition_no=(c.route >> 4)
     JOIN library.canonical_source_head h ON h.route=c.route AND h.collection_id=c.collection_id
     JOIN library.canonical_source_generation g ON g.route=h.route AND g.collection_id=h.collection_id AND g.generation=h.generation
     JOIN library.fact_source_head facts ON facts.route=c.route AND facts.account_id=c.curator_account_id
     JOIN library.collection_publication_episode episode ON episode.route=c.route AND episode.collection_id=c.collection_id
       AND episode.publication_id=$13 AND episode.owner_account_id=c.curator_account_id
       AND episode.phase IN ('staging','awaiting_activation')
     JOIN editorial.write_basis repair ON repair.partition_no=p.partition_no AND repair.epoch=p.epoch
       AND repair.position=$11 AND repair.transaction_id=$12
     WHERE c.route=$1 AND c.collection_id=$2 AND c.curator_account_id=$3 AND c.state='active'
       AND c.source_generation=$4 AND c.revision=$5
       AND c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text=$6
       AND p.epoch=$7 AND p.write_state='active' AND p.moved_to IS NULL
       AND h.generation=$8 AND g.state='complete' AND g.source_exhausted
       AND g.basis->>'digest'=$9 AND facts.generation=$10`,
    [
      row.route,
      row.collection_id,
      row.account_id,
      source.generation,
      row.binding.observation.revision,
      source.incarnation,
      source.ownerEpoch,
      row.canonical_generation,
      row.canonical_basis_digest,
      row.fact_fence,
      row.binding.repair.position,
      row.binding.repair.transactionId,
      row.publication_id,
    ],
    128,
  );
  if (!current) throw unavailable();
}

/** Only the admitted producer can reach this after all native leaves/subjects have settled. It never selects B. */
async function sealCollectionPublicationStaging(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
  work: NativeCollectionWork,
) {
  const native = await admit(tx, locator, work);
  const row = await checkpoint(tx, locator, work);
  if (!row || row.definition_digest !== definitionDigest(native) || !row.frontier.exhausted || row.frontier.pending)
    throw unavailable();
  // Search's current public Source/index proof is not exposed by the delivered adapter. Its index name/count
  // or a private owner capture cannot fill that gap. Keep that foreign branch explicitly unavailable.
  if (row.public_inputs || !row.scope_basis.nativeOwner) throw unavailable();
  await currentSource(tx, row, work);
  if (!isDeepStrictEqual(await admit(tx, locator, work), native)) throw unavailable();
  const [sealed] = await query(
    tx,
    work,
    `WITH fenced AS (
       UPDATE core.partition SET position=position+1
       WHERE partition_no=($1::integer >> 4) AND epoch=$4 AND write_state='active' AND moved_to IS NULL
       RETURNING epoch,position
     ), touched AS (
       UPDATE library.collection_publication_staging SET version=version+1
       WHERE route=$1 AND collection_id=$2 AND generation=$3
         AND (frontier->>'exhausted')::boolean AND frontier->'pending'='null'::jsonb
       RETURNING *
     ) INSERT INTO library.collection_publication_staging_seal
       (route,collection_id,generation,version,member_fence,members,evidence_count,evidence_fence,owner_epoch,position)
       SELECT s.route,s.collection_id,s.generation,s.version,g.member_fence,g.written_members,
         s.evidence_count,s.evidence_fence,f.epoch,f.position
       FROM touched s JOIN library.collection_source_output g USING(route,collection_id,generation) CROSS JOIN fenced f
       WHERE g.state='building' AND g.output_mode='whole_query' AND g.expected_members IS NULL
         AND g.member_count=g.written_members
       RETURNING generation`,
    [row.route, row.collection_id, row.generation, native.sourceIdentity.ownerEpoch],
    256,
  );
  if (!sealed) throw unavailable();
}

/** Fresh native seal reader for final activation. It accepts a locator, never copied JSON or a permission callback.
 * Final bodies still own their ordinary current initiator/episode authorization and native complete-output hooks.
 */
export async function readCollectionPublicationStagingSeal(
  tx: CommandTransaction,
  locator: CollectionPublicationLocator,
  work: NativeCollectionWork,
): Promise<CollectionPublicationStagingSeal | null> {
  let native: CollectionPublicationWorkDefinition | null = null;
  if (hasLiveOperationalTransaction(tx)) native = await admit(tx, locator, work);
  else {
    const command = currentCommand(tx);
    if (
      command.partition !== partitionOf(locator.route) ||
      command.basis === null ||
      command.authorization?.mode !== 'execute' ||
      command.authorization.action !== 'collection:update' ||
      command.authorization.resource.route !== locator.route ||
      command.authorization.resource.id !== locator.collectionId
    )
      throw unavailable();
  }
  const row = await checkpoint(tx, locator, work);
  if (!row) return null;
  if (
    native &&
    (row.definition_digest !== definitionDigest(native) || !isDeepStrictEqual(row.binding, binding(native)))
  )
    throw unavailable();
  if (
    row.public_inputs ||
    !row.scope_basis.nativeOwner ||
    !row.frontier.exhausted ||
    row.frontier.pending ||
    !isDeepStrictEqual(row.scope_basis.nativeOwner, {
      source: row.binding.source,
      observation: row.binding.observation,
    })
  )
    return null;
  const [seal] = await query<{ members: string; native_xid: string; position: string }>(
    tx,
    work,
    `SELECT r.members::text,r.native_xid::text,r.position::text
     FROM library.collection_publication_staging s
     JOIN library.collection_publication_staging_seal r USING(route,collection_id,generation)
     JOIN library.collection_source_output g USING(route,collection_id,generation)
     JOIN core.partition p ON p.partition_no=(s.route >> 4)
     WHERE s.route=$1 AND s.collection_id=$2 AND s.generation=$3
       AND r.xmin=s.xmin AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
       AND r.version=s.version AND r.member_fence=g.member_fence AND r.members=g.written_members
       AND r.members=g.member_count AND r.evidence_count=s.evidence_count AND r.evidence_fence=s.evidence_fence
       AND g.output_mode='whole_query' AND g.expected_members IS NULL AND g.state='building'
       AND g.account_id=s.account_id AND g.source_generation=$4
       AND p.epoch=r.owner_epoch AND p.position>=r.position AND p.write_state='active' AND p.moved_to IS NULL`,
    [row.route, row.collection_id, row.generation, row.binding.source.generation],
    128,
  );
  if (!seal) return null;
  await currentSource(tx, row, work);
  if (native && hasLiveOperationalTransaction(tx) && !isDeepStrictEqual(await admit(tx, locator, work), native))
    throw unavailable();
  return {
    output: output(row),
    publicationId: row.publication_id,
    definitionDigest: row.definition_digest,
    members: seal.members,
    version: row.version,
    nativeXid: seal.native_xid,
    position: seal.position,
  };
}
