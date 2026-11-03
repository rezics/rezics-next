import { captureAgentIdentityInventory, finalizeAgentIdentityInventory } from './agent-identity-inventory.ts';
import { hasCommandRecordSourceSet } from './record-source-set.ts';
import {
  commandAgentIdentitySource,
  recordAgentIdentityCopy,
  releaseAgentIdentitySource,
} from './agent-identity-source.ts';
import type { CommandTransaction } from '../command/command.ts';
import { currentCommand } from '../command/command.ts';
import { ACCOUNT_ROLE_BITS, classifyEvent } from './contracts.ts';
import { encodeLocator, validateScope, type AccountReference, type HistoryScope } from './locator.ts';
import { guardHistoryAccounts } from './gates.ts';
import insert from './record.sql';
import {
  beginRecordHistorySerialization,
  commandRecordSources,
  recordRecordHistoryCopy,
  releaseCommandRecordSources,
} from './record-source.ts';

/** Permanent numeric namespace. Append explicit IDs; never assign IDs by registration order. */
export const COMMAND_HISTORY_KINDS = Object.freeze({
  'access.account.preferences': 1,
  'library.entry.retention.purge': 2,
  'access.agent-verification.pending': 3,
  'access.agent-verification.released': 4,
  'access.agent-verification.revoked': 5,
  'access.agent-verification.deleted': 6,
  'access.agent-identity.recover': 7,
  'content.board.watch': 8,
  'content.watch.remove': 9,
});
export type CommandHistoryKind = string;
const commandKinds = new Map<string, number>(Object.entries(COMMAND_HISTORY_KINDS));
/** Startup-only receiving port. IDs are permanent owner-assigned values, never registration ordinals. */
export function registerCommandHistoryKind(kind: string, id: number): void {
  if (
    !/^[a-z][a-z0-9_:.-]{0,95}$/.test(kind) ||
    !Number.isInteger(id) ||
    id < 1000 ||
    id > 0xffffffff ||
    commandKinds.has(kind) ||
    [...commandKinds.values()].includes(id)
  )
    throw new TypeError('Invalid or duplicate permanent history command kind');
  commandKinds.set(kind, id);
}
export function commandHistoryKind(id: number): string | undefined {
  return [...commandKinds].find(([, value]) => value === id)?.[0];
}
export const COMMAND_HISTORY_COVERAGE = Object.freeze({
  delivered: Object.freeze([
    'access.account.preferences',
    'library.entry.retention.purge',
    'content.board.watch',
    'content.watch.remove',
  ]),
  missing: Object.freeze([
    'other command producer and consumer conversion',
    'complete outbox producer and consumer coverage',
    'pre-serialization scoped durable execution and owner conversion',
    'historical producer and aggregate routing coverage',
  ]),
  complete: false,
});
export const MAX_HISTORY_PAYLOAD_BYTES = 65_536;
export type CommandHistoryScopes = Readonly<{ response: HistoryScope; events: readonly HistoryScope[] }>;
type Declaration = CommandHistoryScopes & { kind: CommandHistoryKind; partition: number };
const identities = new WeakMap<CommandTransaction, readonly AccountReference[]>();
const declarations = new WeakMap<CommandTransaction, Declaration>();

/** Access calls this only with opaque verified permission evidence, once per executor attempt.
 * This server module is never an HTTP JSON input or an alternate permission evaluator. */
export function bindCommandHistoryEvidence(tx: CommandTransaction, accounts: readonly AccountReference[]): void {
  identities.set(tx, structuredClone(accounts));
}

/** The already verified evidence for this attempt, used only to enroll native data roles. */
export function commandHistoryIdentityAccounts(tx: CommandTransaction): readonly AccountReference[] {
  return structuredClone(identities.get(tx) ?? []);
}

export function unionHistoryScope(
  type: HistoryScope['artifactType'],
  ...groups: readonly (readonly AccountReference[])[]
): HistoryScope {
  const accounts = new Map<string, AccountReference>();
  for (const group of groups)
    for (const ref of group) {
      const previous = accounts.get(ref.accountId);
      if (previous && previous.accountRoute !== ref.accountRoute) throw new TypeError('History account route mismatch');
      accounts.set(ref.accountId, { ...ref, roles: ref.roles | (previous?.roles ?? 0) });
      if (accounts.size > 64) throw new TypeError('Too many distinct history account references');
    }
  return validateScope(type, { artifactType: type, accounts: [...accounts.values()] });
}

/** Native owners declare subjects/related parties before their first write. Automatic identity
 * roles are separate and come from the authorization that admitted this exact attempt. */
export async function declareCommandHistory(
  tx: CommandTransaction,
  kind: CommandHistoryKind,
  scopes: CommandHistoryScopes,
): Promise<void> {
  const command = currentCommand(tx);
  if (!commandKinds.has(kind) || declarations.has(tx))
    throw new TypeError('Invalid or repeated command history declaration');
  const identity = identities.get(tx);
  if (!identity) throw new TypeError('Missing command history evidence: verified actor/principal/human/delegate');
  if (scopes.events.length > 1000) throw new TypeError('Too many history event scopes');
  const response = unionHistoryScope(
    'command-receipt/v1',
    validateScope('command-receipt/v1', scopes.response).accounts,
    identity,
  );
  const events = scopes.events.map((scope) =>
    unionHistoryScope('outbox-event/v1', validateScope('outbox-event/v1', scope).accounts, identity),
  );
  // The cap applies to the entire production unit, not independently to each artifact.
  const all = unionHistoryScope('command-receipt/v1', response.accounts, ...events.map((scope) => scope.accounts));
  await guardHistoryAccounts(tx, command.partition, all.accounts);
  declarations.set(tx, { kind, partition: command.partition, response, events });
}

export function validateCommandHistoryScope(
  tx: CommandTransaction,
  kind: string | undefined,
  events: readonly { type: string }[],
): void {
  captureAgentIdentityInventory(tx, kind, events);
  beginRecordHistorySerialization(tx);
  const identitySource = commandAgentIdentitySource(tx);
  if (identitySource) {
    if (declarations.has(tx) || identitySource.kind !== kind)
      throw new TypeError('Conflicting original identity command history declaration');
    declarations.set(tx, {
      kind: identitySource.kind,
      partition: currentCommand(tx).partition,
      response: { artifactType: 'command-receipt/v1', accounts: identitySource.accounts },
      events: events.map(() => ({ artifactType: 'outbox-event/v1', accounts: identitySource.accounts })),
    });
  }
  const declaration = declarations.get(tx);
  if (!declaration && (commandRecordSources(tx).length || hasCommandRecordSourceSet(tx)))
    throw new TypeError('Record sources require native command history serialization');
  if (!declaration && (kind === undefined || !commandKinds.has(kind))) return;
  if (!declaration || declaration.kind !== kind || declaration.events.length !== events.length)
    throw new TypeError('Missing or mismatched command history declaration');
  for (const event of events) classifyEvent(event.type);
}

export function validateCommandHistory(
  tx: CommandTransaction,
  kind: string | undefined,
  response: unknown,
  events: readonly unknown[],
): void {
  const declaration = declarations.get(tx);
  if (!declaration && (commandRecordSources(tx).length || hasCommandRecordSourceSet(tx)))
    throw new TypeError('Record sources require native command history serialization');
  if (!declaration && (kind === undefined || !commandKinds.has(kind))) return;
  if (!declaration || declaration.kind !== kind || declaration.events.length !== events.length)
    throw new TypeError('Missing or mismatched command history declaration');
  for (const payload of [response, ...events]) {
    const json = JSON.stringify(payload);
    if (json === undefined || Buffer.byteLength(json) > MAX_HISTORY_PAYLOAD_BYTES)
      throw new TypeError('History payload exceeds the 64 KiB limit');
  }
}

/** Called only after the native fence has produced its actual persisted position, before COMMIT. */
export async function recordCommandHistory(
  tx: CommandTransaction,
  input: {
    principal: { kind: 'account' | 'anonymous'; id: string };
    kind: string;
    storageKey: string;
    position: bigint;
  },
): Promise<void> {
  const declaration = declarations.get(tx);
  if (!declaration) return;
  // Consume the actual receipt codec's persisted rk1 representation; never derive a second HMAC.
  const [namespace, version, mac] = input.storageKey.split('.');
  const token = Buffer.from(mac ?? '', 'base64url');
  if (namespace !== 'rk1' || !/^(0|[1-9]\d*)$/.test(version ?? '') || Number(version) > 255 || token.length !== 32)
    throw new TypeError('History requires a native tokenized receipt key');
  const receipt = encodeLocator({
    artifactType: 'command-receipt/v1',
    partitionNo: declaration.partition,
    principalKind: input.principal.kind,
    principalId: input.principal.id.toLowerCase(),
    commandKindId: commandKinds.get(declaration.kind)!,
    keyVersion: Number(version),
    keyToken: token.toString('hex'),
  });
  const write = async (scope: HistoryScope, locator: Uint8Array) => {
    await insert.run(tx, {
      partition_no: declaration.partition,
      artifact_type: scope.artifactType,
      locator: Buffer.from(locator),
      accounts: scope.accounts,
    });
    const { decodeLocator } = await import('./locator.ts');
    const nativeLocator = decodeLocator(scope.artifactType, locator);
    await recordRecordHistoryCopy(tx, nativeLocator, input.position);
    await recordAgentIdentityCopy(
      tx,
      {
        partition: declaration.partition,
        locator: nativeLocator,
        accounts: scope.accounts,
      },
      input.position,
    );
  };
  await write(declaration.response, receipt);
  for (let eventSeq = 0; eventSeq < declaration.events.length; eventSeq++)
    await write(
      declaration.events[eventSeq]!,
      encodeLocator({
        artifactType: 'outbox-event/v1',
        partitionNo: declaration.partition,
        position: input.position,
        eventSeq,
      }),
    );
  await finalizeAgentIdentityInventory(tx, input.position);
}

export function releaseCommandHistory(tx: CommandTransaction): void {
  releaseAgentIdentitySource(tx);
  releaseCommandRecordSources(tx);
  identities.delete(tx);
  declarations.delete(tx);
}

export const preferenceSubjectScope = (accountRoute: number, accountId: string): CommandHistoryScopes => ({
  response: {
    artifactType: 'command-receipt/v1',
    accounts: [{ accountRoute, accountId, roles: ACCOUNT_ROLE_BITS.subject }],
  },
  events: [
    { artifactType: 'outbox-event/v1', accounts: [{ accountRoute, accountId, roles: ACCOUNT_ROLE_BITS.subject }] },
  ],
});
