import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { currentOperationalResources, type OperationalTransaction } from '../command/operational.ts';
import { partitionOf } from '../route/route.ts';
import {
  assertSelectedOperationalTransaction,
  selectedLocalQuery,
  assertSelectedContinuation,
  type SelectedIdentity,
} from '../work/selected-runtime.ts';
import { validateOperationalMembersBinding, type OperationalMembersBinding } from './operational-work.ts';
import { OperationalWorkUnavailable } from './operational-work-budget.ts';

export type SelectedLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  episodeId: string;
}>;
export type SelectedOutcome = Readonly<{
  kind: 'complete' | 'continue' | 'failure' | 'obsolete';
  version: string;
  continuation?: string;
}>;
declare const selectedEpisode: unique symbol;
/** Result is durable data for replay. This object itself is usable only inside its original invocation. */
export type SelectedEpisode = Readonly<{ result: SelectedOutcome | null; readonly [selectedEpisode]: true }>;
type Tuple = {
  basis: string;
  digest: string;
  version: string;
  checkpoint: string | null;
  observation: string | null;
  preparedIncarnation: string | null;
  preparedGeneration: string | null;
  complete: boolean;
  incarnation: string;
  generation: string;
  reservedIncarnation: string;
  reservedGeneration: string;
  failure: string | null;
};
type Episode = {
  txIdentity: SelectedIdentity;
  locator: SelectedLocator;
  custody: string;
  tuple: Tuple;
  originalDigest: string;
  result: SelectedOutcome | null;
};
const episodes = new WeakMap<SelectedEpisode, Episode>();
function unavailable(gap: string): never {
  throw new OperationalWorkUnavailable(gap);
}
const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Only owned literal SQL is exempt from the foreign dispatch declaration. No caller SQL shape matching.
const SQL = Object.freeze({
  domain: 'SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE',
  head: 'SELECT epoch,generation::text,position::text FROM core.operational_work_head WHERE partition_no=$1 FOR SHARE',
  home: 'SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
  original: `SELECT o.* FROM core.operational_work_episode e JOIN core.operational_work_original o
    ON o.partition_no=e.partition_no AND o.custody_id=e.custody_id
    WHERE e.partition_no=$1 AND e.route=$2 AND e.owner_account_id=$3 AND e.collection_id=$4 AND e.episode_id=$5
    FOR SHARE OF e,o`,
  present: "SELECT to_regclass('library.members_preparation') IS NOT NULL AS present",
  // Verification-only read of Commerce's native tuple. Its reservation/apply SQL remains Commerce-owned.
  tuple: `SELECT h.canonical_basis AS basis,encode(h.basis_digest,'hex') AS digest,h.progress_version::text AS version,
    h.checkpoint,h.observation,h.source_incarnation AS "preparedIncarnation",h.source_generation::text AS "preparedGeneration",
    h.complete,h.reserved_incarnation AS "reservedIncarnation",h.reserved_generation::text AS "reservedGeneration",
    h.failure_code AS failure,c.collection_id::text||':'||extract(epoch FROM c.created_at)::text AS incarnation,
    c.source_generation::text AS generation
    FROM library.members_preparation h JOIN library.collection c ON c.route=h.route AND c.collection_id=h.collection_id
    WHERE h.route=$1 AND h.owner_account_id=$2 AND h.collection_id=$3 AND h.episode_id=$4
      AND octet_length(h.canonical_basis)<=196608
      AND octet_length(h.reserved_incarnation)<=256
      AND (h.source_incarnation IS NULL OR octet_length(h.source_incarnation)<=256)
      AND h.state='live' AND h.last_read_at>clock_timestamp()-interval '24 hours'
      AND c.state='active' AND c.membership_kind='curated' AND c.curator_account_id=h.owner_account_id
      AND h.reserved_incarnation=c.collection_id::text||':'||extract(epoch FROM c.created_at)::text
      AND h.reserved_generation=c.source_generation
    FOR SHARE OF c FOR UPDATE OF h`,
  insert: `INSERT INTO core.operational_work_selection(partition_no,workflow_id,function_id,custody_id,route,owner_account_id,
    collection_id,episode_id,attempt_generation,restore_generation,deadline,original_digest,selected_tuple)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
  association: `SELECT * FROM core.operational_work_selection WHERE partition_no=$1 AND workflow_id=$2 AND function_id=$3 FOR UPDATE`,
  result: `UPDATE core.operational_work_selection SET result=$4::jsonb
    WHERE partition_no=$1 AND workflow_id=$2 AND function_id=$3 AND result IS NULL RETURNING result`,
  continuation: `SELECT * FROM core.operational_work_selected_continuation WHERE partition_no=$1 AND workflow_id=$2 FOR SHARE`,
  sdk: `SELECT s.name,s.queue_name,s.creator_xid,s.serialization,i.inputs FROM dbos.workflow_status s
    JOIN dbos.workflow_input i ON i.workflow_uuid=s.workflow_uuid WHERE s.workflow_uuid=$1
    AND octet_length(i.inputs)<=8192 FOR SHARE OF s,i`,
  continueInsert: `INSERT INTO core.operational_work_selected_continuation(partition_no,workflow_id,custody_id,
    parent_workflow_id,parent_function_id,route,owner_account_id,collection_id,episode_id,sdk_input_digest,sdk_creator)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
});

async function original(tx: OperationalTransaction, identity: SelectedIdentity, locator: SelectedLocator) {
  const p = partitionOf(locator.route);
  const home = (await selectedLocalQuery(tx, identity, SQL.home, [p])).rows[0];
  const domain = (await selectedLocalQuery(tx, identity, SQL.domain)).rows[0];
  const head = (await selectedLocalQuery(tx, identity, SQL.head, [p])).rows[0];
  const o = (
    await selectedLocalQuery(tx, identity, SQL.original, [
      p,
      locator.route,
      locator.ownerAccountId,
      locator.collectionId,
      locator.episodeId,
    ])
  ).rows[0];
  if (
    !o ||
    !o.sealed ||
    !o.creation_captured ||
    o.source_domain !== 'operational-work/v1' ||
    !home ||
    home.write_state !== 'active' ||
    home.epoch !== o.source_epoch ||
    domain?.generation !== o.source_generation ||
    head?.epoch !== o.source_epoch ||
    head?.generation !== o.source_generation ||
    !o.source_position ||
    BigInt(head.position) < BigInt(o.source_position)
  )
    unavailable('selected-runtime-original-unavailable');
  validateOperationalMembersBinding(o.binding, o.intent);
  const binding = o.binding as OperationalMembersBinding;
  if (binding.retired.length > 16) unavailable('selected-runtime-original-cleanup-bound-exceeded');
  const reservation = binding.episodes.find(
    (e) => e.collectionId === locator.collectionId && e.episodeId === locator.episodeId,
  );
  if (
    binding.route !== locator.route ||
    binding.ownerAccountId !== locator.ownerAccountId ||
    !reservation ||
    o.operation_kind !== 'library.membersPreparation' ||
    o.operation_mode !== 'request' ||
    !same(o.operation_accounts, [locator.ownerAccountId]) ||
    hash(canonicalize({ binding: o.binding, intent: o.intent, scope: o.scope })!) !==
      Buffer.from(o.request_digest).toString('hex') ||
    o.sdk_writer.restoreGeneration !== identity.restoreGeneration ||
    o.sdk_writer.generation !== '1'
  )
    unavailable('selected-runtime-original-binding-changed');
  // Request deadline is intentionally NOT funding and is never renewed. Read immutable provenance only.
  if (o.workflow_id === identity.workflowID) {
    if (
      identity.workflowName !== o.intent.workflowName ||
      identity.queueName !== o.intent.queue ||
      identity.creatorXid !== o.sdk_creator ||
      hash(identity.inputs) !== Buffer.from(o.sdk_input_digest).toString('hex')
    )
      unavailable('selected-runtime-sdk-arguments-changed');
  } else {
    const c = (await selectedLocalQuery(tx, identity, SQL.continuation, [p, identity.workflowID])).rows[0];
    if (
      !c ||
      c.custody_id !== o.custody_id ||
      c.route !== locator.route ||
      c.owner_account_id !== locator.ownerAccountId ||
      c.collection_id !== locator.collectionId ||
      c.episode_id !== locator.episodeId ||
      c.sdk_creator !== identity.creatorXid ||
      Buffer.from(c.sdk_input_digest).toString('hex') !== hash(identity.inputs)
    )
      unavailable('selected-runtime-continuation-unassociated');
  }
  return { o, reservation };
}
async function tuple(
  tx: OperationalTransaction,
  identity: SelectedIdentity,
  locator: SelectedLocator,
): Promise<Tuple> {
  if (!(await selectedLocalQuery(tx, identity, SQL.present)).rows[0]?.present)
    unavailable('selected-runtime-commerce-native-episode-absent');
  const row = (
    await selectedLocalQuery(tx, identity, SQL.tuple, [
      locator.route,
      locator.ownerAccountId,
      locator.collectionId,
      locator.episodeId,
    ])
  ).rows[0] as Tuple | undefined;
  if (!row) unavailable('selected-runtime-native-episode-obsolete');
  if (
    Buffer.byteLength(JSON.stringify(row)) > 2097152 ||
    !/^(0|[1-9][0-9]{0,18})$/.test(row.version) ||
    hash(row.basis) !== row.digest ||
    (row.checkpoint !== null && Buffer.byteLength(row.checkpoint) > 4096) ||
    (row.observation !== null && Buffer.byteLength(row.observation) > 4096)
  )
    unavailable('selected-runtime-native-tuple-invalid');
  return row;
}
export async function associateSelectedEpisode(
  tx: OperationalTransaction,
  identity: SelectedIdentity,
  locator: SelectedLocator,
  fresh = true,
): Promise<SelectedEpisode> {
  assertSelectedOperationalTransaction(tx, identity);
  const resources = currentOperationalResources(tx);
  if (
    resources.mode !== 'work-step' ||
    resources.deadline !== identity.deadline ||
    resources.kind !== 'library.membersPreparation.step'
  )
    unavailable('selected-runtime-native-context-mismatch');
  const { o, reservation } = await original(tx, identity, locator);
  const keys = [resources.partition, identity.workflowID, identity.functionID];
  const previous = !fresh ? (await selectedLocalQuery(tx, identity, SQL.association, keys)).rows[0] : undefined;
  const native = previous?.result ? (previous.selected_tuple as Tuple) : await tuple(tx, identity, locator);
  if (
    reservation!.canonicalBasis !== native.basis ||
    reservation!.basisDigest !== native.digest ||
    reservation!.reservedIncarnation !== native.reservedIncarnation ||
    reservation!.reservedGeneration !== native.reservedGeneration
  )
    unavailable('selected-runtime-reservation-changed');
  // The durable SDK once-only admission bit survives rollback of THIS transaction.
  if (fresh)
    await selectedLocalQuery(tx, identity, SQL.insert, [
      ...keys,
      o.custody_id,
      locator.route,
      locator.ownerAccountId,
      locator.collectionId,
      locator.episodeId,
      identity.attemptGeneration,
      identity.restoreGeneration,
      identity.deadline,
      o.request_digest,
      JSON.stringify(native),
    ]);
  const stored = previous ?? (await selectedLocalQuery(tx, identity, SQL.association, keys)).rows[0];
  if (
    !stored ||
    stored.custody_id !== o.custody_id ||
    stored.route !== locator.route ||
    stored.owner_account_id !== locator.ownerAccountId ||
    stored.collection_id !== locator.collectionId ||
    stored.episode_id !== locator.episodeId ||
    stored.restore_generation !== identity.restoreGeneration ||
    Buffer.from(stored.original_digest).toString('hex') !== Buffer.from(o.request_digest).toString('hex')
  )
    unavailable('selected-runtime-once-only-association-unavailable');
  if (!fresh && stored.result === null) unavailable('selected-runtime-recovery-spent-admission');
  if (fresh && (stored.attempt_generation !== identity.attemptGeneration || !same(stored.selected_tuple, native)))
    unavailable('selected-runtime-selection-replay-refused');
  const result = stored.result as SelectedOutcome | null;
  const episode = Object.freeze({ result: result && Object.freeze({ ...result }) }) as SelectedEpisode;
  episodes.set(episode, {
    txIdentity: identity,
    locator: { ...locator },
    custody: o.custody_id,
    tuple: native,
    originalDigest: Buffer.from(o.request_digest).toString('hex'),
    result,
  });
  return episode;
}
export async function finishSelectedEpisode(
  tx: OperationalTransaction,
  identity: SelectedIdentity,
  episode: SelectedEpisode,
  phase: 'apply' | 'failure',
  body: (tx: OperationalTransaction) => Promise<SelectedOutcome>,
): Promise<SelectedOutcome> {
  assertSelectedOperationalTransaction(tx, identity);
  const bound = episodes.get(episode);
  if (!bound || bound.txIdentity !== identity) unavailable('selected-runtime-forged-or-escaped-episode');
  if (bound.result) return structuredClone(bound.result);
  const { o } = await original(tx, identity, bound.locator);
  if (Buffer.from(o.request_digest).toString('hex') !== bound.originalDigest)
    unavailable('selected-runtime-original-changed');
  const before = await tuple(tx, identity, bound.locator);
  if (!same(before, bound.tuple)) unavailable('selected-runtime-observed-version-or-generation-changed');
  const keys = [partitionOf(bound.locator.route), identity.workflowID, identity.functionID];
  const stored = (await selectedLocalQuery(tx, identity, SQL.association, keys)).rows[0];
  if (!stored || !same(stored.selected_tuple, before) || stored.attempt_generation !== identity.attemptGeneration)
    unavailable('selected-runtime-selection-changed');
  if (stored.result) return stored.result as SelectedOutcome;
  const result = await body(tx);
  if (
    !result ||
    Buffer.byteLength(JSON.stringify(result)) > 4096 ||
    !['complete', 'continue', 'failure', 'obsolete'].includes(result.kind)
  )
    throw new TypeError('Invalid selected native outcome');
  if (result.kind === 'complete') unavailable('selected-runtime-final-source-physical-authority-unavailable');
  const after = await tuple(tx, identity, bound.locator);
  if (
    after.basis !== before.basis ||
    after.digest !== before.digest ||
    after.incarnation !== before.incarnation ||
    after.generation !== before.generation ||
    result.version !== after.version ||
    (phase === 'failure' &&
      (result.kind !== 'failure' || before.version !== after.version || after.failure === null)) ||
    (phase === 'apply' && result.kind !== 'obsolete' && BigInt(after.version) !== BigInt(before.version) + 1n) ||
    (result.kind === 'continue' && (after.complete || !result.continuation))
  )
    unavailable('selected-runtime-native-transition-unobserved');
  if (result.continuation) {
    assertSelectedContinuation(tx, identity, result.continuation);
    const l = bound.locator;
    if (
      result.kind !== 'continue' ||
      result.continuation !==
        `library:members-preparation:${l.route}:${l.ownerAccountId}:${l.episodeId}:step:${after.version}`
    )
      unavailable('selected-runtime-continuation-binding-changed');
    const s = (await selectedLocalQuery(tx, identity, SQL.sdk, [result.continuation])).rows[0];
    const input = {
      accounts: [l.ownerAccountId],
      route: l.route,
      episodes: [{ collectionId: l.collectionId, episodeId: l.episodeId }],
      cleanup: [],
    };
    if (
      !s ||
      s.name !== 'library.membersPreparation' ||
      s.queue_name !== 'workflows' ||
      !s.creator_xid ||
      !same(JSON.parse(s.inputs).json, [input])
    )
      unavailable('selected-runtime-continuation-not-committed-in-transaction');
    await selectedLocalQuery(tx, identity, SQL.continueInsert, [
      keys[0],
      result.continuation,
      bound.custody,
      identity.workflowID,
      identity.functionID,
      l.route,
      l.ownerAccountId,
      l.collectionId,
      l.episodeId,
      Buffer.from(hash(s.inputs), 'hex'),
      s.creator_xid,
    ]);
  }
  if (!(await selectedLocalQuery(tx, identity, SQL.result, [...keys, JSON.stringify(result)])).rows[0])
    unavailable('selected-runtime-result-raced');
  // No heap committed flag: only the actual durable row at replay/recovery establishes COMMIT.
  return Object.freeze({ ...result });
}
