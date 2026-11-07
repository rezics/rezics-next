import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime, CommandAuthorization, CommandTransaction } from '../command/command.ts';

/** Seeded Global Context identity. Directory and lifecycle treat this row as non-personal. */
export const CONTEXT_GLOBAL_ID = '00000000-0000-8000-8000-000000000000';

export type ContextQueryClient = Pick<PoolClient, 'query'>;
/** Installed Access object; composition binds the native evaluator. */
export type ContextAccessHandle = object;
export type ContextAccountActor = {
  kind: 'account';
  accountId: string;
  clientId: string;
  scopes: readonly string[];
  requestedBy: string | null;
  authnEpoch: number;
};
export type ContextActor = ContextAccountActor | { kind: 'anonymous' };
export type ContextResource = { route: number; id: string };
export type ContextAccountSnapshot = { state: string; fenced: boolean };
export type ContextSourceDisposition = 'removed' | 'retained-nonpersonal' | null;
export type ContextCopyRole = { account_id: string; role: string };
export type ContextReadDecision = { allowed: boolean };
export type ContextReadEligibility = (
  client: ContextQueryClient,
  ids: readonly string[],
  at: string,
) => Promise<Readonly<Record<string, boolean>>>;
export type ContextReadDecisionInput = Readonly<{
  action: string;
  resourceType: string;
  ids: readonly string[];
  eligibility?: ContextReadEligibility;
}>;
export type ContextReadDecisions = Readonly<{
  decide(
    client: ContextQueryClient,
    input: ContextReadDecisionInput,
    time: AuthoritativeTime,
  ): Promise<Readonly<Record<string, ContextReadDecision>>>;
}>;
export type ContextReadBudget = Readonly<{ pool: Pool; deadline: number }>;
export type ContextParentAnchor = Readonly<{
  resource: Readonly<ContextResource>;
  resourceType?: string;
  validate(client: ContextQueryClient, time: AuthoritativeTime): Promise<boolean>;
}>;
export type ContextPublicEligibilityPrepare<E> = Readonly<{
  pool: Pool;
  resource: ContextResource;
}>;
export type ContextPublicEligibilityVerify<E> = Readonly<{
  client: ContextQueryClient;
  resource: ContextResource;
  evidence: E;
}>;
export type ContextRoleOccurrenceInput = Readonly<{
  occurrence: string;
  resourceId: string;
  resourceType: 'semantic.context';
  originalCreator: string;
  accountId: string;
  grantRole: string;
  valid: string | null;
  side: 'creator' | 'new' | 'former';
  grantTransaction: string | null;
  sourceTransaction: string;
}>;
export type ContextDirectoryEntry = {
  id: string;
  kind: 'global' | 'community';
  labels: Record<string, string>;
  state: 'active' | 'deleted';
  deletedAt: string | null;
  purgeAfter: string | null;
};
export type ContextDirectoryPage = { contexts: ContextDirectoryEntry[]; next: string | null };
export type ContextDirectoryRead = { actor: ContextActor; deadline: number };
export type ContextDirectoryQuery = { query?: string; limit?: number; cursor?: string; deleted?: boolean };
export class ContextDirectoryPreparingError extends Error {
  constructor() {
    super('Context directory is preparing');
  }
}

/** Semantic-owned Access authorization, snapshot, eligibility and Source-erasure operations. */
export type ContextAccessPort = Readonly<{
  deadlineClient(client: ContextQueryClient, deadline: number): ContextQueryClient;
  requireDeadline(deadline: number): void;
  withReadTransaction<T>(pool: Pool, read: (client: ContextQueryClient) => Promise<T>, deadline?: number): Promise<T>;
  prepareReadDecisions(
    access: ContextAccessHandle,
    input: Readonly<{
      actor: ContextActor;
      actions: ReadonlySet<string>;
      context: ContextReadBudget;
    }>,
  ): Promise<ContextReadDecisions>;
  viewerActionReadTime(access: ContextAccessHandle, context: ContextReadBudget): AuthoritativeTime;
  resourceAuthorization(input: {
    access: ContextAccessHandle;
    actor: ContextAccountActor;
    action: string;
    anchor: ContextParentAnchor;
    context: ContextReadBudget & { partition: number };
  }): CommandAuthorization;
  initializeResourceGrants(
    tx: CommandTransaction,
    input: { resource: ContextResource; type: string; creator: string },
  ): Promise<void>;
  createPublicEligibility<E extends {}>(options: {
    resource: ContextResource;
    action: string;
    prepare(context: ContextPublicEligibilityPrepare<E>): Promise<E | null | undefined>;
    verify(context: ContextPublicEligibilityVerify<E>): Promise<boolean>;
  }): unknown;
  readAccount(client: ContextQueryClient, route: number, accountId: string): Promise<ContextAccountSnapshot | null>;
  requestInvalid(): Error;
  notFound(): Error;
  lifecycleDenied(): Error;
  refreshErasureSourceRecord(
    pool: Pool,
    accountId: string,
    partition: number,
    key: Readonly<{ store: string; recordKey: string; role: string; deliveryPosition: string; originKey?: string }>,
  ): Promise<void>;
  readSourceDisposition(tx: CommandTransaction, store: string, key: string): Promise<ContextSourceDisposition>;
  recordSourceDisposition(
    tx: CommandTransaction,
    store: string,
    recordKey: string,
    disposition: Exclude<ContextSourceDisposition, null>,
  ): void;
  recordSourceCommit(tx: CommandTransaction, transactionId: string): Promise<void>;
}>;

let bound: ContextAccessPort | undefined;

/** Process binding for standalone compatibility calls; application instances receive their port directly. */
export function bindContextAccess(port: ContextAccessPort): ContextAccessPort {
  bound = port;
  return port;
}

export function contextAccess(): ContextAccessPort {
  if (!bound) throw new Error('Context Access port is not bound');
  return bound;
}

export function tryContextAccess(): ContextAccessPort | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel rebinds the native port. */
export function unbindContextAccess(): void {
  bound = undefined;
}
