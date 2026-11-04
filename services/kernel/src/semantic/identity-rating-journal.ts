import { createHash } from 'node:crypto';
import { currentCommand, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import { bindIdentityRatingPage, snapshotIdentityRatingScope } from './identity-rating-adapter.ts';
import { snapshotIdentityRatingCheckpoint } from './identity-rating-consumer.ts';
import type {
  IdentityRatingCommitReceipt,
  IdentityRatingPageBinding,
  IdentityRatingRepairCheckpoint,
  IdentityRatingRepairScope,
  IdentityRatingSelectedPage,
} from './identity-rating-parent.ts';

type Journal = {
  scope: IdentityRatingRepairScope;
  owner_node: string;
  owner_epoch: number;
  checkpoint: IdentityRatingRepairCheckpoint | null;
  reclaimed: boolean;
};
type Page = {
  selected_page: IdentityRatingSelectedPage;
  binding: IdentityRatingPageBinding;
  receipt: IdentityRatingCommitReceipt;
  acknowledged: boolean;
};
type Owner = { node: string; epoch: number; position: string };

/** A trusted port of the ONE rating writer; never installed from request data. Both
 * methods receive the same live transaction and the entire normalized selection.
 * assertHeldAdmission is read-only: the producer wrapper already owns admission.
 */
export type IdentityRatingJournalProducer = Readonly<{
  assertHeldAdmission(
    tx: CommandTransaction,
    input: Readonly<{
      scope: IdentityRatingRepairScope;
      page: IdentityRatingSelectedPage;
      binding: IdentityRatingPageBinding;
    }>,
  ): Promise<void>;
  applySelectedPage(
    tx: CommandTransaction,
    input: Readonly<{
      scope: IdentityRatingRepairScope;
      page: IdentityRatingSelectedPage;
      binding: IdentityRatingPageBinding;
    }>,
  ): Promise<void>;
}>;

const changed = new WeakSet<CommandTransaction>();
function mutation(tx: CommandTransaction) {
  if (changed.has(tx)) return;
  // Makes a noEffect result illegal even if the original writer emits no event.
  registerCommandCallback(tx, () => {});
  changed.add(tx);
}
const stale = () => new Error('identity_rating_journal_stale');
function scopeIdentity(input: IdentityRatingRepairScope) {
  const scope = snapshotIdentityRatingScope(input);
  if (!scope) throw new TypeError('Invalid identity rating repair scope');
  const encoded = JSON.stringify(scope);
  return { scope, key: createHash('sha256').update(encoded).digest('hex'), encoded };
}
function same(left: unknown, right: unknown): boolean {
  // All compared values were constructed in fixed field order by the adapter.
  // Database JSONB key order is immaterial.
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  const a = Object.keys(left),
    b = Object.keys(right);
  return (
    a.length === b.length &&
    a.every((key) => Object.hasOwn(right, key) && same(Reflect.get(left, key), Reflect.get(right, key)))
  );
}

async function owner(tx: CommandTransaction): Promise<Owner> {
  const partition = currentCommand(tx).partition;
  const row = (
    await tx.query<Owner>(
      `SELECT node,epoch,position::text FROM core.partition
     WHERE partition_no=$1 AND write_state='active' FOR UPDATE`,
      [partition],
    )
  ).rows[0];
  if (!row) throw stale();
  return row;
}
async function journal(tx: CommandTransaction, input: IdentityRatingRepairScope, lock: boolean) {
  const identity = scopeIdentity(input);
  const partition = currentCommand(tx).partition;
  const row = (
    await tx.query<Journal>(
      `SELECT scope,owner_node,owner_epoch,checkpoint,reclaimed
     FROM semantic.identity_rating_repair_journal
     WHERE partition_no=$1 AND scope_key=$2${lock ? ' FOR UPDATE' : ''}`,
      [partition, identity.key],
    )
  ).rows[0];
  if (row && !same(row.scope, identity.scope)) throw stale();
  return { ...identity, partition, row };
}
function current(row: Journal, native: Owner) {
  return row.owner_node === native.node && row.owner_epoch === native.epoch;
}
async function pageRow(tx: CommandTransaction, partition: number, key: string, digest: string) {
  return (
    await tx.query<Page>(
      `SELECT selected_page,binding,receipt,acknowledged FROM semantic.identity_rating_repair_page
     WHERE partition_no=$1 AND scope_key=$2 AND selection_digest=$3`,
      [partition, key, digest],
    )
  ).rows[0];
}

/** Called inside the original command, after its wrapper's single admission/lock
 * sequence. Native receipt and effects commit together. An interrupted reply can
 * never apply the writer twice. Empty pages use the same path and native fence.
 */
export async function commitIdentityRatingJournalPage(
  tx: CommandTransaction,
  input: IdentityRatingRepairScope,
  selected: IdentityRatingSelectedPage,
  producer: IdentityRatingJournalProducer,
): Promise<IdentityRatingCommitReceipt> {
  const identity = scopeIdentity(input);
  const bound = bindIdentityRatingPage(identity.scope, selected);
  if (!bound?.binding.native) throw new TypeError('Native identity rating page required');
  const selection = Object.freeze({ scope: identity.scope, ...bound });
  await producer.assertHeldAdmission(tx, selection);
  const native = await owner(tx);
  const { page, binding } = bound;
  if (binding.ownerId !== native.node || binding.ownerRevision !== String(native.epoch)) throw stale();
  const partition = currentCommand(tx).partition;
  const inserted = await tx.query(
    `INSERT INTO semantic.identity_rating_repair_journal
       (partition_no,scope_key,scope,owner_node,owner_epoch)
     VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING`,
    [partition, identity.key, identity.encoded, native.node, native.epoch],
  );
  if (inserted.rowCount) mutation(tx);
  const { row } = await journal(tx, identity.scope, true);
  if (!row || !current(row, native) || row.reclaimed) throw stale();
  const retained = await pageRow(tx, partition, identity.key, binding.digest);
  if (retained) {
    if (!same(retained.binding, binding) || !same(retained.selected_page, page)) throw stale();
    return retained.receipt;
  }
  const checkpoint = row.checkpoint;
  if (checkpoint ? checkpoint.phase !== 'repair' || page.after !== checkpoint.binding.next : page.after !== null)
    throw stale();
  await producer.applySelectedPage(tx, selection);
  const receipt: IdentityRatingCommitReceipt = Object.freeze({
    pageId: binding.pageId,
    selectionDigest: binding.digest,
    ownerId: binding.ownerId,
    ownerRevision: binding.ownerRevision,
    identityEpoch: binding.identityEpoch,
    transactionId: currentCommand(tx).transactionId,
    position: (BigInt(native.position) + 1n).toString(),
    terminal: binding.terminal,
  });
  await tx.query(
    `INSERT INTO semantic.identity_rating_repair_page
       (partition_no,scope_key,selection_digest,selected_page,binding,receipt)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`,
    [partition, identity.key, binding.digest, JSON.stringify(page), JSON.stringify(binding), JSON.stringify(receipt)],
  );
  mutation(tx);
  return receipt;
}

/** Producer advancement and this acknowledgement must use this same transaction.
 * Re-ACKing an older retained page succeeds without rewinding the checkpoint.
 */
export async function acknowledgeIdentityRatingJournalPage(
  tx: CommandTransaction,
  input: IdentityRatingRepairScope,
  binding: IdentityRatingPageBinding,
  receipt: IdentityRatingCommitReceipt,
): Promise<boolean> {
  const native = await owner(tx);
  const { scope, partition, key, row } = await journal(tx, input, true);
  if (!row || !current(row, native) || row.reclaimed || !binding.native) return false;
  const retained = await pageRow(tx, partition, key, binding.digest);
  if (!retained || !same(retained.binding, binding) || !same(retained.receipt, receipt)) return false;
  if (retained.acknowledged) return true;
  if (
    row.checkpoint
      ? row.checkpoint.phase !== 'repair' || binding.after !== row.checkpoint.binding.next
      : binding.after !== null
  )
    return false;
  const checkpoint: IdentityRatingRepairCheckpoint = {
    scope,
    binding: { ...binding, native: binding.native },
    receipt,
    phase: binding.terminal ? 'reclamation' : 'repair',
  };
  await tx.query(
    `UPDATE semantic.identity_rating_repair_page SET acknowledged=true
     WHERE partition_no=$1 AND scope_key=$2 AND selection_digest=$3`,
    [partition, key, binding.digest],
  );
  await tx.query(
    `UPDATE semantic.identity_rating_repair_journal SET checkpoint=$3::jsonb
     WHERE partition_no=$1 AND scope_key=$2`,
    [partition, key, JSON.stringify(checkpoint)],
  );
  mutation(tx);
  return true;
}

/** Full scope keys and current native ownership are checked even on terminal replay. */
export async function readIdentityRatingJournalCheckpoint(tx: CommandTransaction, input: IdentityRatingRepairScope) {
  const native = await owner(tx);
  const { scope, row } = await journal(tx, input, false);
  if (!row) return null;
  if (!current(row, native)) throw stale();
  return row.checkpoint ? snapshotIdentityRatingCheckpoint(scope, row.checkpoint) : null;
}

/** A replay locates the exact retained selection, never the producer's live frontier. */
export async function readIdentityRatingJournalPage(
  tx: CommandTransaction,
  input: IdentityRatingRepairScope,
  binding: IdentityRatingPageBinding,
) {
  const native = await owner(tx);
  const { partition, key, row } = await journal(tx, input, false);
  if (!row || !current(row, native) || row.reclaimed) return null;
  const retained = await pageRow(tx, partition, key, binding.digest);
  return retained && same(retained.binding, binding) ? retained : null;
}

export async function verifyIdentityRatingJournalReclaimed(
  tx: CommandTransaction,
  input: IdentityRatingRepairScope,
  checkpoint: IdentityRatingRepairCheckpoint,
): Promise<'current' | 'stale' | 'pending'> {
  const native = await owner(tx);
  const { scope, row } = await journal(tx, input, false);
  if (!row) return 'pending';
  if (!current(row, native)) return 'stale';
  const saved = row.checkpoint;
  const candidate = snapshotIdentityRatingCheckpoint(scope, checkpoint);
  return row.reclaimed &&
    saved &&
    candidate &&
    same(saved.binding, candidate.binding) &&
    same(saved.receipt, candidate.receipt)
    ? 'current'
    : 'pending';
}

/** Only the producer may prove that its final REAL reference disappeared and its
 * other payload inventories finished. The assertion must hold the producer's
 * reference fence through this transaction; journal rows are not that inventory.
 */
export async function reclaimIdentityRatingJournalPages(
  tx: CommandTransaction,
  input: IdentityRatingRepairScope,
  assertFinalReferenceRemoved: (tx: CommandTransaction, checkpoint: IdentityRatingRepairCheckpoint) => Promise<boolean>,
): Promise<'stale' | 'still-referenced' | 'continuing' | 'reclaimed' | 'already-reclaimed'> {
  const native = await owner(tx);
  const { partition, key, row } = await journal(tx, input, true);
  if (!row || !current(row, native)) return 'stale';
  if (row.reclaimed) return 'already-reclaimed';
  const checkpoint = row.checkpoint;
  if (!checkpoint || checkpoint.phase !== 'reclamation') return 'stale';
  if (!(await assertFinalReferenceRemoved(tx, checkpoint))) return 'still-referenced';
  // Keep the exact terminal page available until the same transaction installs
  // the compact tombstone. The primary key supports the whole seek and ordering.
  const pages = (
    await tx.query<{ selection_digest: string }>(
      `SELECT selection_digest FROM semantic.identity_rating_repair_page
     WHERE partition_no=$1 AND scope_key=$2 AND selection_digest<>$3
     ORDER BY selection_digest LIMIT 65`,
      [partition, key, checkpoint.binding.digest],
    )
  ).rows;
  const batch = pages.slice(0, 64).map((page) => page.selection_digest);
  if (batch.length)
    await tx.query(
      `DELETE FROM semantic.identity_rating_repair_page
     WHERE partition_no=$1 AND scope_key=$2 AND selection_digest=ANY($3::text[])`,
      [partition, key, batch],
    );
  mutation(tx);
  if (pages.length > 64) return 'continuing';
  await tx.query(
    `DELETE FROM semantic.identity_rating_repair_page
     WHERE partition_no=$1 AND scope_key=$2 AND selection_digest=$3`,
    [partition, key, checkpoint.binding.digest],
  );
  await tx.query(
    `UPDATE semantic.identity_rating_repair_journal SET reclaimed=true,checkpoint=$3::jsonb
     WHERE partition_no=$1 AND scope_key=$2`,
    [partition, key, JSON.stringify({ ...checkpoint, phase: 'complete' })],
  );
  return 'reclaimed';
}
