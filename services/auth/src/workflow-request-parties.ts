import type { AccountWorkflowPorts, NativeCreationContext, NativeCreationContextRequest } from '@rezics/auth-contract';
import type { PoolClient } from 'pg';
import type { CopyRole } from './erasure-copy.ts';
import type { AccountOperation } from './workflows.ts';
import { readApprovedCreationContext } from './creation-party-context.ts';

export type NativeRequestActors = {
  human: string | null;
  initiator: string | null;
  delegate: string | null;
  version: number;
};
const refused = (): never => {
  throw Object.assign(new Error('Account workflow denied'), { status: 503 as const });
};
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024;

/** Resolve the complete original request on released leases, before the copy
 * writer checks out its SDK transaction. This projection grants no authority:
 * ordinary approve/execute and each protected step still resolve at current T. */
export async function readRequestCreationContext<Context>(
  access: Pick<AccountWorkflowPorts<Context>, 'readNativeCreationContext' | 'approvalBinding'>,
  context: Context | undefined,
  input: AccountOperation,
): Promise<NativeCreationContext> {
  if (
    context === undefined ||
    typeof access.readNativeCreationContext !== 'function' ||
    input.kind === 'transfer-acceptance' ||
    !('authorization' in input) ||
    typeof input.authorization !== 'string' ||
    !input.authorization ||
    input.authorization.length > 4096 ||
    !id(input.operationKey)
  )
    return refused();
  const binding = access.approvalBinding?.(context);
  if (!binding || binding.operationKey !== input.operationKey) return refused();
  const request: NativeCreationContextRequest = {
    approvalReference: input.authorization,
    operationKey: input.operationKey,
    operation: input,
  };
  return readApprovedCreationContext(access, request, binding);
}

/** Preserve any real verified context returned by the existing self-operation
 * authorization adapter. Its historical void result supplies no provenance. */
export async function authorizeUnprotectedRequest<Context>(
  access: AccountWorkflowPorts<Context>,
  input: AccountOperation,
): Promise<Context | undefined> {
  if (input.kind === 'transfer-acceptance') return refused();
  const context: unknown = await access.authorizeUnprotectedOperation?.(input);
  return context == null ? undefined : (context as Context);
}

export type RequestParties = {
  erasure_subject_id: string | null;
  erasure_human_id: string | null;
  erasure_operator_id: string | null;
  erasure_client_id: string | null;
  erasure_member_id: string | null;
  erasure_previous_operator_id: string | null;
  erasure_stage_id: string | null;
  erasure_initiator_id: string | null;
  erasure_delegate_id: string | null;
  erasure_actor_version: number;
  erasure_actor_id: string;
  erasure_principal_id: string | null;
  erasure_source_client_id: string;
  erasure_client_owner_id: string | null;
  erasure_source_client_owner_id: string | null;
  request_party_version: number;
  request_context_version: number;
};

/** Literal inventory of the original writer below. Registration is not a
 * consumer proof. These versions are checked by the database before a fresh
 * request can commit; old rows are never filled from current relationships. */
export const NATIVE_REQUEST_PARTY_PRODUCER = {
  table: 'auth_workflow_request',
  key: 'workflow_id',
  versions: { request_party_version: 1, request_context_version: 1, erasure_actor_version: 1 },
  accountPhases: [
    { kind: 'request', table: 'auth_workflow_request', role: 'erasure_actor_id' },
    { kind: 'request', table: 'auth_workflow_request', role: 'erasure_principal_id' },
  ],
  clientPhase: { table: 'auth_workflow_request', role: 'erasure_source_client_id' },
} as const;

// Payload/digest fields are deliberately excluded from scope reads.
export const REQUEST_PARTY_COLUMNS = `erasure_subject_id,erasure_human_id,erasure_operator_id,
  erasure_client_id,erasure_member_id,erasure_previous_operator_id,erasure_stage_id,
  erasure_initiator_id,erasure_delegate_id,erasure_actor_version,erasure_actor_id,
  erasure_principal_id,erasure_source_client_id,erasure_client_owner_id,
  erasure_source_client_owner_id,request_party_version,request_context_version`;

/** Approved business variants supply targets, not acting identities. Exhaustive
 * switching keeps new operations closed until their source projection is added. */
export function operationParties(input: AccountOperation, source: Pick<NativeCreationContext, 'operatorAccountId'>) {
  const base = {
    subject: null as string | null,
    operator: source.operatorAccountId,
    client: null as string | null,
    member: null as string | null,
    previous: null as string | null,
    stage: null as string | null,
  };
  switch (input.kind) {
    case 'rename':
    case 'revoke':
    case 'fence-operator':
      return { ...base, subject: input.accountId };
    case 'delete':
      return { ...base, subject: input.accountId, previous: input.responsibility?.operatorAccountId ?? null };
    case 'consent':
      return { ...base, subject: input.accountId, client: input.clientId };
    case 'membership':
      return { ...base, subject: input.organizationId, member: input.memberAccountId };
    case 'organization':
      return base; // Filled from the same preselected native target used by the operation.
    case 'automated':
      return { ...base, operator: input.operatorAccountId, stage: input.registrationId };
    case 'transfer':
      return {
        ...base,
        subject: input.previous.subjectAccountId,
        operator: input.operatorAccountId,
        previous: input.previous.operatorAccountId,
      };
    case 'client-reduction':
      return { ...base, client: input.clientId };
    case 'opening':
      return { ...base, subject: input.subjectAccountId, operator: input.operatorAccountId };
    case 'transfer-acceptance':
      return refused(); // Approval-only; never a workflow input.
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

/** Only immutable original columns participate in replay. In particular, never
 * read today's subject operator, client owner or stage to fill a historical row. */
export function requestPartyScope(row: RequestParties): CopyRole[] {
  if (row.request_party_version !== 1 || row.request_context_version !== 1 || row.erasure_actor_version !== 1)
    return refused();
  const roles: CopyRole[] = [];
  const add = (accountId: string | null, role: CopyRole['role']) => {
    if (accountId && !roles.some((item) => item.accountId === accountId && item.role === role))
      roles.push({ accountId, role });
  };
  add(row.erasure_subject_id, 'subject');
  add(row.erasure_human_id, 'human');
  add(row.erasure_operator_id, 'operator');
  add(row.erasure_member_id, 'member');
  add(row.erasure_previous_operator_id, 'previous-operator');
  add(row.erasure_initiator_id, 'initiator');
  add(row.erasure_delegate_id, 'delegate');
  add(row.erasure_client_owner_id, 'client-owner');
  add(row.erasure_source_client_owner_id, 'client-owner');
  // The installed SDK role vocabulary has no actor/principal labels. Require
  // their genuine native source roles, rather than inventing or renaming roles.
  for (const accountId of [row.erasure_actor_id, row.erasure_principal_id])
    if (accountId && !roles.some((role) => role.accountId === accountId)) return refused();
  return roles;
}

async function admitParties(connection: PoolClient, row: RequestParties) {
  const clients = [...new Set([row.erasure_client_id, row.erasure_source_client_id].filter(id))].sort();
  for (const client of clients) await connection.query('SELECT auth_erasure_admit_client($1)', [client]);
  const accounts = [
    ...new Set(
      [...requestPartyScope(row).map((role) => role.accountId), row.erasure_actor_id, row.erasure_principal_id].filter(
        id,
      ),
    ),
  ].sort();
  for (const account of accounts) await connection.query('SELECT auth_erasure_admit($1)', [account]);
}

/** Called by the copy writer on its own SDK transaction before it serializes
 * input. A fence, source failure or SDK refusal rolls back this request too. */
export async function captureWorkflowRequest(
  connection: PoolClient,
  options: {
    workflowId: string;
    input: AccountOperation;
    source: NativeCreationContext;
    organizationAccountId?: string;
    actors: NativeRequestActors;
    digest(): Buffer;
  },
): Promise<CopyRole[]> {
  const { workflowId, input, source, actors } = options;
  if (
    actors.version !== 1 ||
    actors.human !== source.actingHumanId ||
    actors.initiator !== source.actorAccountId ||
    actors.delegate !== source.principalAccountId
  )
    return refused();
  const original = async () =>
    (
      await connection.query<RequestParties & { digest: Buffer }>(
        `SELECT digest,${REQUEST_PARTY_COLUMNS} FROM auth_workflow_request WHERE workflow_id=$1 FOR UPDATE`,
        [workflowId],
      )
    ).rows[0];
  const replay = async (old: RequestParties & { digest: Buffer }) => {
    await admitParties(connection, old);
    if (!old.digest.equals(options.digest())) return refused();
    await connection.query('UPDATE auth_workflow_request SET request=$2 WHERE workflow_id=$1', [workflowId, input]);
    return requestPartyScope(old);
  };
  const old = await original();
  if (old) return replay(old);
  const target = operationParties(input, source);
  if (input.kind === 'organization') {
    if (!id(options.organizationAccountId)) return refused();
    target.subject = options.organizationAccountId;
  }
  if (input.kind === 'automated') {
    const stage = (
      await connection.query<{ account_id: string; erasure_operator_id: string | null }>(
        'SELECT account_id,erasure_operator_id FROM auth_registration_stage WHERE registration_id=$1 FOR KEY SHARE',
        [input.registrationId],
      )
    ).rows[0];
    if (!stage || stage.erasure_operator_id !== target.operator) return refused();
    target.subject = stage.account_id;
  }
  const row: RequestParties = {
    erasure_subject_id: target.subject,
    erasure_human_id: source.actingHumanId,
    erasure_operator_id: target.operator,
    erasure_client_id: target.client,
    erasure_member_id: target.member,
    erasure_previous_operator_id: target.previous,
    erasure_stage_id: target.stage,
    erasure_initiator_id: actors.initiator,
    erasure_delegate_id: actors.delegate,
    erasure_actor_version: actors.version,
    erasure_actor_id: source.actorAccountId,
    erasure_principal_id: source.principalAccountId,
    erasure_source_client_id: source.sourceClientId,
    erasure_client_owner_id: null,
    erasure_source_client_owner_id: null,
    request_party_version: 1,
    request_context_version: 1,
  };
  for (const clientId of [...new Set([target.client, source.sourceClientId].filter(id))].sort()) {
    await connection.query('SELECT auth_erasure_admit_client($1)', [clientId]);
    const client = (
      await connection.query<{ owner: string | null }>(
        'SELECT "userId" AS owner FROM auth_client WHERE client_id=$1 FOR SHARE',
        [clientId],
      )
    ).rows[0];
    if (!client) return refused();
    if (clientId === target.client) row.erasure_client_owner_id = client.owner;
    if (clientId === source.sourceClientId) row.erasure_source_client_owner_id = client.owner;
  }
  await admitParties(connection, row);
  // Neither the business digest nor pg's request JSON serialization occurs
  // until every original role/client has passed the actual current fences.
  const digest = options.digest();
  const inserted = await connection.query(
    `INSERT INTO auth_workflow_request (
      workflow_id,digest,request,erasure_subject_id,erasure_human_id,erasure_operator_id,
      erasure_client_id,erasure_member_id,erasure_previous_operator_id,erasure_stage_id,
      erasure_initiator_id,erasure_delegate_id,erasure_actor_version,erasure_actor_id,
      erasure_principal_id,erasure_source_client_id,erasure_client_owner_id,
      erasure_source_client_owner_id,request_party_version,request_context_version
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT(workflow_id) DO NOTHING RETURNING workflow_id`,
    [
      workflowId,
      digest,
      input,
      row.erasure_subject_id,
      row.erasure_human_id,
      row.erasure_operator_id,
      row.erasure_client_id,
      row.erasure_member_id,
      row.erasure_previous_operator_id,
      row.erasure_stage_id,
      row.erasure_initiator_id,
      row.erasure_delegate_id,
      row.erasure_actor_version,
      row.erasure_actor_id,
      row.erasure_principal_id,
      row.erasure_source_client_id,
      row.erasure_client_owner_id,
      row.erasure_source_client_owner_id,
      row.request_party_version,
      row.request_context_version,
    ],
  );
  if (!inserted.rowCount) {
    // The primary-key conflict serialized a simultaneous first submit. Retain
    // the winner's original parties, then recheck them before SDK serialization.
    const winner = await original();
    if (!winner) return refused();
    return replay(winner);
  }
  return requestPartyScope(row);
}
