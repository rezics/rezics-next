import canonicalize from 'canonicalize';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AccountIdentitySource } from '../../access/agent-verification-identity.ts';
import { currentCommand, currentCommandReceipt, type CommandTransaction } from '../../command/command.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import { withConnection } from '../../database/pool.ts';
import { nativePool } from './handles.ts';
import {
  declareAgentIdentityInventory,
  readAgentIdentityInventoryInTransaction,
  releaseAgentIdentityInventory,
} from '../application/identity.ts';
import { historyDeadline, readHistoryReceivingReceipt } from '../application/receiving.ts';
import { commandHistoryIdentityAccounts, commandHistoryKind, guardHistoryAccounts } from '../application/records.ts';
import {
  ACCOUNT_ROLE_BITS,
  type AccountReference,
  type AgentIdentityCopyCursor,
  type AgentIdentityCopyPage,
  type AgentIdentityReceipt,
  type AgentIdentityReceivingLookup,
  type AgentIdentitySourceHandoff,
  type AgentIdentitySourceKey,
  type AgentIdentityWorkSource,
  type HistoryArtifact,
  type HistoryBarrier,
  type HistoryReceivingContext,
  type HistoryReceivingDependencies,
  MAX_AGENT_IDENTITY_SOURCE_KEYS,
  agentIdentityAccounts,
  agentIdentitySourceKey,
  agentIdentityWorkSourceKey,
  decodeLocator,
  encodeLocator,
  unionHistoryScope,
  validateScope,
} from '../contract/index.ts';

type Declaration = Readonly<{
  original: ReturnType<typeof import('../../access/agent-verification-identity.ts').originalAccountIdentitySource>;
  accounts: readonly AccountReference[];
  kind: string;
}>;
const declarations = new WeakMap<CommandTransaction, Declaration>();
export type AgentIdentityCommandDeclaration = Declaration;
const serializing = new WeakSet<CommandTransaction>();

/** DATA ownership only. The original native writer must already have issued this exact binding
 * on this transaction. Neither a historical read nor a caller assertion supplies source authority. */
export async function declareAgentIdentitySource(
  tx: CommandTransaction,
  key: AgentIdentitySourceKey,
  digest: string,
): Promise<void> {
  // Load the owner only for this family, without a command-bootstrap import cycle.
  // Validate after the yield so concurrent declarations still reserve atomically below.
  const { originalAccountIdentitySource } = await import('../../access/agent-verification-identity.ts');
  const command = currentCommand(tx);
  agentIdentitySourceKey(key);
  if (declarations.has(tx) || serializing.has(tx) || command.partition !== partitionOf(key.route))
    throw new TypeError('Invalid, repeated or late Agent identity source declaration');
  const original = originalAccountIdentitySource(tx, key, digest);
  const kind = currentCommandReceipt(tx).kind;
  const accounts = unionHistoryScope(
    'command-receipt/v1',
    original.accounts,
    commandHistoryIdentityAccounts(tx),
  ).accounts;
  // Reserve before yielding, so concurrent/reentrant declarations cannot overwrite the original.
  declarations.set(
    tx,
    Object.freeze({
      original,
      kind,
      accounts: Object.freeze(accounts.map((account) => Object.freeze({ ...account }))),
    }),
  );
  await guardHistoryAccounts(tx, command.partition, accounts);
  await declareAgentIdentityInventory(tx, original, accounts);
}

export function commandAgentIdentitySource(tx: CommandTransaction): Declaration | undefined {
  return declarations.get(tx);
}
export function beginAgentIdentitySerialization(tx: CommandTransaction): void {
  currentCommand(tx);
  serializing.add(tx);
}
export function releaseAgentIdentitySource(tx: CommandTransaction): void {
  releaseAgentIdentityInventory(tx);
  declarations.delete(tx);
  serializing.delete(tx);
}

/** Only real native serializers call this, after the fence assigned the persisted position.
 * The SQL independently checks the exact physical artifact's original command, never a whole-tx guess. */
export async function recordAgentIdentityCopy(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  position: bigint,
): Promise<void> {
  const declared = declarations.get(tx);
  if (!declared) return;
  beginAgentIdentitySerialization(tx);
  const { original, kind } = declared;
  const command = currentCommand(tx);
  const receipt = currentCommandReceipt(tx);
  const locator = artifact.locator;
  if (
    artifact.partition !== command.partition ||
    original.position !== position ||
    original.transactionId !== command.transactionId ||
    kind !== receipt.kind ||
    locator.artifactType === 'durable-work/v1' ||
    locator.partitionNo !== command.partition
  )
    throw new TypeError('Identity copy does not belong to its actual original command');
  if (locator.artifactType === 'command-receipt/v1') {
    const token = `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}`;
    if (
      locator.principalKind !== receipt.principal.kind ||
      locator.principalId !== receipt.principal.id ||
      commandHistoryKind(locator.commandKindId) !== kind ||
      token !== receipt.storageKey
    )
      throw new TypeError('Identity copy requires its actual original receipt codec');
  } else if (locator.position !== position) throw new TypeError('Identity copy requires its actual outbox position');
  const inserted = await tx.query(
    `INSERT INTO core.agent_identity_history_copy
      (partition_no,source_route,source_account_id,source_direction,source_receipt_id,source_digest,
       source_epoch,source_position,source_transaction_id,artifact_type,locator,writer_version,
       receiver_epoch,domain_generation)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,p.epoch,d.generation
     FROM core.partition p CROSS JOIN core.history_family_domain d
     WHERE p.partition_no=$1 AND p.write_state='active' AND p.epoch=$7 AND p.position=$8 AND d.singleton
       AND EXISTS (SELECT 1 FROM core.receipt r WHERE r.partition_no=$1 AND r.transaction_id=$9
         AND r.epoch=$7 AND r.position=$8 AND r.principal_kind=$12 AND r.principal_id=$13
         AND r.command_kind=$14 AND r.idempotency_key=$15 AND r.xmin::text=pg_current_xact_id()::text)
       AND ($10='command-receipt/v1' OR EXISTS (SELECT 1 FROM core.outbox o
         WHERE o.partition_no=$1 AND o.epoch=$7 AND o.position=$8 AND o.event_seq=$16
           AND o.xmin::text=pg_current_xact_id()::text))`,
    [
      command.partition,
      original.key.route,
      original.key.accountId,
      original.key.direction,
      original.key.receiptId,
      original.digest,
      original.epoch,
      position.toString(),
      command.transactionId,
      locator.artifactType,
      Buffer.from(encodeLocator(locator)),
      receipt.principal.kind,
      receipt.principal.id,
      kind,
      receipt.storageKey,
      locator.artifactType === 'outbox-event/v1' ? locator.eventSeq : null,
    ],
  );
  if (inserted.rowCount !== 1) throw new TypeError('Original identity copy lacks its actual persisted native artifact');
}

/** Eight exact source keys, at most eight indexed candidate rows and ONE actual artifact.
 * All keys share a native home; there is no owner scan, transaction-wide attachment or JSON reconstruction. */
export async function readAgentIdentityCopies(
  pool: Pool,
  keys: readonly AgentIdentitySourceKey[],
  context: HistoryReceivingContext,
  after?: AgentIdentityCopyCursor,
): Promise<AgentIdentityCopyPage> {
  keys = structuredClone(keys);
  after = after ? structuredClone(after) : undefined;
  if (
    keys.length < 1 ||
    keys.length > MAX_AGENT_IDENTITY_SOURCE_KEYS ||
    new Set(keys.map(agentIdentitySourceKey)).size !== keys.length ||
    keys.some((key) => partitionOf(key.route) !== partitionOf(keys[0]!.route))
  )
    throw new TypeError('Identity copy lookup requires one to eight exact same-home source keys');
  const partition = partitionOf(keys[0]!.route);
  if (after) {
    if (!['command-receipt/v1', 'outbox-event/v1'].includes(after.artifactType))
      throw new TypeError('Invalid copy cursor');
    decodeLocator(after.artifactType, after.locator);
  }
  historyDeadline(context, partition);
  return withConnection(pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.max(1, context.deadline - Date.now())}ms`,
      ]);
      // Each exact original has an independent producer cut; page EOF never supplies it.
      let sealed = true;
      for (const key of keys) {
        const inventory = await readAgentIdentityInventoryInTransaction(tx, key);
        if (inventory.state !== 'sealed') sealed = false;
      }
      // One statement for this row kind; the finite key relation drives at most eight
      // index seeks, each materializing one candidate before the final one-artifact choice.
      const selected = await tx.query<{ artifact_type: AgentIdentityCopyCursor['artifactType']; locator: Buffer }>(
        `SELECT candidate.artifact_type,candidate.locator
         FROM jsonb_to_recordset($2::jsonb) AS k(route integer,"accountId" uuid,direction text,"receiptId" uuid)
         CROSS JOIN LATERAL (
           SELECT c.artifact_type,c.locator FROM core.agent_identity_history_copy c
           WHERE c.partition_no=$1 AND c.source_route=k.route AND c.source_account_id=k."accountId"
             AND c.source_direction=k.direction AND c.source_receipt_id=k."receiptId"
             AND (c.artifact_type,c.locator)>($3::text COLLATE "C",$4::bytea)
           ORDER BY c.artifact_type,c.locator LIMIT 1
         ) candidate ORDER BY candidate.artifact_type,candidate.locator LIMIT 1`,
        [partition, JSON.stringify(keys), after?.artifactType ?? '', after?.locator ?? Buffer.alloc(0)],
      );
      const first = selected.rows[0];
      let artifact: HistoryArtifact | null = null;
      if (first) {
        const refs = await tx.query<{
          account_route: number;
          account_id: string;
          roles: number;
          minimizer_version: number;
        }>(
          `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
           WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3 ORDER BY account_route,account_id LIMIT 65`,
          [partition, first.artifact_type, first.locator],
        );
        if (!refs.rows.length || refs.rows.length > 64 || refs.rows.some((row) => row.minimizer_version !== 1))
          throw new TypeError('Original identity copy role union unavailable');
        artifact = {
          partition,
          locator: decodeLocator(first.artifact_type, first.locator),
          accounts: refs.rows.map((row) => ({
            accountRoute: row.account_route,
            accountId: row.account_id,
            roles: row.roles,
          })),
        };
      }
      historyDeadline(context, partition);
      await tx.query('COMMIT');
      return {
        state: sealed ? 'sealed' : 'pending',
        gap: sealed ? null : 'agent-identity-original-inventory-unsealed',
        artifact,
        cursor: first ? { artifactType: first.artifact_type, locator: first.locator } : null,
      };
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

/** Release the lookup home before invoking the existing exact receiving API. Its result still
 * does not seal the original source inventory or discharge the independent Source consumer. */
export async function readAgentIdentityCopyReceiving(
  deps: HistoryReceivingDependencies,
  barrier: HistoryBarrier,
  keys: readonly AgentIdentitySourceKey[],
  context: HistoryReceivingContext,
  after?: AgentIdentityCopyCursor,
) {
  const page = await readAgentIdentityCopies(nativePool(deps.pool), keys, context, after);
  const receipt = page.artifact ? await readHistoryReceivingReceipt(deps, barrier, page.artifact, context) : null;
  return { ...page, receipt };
}

/** Unconverted associations keep their original retention gap. A native seal permits the
 * independent physical owner to minimize its payload; source and SDK metadata remain retained. */
export async function agentIdentityCopyRetentionGap(
  tx: CommandTransaction,
  partition: number,
  type: HistoryArtifact['locator']['artifactType'],
  locator: Buffer,
): Promise<string | null> {
  const copy = await tx.query(
    `SELECT 1 FROM core.agent_identity_history_copy c
     WHERE c.partition_no=$1 AND c.artifact_type=$2 AND c.locator=$3
     AND NOT (
       EXISTS (SELECT 1 FROM core.agent_identity_inventory i
         WHERE i.partition_no=c.partition_no AND i.source_route=c.source_route
           AND i.source_account_id=c.source_account_id AND i.source_direction=c.source_direction
           AND i.source_receipt_id=c.source_receipt_id AND i.state='sealed' AND i.native_writer_state='closed'
           AND c.source_digest=i.source_digest AND c.source_epoch=i.source_epoch
           AND c.source_position=i.source_position AND c.source_transaction_id=i.source_transaction_id
           AND c.locator=ANY(i.expected_locators) AND c.receiver_epoch=i.receiver_epoch
           AND c.domain_generation=i.domain_generation
           AND EXISTS (SELECT 1 FROM core.partition p WHERE p.partition_no=i.partition_no
             AND p.write_state='active' AND p.epoch=i.receiver_epoch)
           AND EXISTS (SELECT 1 FROM core.history_family_domain d WHERE d.singleton AND d.generation=i.domain_generation))
       OR EXISTS (SELECT 1 FROM core.agent_identity_recovery_inventory i
         WHERE i.partition_no=c.partition_no AND i.source_route=c.source_route
           AND i.source_account_id=c.source_account_id AND i.source_direction=c.source_direction
           AND i.source_receipt_id=c.source_receipt_id AND i.state='sealed' AND i.native_writer_state='closed'
           AND c.source_digest=i.source_digest AND c.source_epoch=i.recovery_epoch
           AND c.source_position=i.recovery_position AND c.source_transaction_id=i.recovery_transaction_id
           AND c.locator=ANY(i.expected_locators) AND c.receiver_epoch=i.receiver_epoch
           AND c.domain_generation=i.domain_generation
           AND EXISTS (SELECT 1 FROM core.partition p WHERE p.partition_no=i.partition_no
             AND p.write_state='active' AND p.epoch=i.receiver_epoch)
           AND EXISTS (SELECT 1 FROM core.history_family_domain d WHERE d.singleton AND d.generation=i.domain_generation))
     ) LIMIT 1`,
    [partition, type, locator],
  );
  return copy.rows.length ? 'agent-identity-source-retention-custody-pending' : null;
}

const handoffs = new WeakMap<AgentIdentitySourceHandoff, Readonly<{ assertNative(): void; snapshot: string }>>();
export function assertAgentIdentitySourceHandoff(handoff: AgentIdentitySourceHandoff): void {
  const proof = handoffs.get(handoff);
  if (!proof) throw new TypeError('Native released identity source handoff required');
  proof.assertNative();
  if (canonicalize(handoff.source) !== proof.snapshot) throw new TypeError('Mutated native identity source handoff');
}

function snapshot(source: AccountIdentitySource, retained?: readonly AccountReference[]): AgentIdentityWorkSource {
  const requester = source.roles.find((role) => role.role === 'actor')?.account_id;
  const decider = source.roles.find((role) => role.role === 'editor')?.account_id ?? null;
  if (!requester) throw new TypeError('Identity source requester unavailable');
  const known = agentIdentityAccounts(source.input.receipt.account, requester, decider);
  const accounts = retained ?? known;
  validateScope('durable-work/v1', { artifactType: 'durable-work/v1', accounts });
  if (
    known.some(
      (role) =>
        !accounts.some(
          (entry) =>
            entry.accountId === role.accountId &&
            entry.accountRoute === role.accountRoute &&
            (entry.roles & role.roles) === role.roles,
        ),
    )
  )
    throw new TypeError('Identity source association omits original native roles');
  return {
    key: agentIdentityWorkSourceKey(source.input.receipt),
    partition: source.partition,
    epoch: source.epoch,
    position: source.position.toString(),
    transactionId: source.transactionId,
    digest: source.digest,
    release: source.input.intent.release,
    workflowId: source.workflowId,
    accounts,
  };
}

/** Called only after the genuine original Source INSERT, in that SAME account-home command.
 * An older SDK receiver keeps its creation transaction; this appends a separate source intent. */
export async function recordAgentIdentityWorkSource(
  tx: CommandTransaction,
  receipt: AgentIdentityReceipt,
  initialCustodyId: string | null,
): Promise<void> {
  const command = currentCommand(tx);
  const row = (
    await tx.query(
      `SELECT source_partition,source_epoch,source_position::text,source_transaction_id,intent_digest,
       release,workflow_id,requested_by,decided_by FROM access.agent_identity_intent
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4 FOR SHARE`,
      [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt],
    )
  ).rows[0];
  if (!row || row.source_partition !== command.partition || row.source_transaction_id !== command.transactionId)
    throw new TypeError('Identity SDK source association requires the actual original command');
  const declared = commandAgentIdentitySource(tx);
  if (
    !declared ||
    declared.original.digest !== row.intent_digest ||
    declared.original.transactionId !== command.transactionId
  )
    throw new TypeError('Identity SDK source association requires its native original declaration');
  const source: AgentIdentityWorkSource = {
    key: agentIdentityWorkSourceKey(receipt),
    partition: row.source_partition,
    epoch: row.source_epoch,
    position: row.source_position,
    transactionId: row.source_transaction_id,
    digest: row.intent_digest,
    release: row.release,
    workflowId: row.workflow_id,
    accounts: unionHistoryScope(
      'durable-work/v1',
      declared.accounts,
      agentIdentityAccounts(receipt.account, row.requested_by, row.decided_by),
    ).accounts,
  };
  const domain = (await tx.query('SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE'))
    .rows[0];
  if (!domain) throw new TypeError('Identity SDK source generation unavailable');
  await tx.query(
    `INSERT INTO core.agent_identity_work_source(partition_no,source_key,custody_id,source,source_generation)
     VALUES($1,$2,$3,$4,$5)`,
    [command.partition, source.key, initialCustodyId ?? randomUUID(), source, domain.generation],
  );
  // Enroll this actual source-side SDK intent under the original inventory's lock. Its
  // native trigger advances the cut generation; this grants no future-writer closure.
  const obligation = await tx.query(
    `UPDATE core.agent_identity_sdk_obligation SET generation=generation+1
     WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3
       AND source_direction=$4 AND source_receipt_id=$5 AND workflow_id=$6 AND delivery_key=$7`,
    [
      command.partition,
      routeOf(receipt.account),
      receipt.account,
      receipt.kind,
      receipt.receipt,
      source.workflowId,
      source.key,
    ],
  );
  if (obligation.rowCount !== 1) throw new TypeError('Identity SDK intent lacks its native inventory obligation');
}

/** Released immutable Source -> original command association. No receiver is checked out here.
 * Old/recovered sources without the original recording seam stay precisely unavailable. */
export async function readAgentIdentitySourceHandoff(
  pool: Pool,
  receipt: AgentIdentityReceipt,
): Promise<AgentIdentitySourceHandoff | null> {
  // Command bootstrap imports this module for original receipt/outbox serialization.
  // Load the native owner only at the released SDK handoff boundary.
  const { loadAccountIdentitySource, assertAccountIdentitySource } =
    await import('../../access/agent-verification-identity.ts');
  const native = await loadAccountIdentitySource(pool, receipt);
  assertAccountIdentitySource(native, native.input.receipt);
  const nativeKey = snapshot(native);
  return withConnection(pool, async (tx) => {
    const row = (
      await tx.query<{ custody_id: string; source: AgentIdentityWorkSource; generation: string }>(
        `SELECT s.custody_id,s.source,s.source_generation::text AS generation FROM core.agent_identity_work_source s
         JOIN core.history_family_domain d ON d.singleton AND d.generation=s.source_generation
         WHERE s.partition_no=$1 AND s.source_key=$2 AND s.writer_version=1`,
        [nativeKey.partition, nativeKey.key],
      )
    ).rows[0];
    if (!row) return null;
    // The original command's immutable declaration also retains acting-human and original
    // undo roles. Keep that native manifest rather than reconstructing a smaller union.
    const expected = snapshot(native, row.source.accounts);
    if (JSON.stringify(row.source) !== JSON.stringify(expected)) {
      // jsonb object key order differs from JavaScript. Compare the closed metadata canonically.
      if (canonicalize(row.source) !== canonicalize(expected))
        throw new TypeError('Identity source association mismatch');
    }
    const handoff = Object.freeze({ custodyId: row.custody_id, source: expected, generation: row.generation });
    handoffs.set(handoff, {
      assertNative: () => assertAccountIdentitySource(native, native.input.receipt),
      snapshot: canonicalize(expected)!,
    });
    return handoff;
  });
}

/** At most eight exact original keys and one artifact in total. This is copy lookup, never inventory EOF. */
export async function lookupAgentIdentityReceivingCopies(
  pool: Pool,
  receipts: readonly AgentIdentityReceipt[],
): Promise<readonly AgentIdentityReceivingLookup[]> {
  if (receipts.length > 8) throw new TypeError('Identity receiving lookup exceeds eight keys');
  const result: AgentIdentityReceivingLookup[] = [];
  let artifactIssued = false;
  for (const receipt of receipts) {
    if (artifactIssued) {
      result.push({ state: 'pending', gap: 'identity-sdk-lookup-artifact-budget' });
      continue;
    }
    const handoff = await readAgentIdentitySourceHandoff(pool, receipt);
    if (!handoff) {
      result.push({ state: 'pending', gap: 'identity-sdk-original-source-association-unavailable' });
      continue;
    }
    const associated = await withConnection(pool, async (tx) => {
      const row = (
        await tx.query<{ source: AgentIdentityWorkSource | null; workflow_id: string; creation_captured: boolean }>(
          `SELECT m.source,m.workflow_id,m.creation_captured FROM core.agent_identity_work m
           JOIN core.history_work w ON w.partition_no=0 AND w.work_id=m.custody_id
             AND w.request_digest=m.request_digest AND w.owner='access.agent-identity'
           JOIN core.partition p ON p.partition_no=0 AND p.write_state='active' AND p.epoch=m.receiver_epoch
           JOIN core.history_family_domain d ON d.singleton AND d.generation=m.receiver_generation
           WHERE m.custody_id=$1 AND m.writer_version=1 AND m.receiver_generation=$2`,
          [handoff.custodyId, handoff.generation],
        )
      ).rows[0];
      return (
        row?.creation_captured &&
        row.workflow_id === handoff.source.workflowId &&
        canonicalize(row.source) === canonicalize(handoff.source)
      );
    });
    artifactIssued = Boolean(associated);
    result.push(
      associated
        ? {
            state: 'associated',
            artifact: {
              partition: 0,
              locator: { artifactType: 'durable-work/v1', workId: handoff.custodyId },
              accounts: handoff.source.accounts,
            },
          }
        : { state: 'pending', gap: 'identity-sdk-receiver-source-handoff-pending' },
    );
  }
  return result;
}
