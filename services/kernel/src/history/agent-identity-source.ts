import type { Pool } from 'pg';
import { currentCommand, currentCommandReceipt, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import { guardHistoryAccounts } from './gates.ts';
import { decodeLocator, encodeLocator, type AccountReference } from './locator.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
import {
  historyDeadline,
  readHistoryReceivingReceipt,
  type HistoryReceivingContext,
  type HistoryReceivingDependencies,
} from './receiving.ts';
import { commandHistoryIdentityAccounts, commandHistoryKind, unionHistoryScope } from './record.ts';

/** Exact original Accounts key, independent of a deletion generation or Semantic job. */
export type AgentIdentitySourceKey = Readonly<{
  route: number;
  accountId: string;
  direction: 'account-agent.verify' | 'account-agent.unverify';
  receiptId: string;
}>;
type Declaration = Readonly<{
  original: ReturnType<typeof import('../access/agent-verification-identity.ts').originalAccountIdentitySource>;
  accounts: readonly AccountReference[];
  kind: string;
}>;
const declarations = new WeakMap<CommandTransaction, Declaration>();
const serializing = new WeakSet<CommandTransaction>();
export const MAX_AGENT_IDENTITY_SOURCE_KEYS = 8;

export function agentIdentitySourceKey(key: AgentIdentitySourceKey): string {
  if (
    Object.keys(key).length !== 4 ||
    routeOf(key.accountId) !== key.route ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(key.accountId) ||
    !Number.isInteger(key.route) ||
    key.route < 0 ||
    key.route > 65535 ||
    !['account-agent.verify', 'account-agent.unverify'].includes(key.direction) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(key.receiptId)
  )
    throw new TypeError('Invalid original Agent identity source key');
  return JSON.stringify([key.route, key.accountId, key.direction, key.receiptId]);
}

/** DATA ownership only. The original native writer must already have issued this exact binding
 * on this transaction. Neither a historical read nor a caller assertion supplies source authority. */
export async function declareAgentIdentitySource(
  tx: CommandTransaction,
  key: AgentIdentitySourceKey,
  digest: string,
): Promise<void> {
  // Load the owner only for this family, without a command-bootstrap import cycle.
  // Validate after the yield so concurrent declarations still reserve atomically below.
  const { originalAccountIdentitySource } = await import('../access/agent-verification-identity.ts');
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
}

export function commandAgentIdentitySource(tx: CommandTransaction): Declaration | undefined {
  return declarations.get(tx);
}
export function beginAgentIdentitySerialization(tx: CommandTransaction): void {
  currentCommand(tx);
  serializing.add(tx);
}
export function releaseAgentIdentitySource(tx: CommandTransaction): void {
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

export type AgentIdentityCopyCursor = Readonly<{
  artifactType: 'command-receipt/v1' | 'outbox-event/v1';
  locator: Uint8Array;
}>;
export type AgentIdentityCopyPage = Readonly<{
  /** Enumeration is never an original inventory seal, source discharge or historical EOF proof. */
  state: 'pending';
  gap: 'agent-identity-original-inventory-unsealed';
  artifact: HistoryArtifact | null;
  cursor: AgentIdentityCopyCursor | null;
}>;

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
        state: 'pending',
        gap: 'agent-identity-original-inventory-unsealed',
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
  const page = await readAgentIdentityCopies(deps.pool, keys, context, after);
  const receipt = page.artifact ? await readHistoryReceivingReceipt(deps, barrier, page.artifact, context) : null;
  return { ...page, receipt };
}

/** Until the native identity owner discharges retention, this technical linkage is personal
 * inventory too. Existing minimizers must leave it pending rather than exempting its metadata. */
export async function agentIdentityCopyRetentionGap(
  tx: CommandTransaction,
  partition: number,
  type: HistoryArtifact['locator']['artifactType'],
  locator: Buffer,
): Promise<string | null> {
  const copy = await tx.query(
    `SELECT 1 FROM core.agent_identity_history_copy
     WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3 LIMIT 1`,
    [partition, type, locator],
  );
  return copy.rows.length ? 'agent-identity-source-retention-custody-pending' : null;
}
