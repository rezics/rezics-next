import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  operationParties,
  readRequestCreationContext,
  requestPartyScope,
  type NativeCreationContext,
  type RequestParties,
} from '../src/workflow-request-parties.ts';
import type { AccountOperation, AccountWorkflowPorts } from '../src/workflows.ts';
import { failNativeQueries, nativeFixture } from './support/erasure-native.ts';

const source: NativeCreationContext = {
  version: 1,
  actorAccountId: 'actor',
  actingHumanId: 'human',
  operatorAccountId: 'source-operator',
  principalAccountId: 'principal',
  clientId: 'source-client',
  commandKey: 'original-command',
};
const previous = { subjectAccountId: 'subject', operatorAccountId: 'old-operator', reservationId: 'reservation' };
const authorization = 'approval';

describe('closed request projection', () => {
  test('every existing approved variant keeps explicit targets independently of the verified source identities', () => {
    const variants: [AccountOperation, Partial<ReturnType<typeof operationParties>>][] = [
      [
        { kind: 'rename', accountId: 'subject', handle: 'handle', expectedHandle: null, authorization },
        { subject: 'subject' },
      ],
      [{ kind: 'revoke', accountId: 'subject' }, { subject: 'subject' }],
      [{ kind: 'fence-operator', accountId: 'subject', authorization }, { subject: 'subject' }],
      [
        { kind: 'delete', accountId: 'subject', responsibility: previous, authorization },
        { subject: 'subject', previous: 'old-operator' },
      ],
      [
        { kind: 'consent', accountId: 'subject', clientId: 'target-client', scopes: [], authorization },
        { subject: 'subject', client: 'target-client' },
      ],
      [
        {
          kind: 'membership',
          organizationId: 'organization',
          memberAccountId: 'member',
          role: 'member',
          authorization,
        },
        { subject: 'organization', member: 'member' },
      ],
      [{ kind: 'organization', handle: 'handle', authorization }, { subject: null }],
      [
        { kind: 'automated', registrationId: 'stage', operatorAccountId: 'operator', authorization },
        { stage: 'stage', operator: 'operator' },
      ],
      [
        { kind: 'transfer', previous, expectedVersion: '1', operatorAccountId: 'new-operator', authorization },
        { subject: 'subject', previous: 'old-operator', operator: 'new-operator' },
      ],
      [
        { kind: 'client-reduction', clientId: 'target-client', scopes: [], firstParty: true, authorization },
        { client: 'target-client' },
      ],
      [
        { kind: 'opening', subjectAccountId: 'subject', operatorAccountId: 'operator', authorization },
        { subject: 'subject', operator: 'operator' },
      ],
    ];
    for (const [operation, expected] of variants) expect(operationParties(operation, source)).toMatchObject(expected);
    expect(() =>
      operationParties(
        {
          kind: 'transfer-acceptance',
          previous,
          expectedVersion: '1',
          operatorAccountId: 'new-operator',
          sourceOperationKey: 'key',
          authorization,
        },
        source,
      ),
    ).toThrow();
  });

  test('a missing producer cannot be replaced by actor-only or JSON provenance', async () => {
    const access = { actorAccountId: () => 'actor' } as unknown as AccountWorkflowPorts;
    await expect(readRequestCreationContext(access, { actor: { accountId: 'actor' } })).rejects.toThrow();
    await expect(readRequestCreationContext(access, undefined)).rejects.toThrow();
  });

  test('immutable replay scope preserves genuine native roles, and unknown context stays pending', () => {
    const row: RequestParties = {
      erasure_subject_id: 'subject',
      erasure_human_id: 'human',
      erasure_operator_id: 'new-operator',
      erasure_member_id: 'member',
      erasure_previous_operator_id: 'old-operator',
      erasure_stage_id: null,
      erasure_client_id: 'target-client',
      erasure_client_owner_id: 'original-owner',
      erasure_source_client_id: 'source-client',
      erasure_source_client_owner_id: 'source-owner',
      erasure_initiator_id: 'actor',
      erasure_delegate_id: 'principal',
      erasure_actor_version: 1,
      erasure_actor_id: 'actor',
      erasure_principal_id: 'principal',
      request_party_version: 1,
      request_context_version: 1,
    };
    expect(requestPartyScope(row)).toEqual([
      { accountId: 'subject', role: 'subject' },
      { accountId: 'human', role: 'human' },
      { accountId: 'new-operator', role: 'operator' },
      { accountId: 'member', role: 'member' },
      { accountId: 'old-operator', role: 'previous-operator' },
      { accountId: 'actor', role: 'initiator' },
      { accountId: 'principal', role: 'delegate' },
      { accountId: 'original-owner', role: 'client-owner' },
      { accountId: 'source-owner', role: 'client-owner' },
    ]);
    expect(() => requestPartyScope({ ...row, request_context_version: 0 })).toThrow();
    expect(() => requestPartyScope({ ...row, request_party_version: 0 })).toThrow();
    expect(() => requestPartyScope({ ...row, erasure_initiator_id: null })).toThrow();
    expect(() => requestPartyScope({ ...row, erasure_delegate_id: null })).toThrow();
  });
});

// Uses the actual approved native producer. Until Access composes its projection,
// this positive scenario intentionally cannot certify a fabricated successful copy.
describe('native request producer', () => {
  let f: Awaited<ReturnType<typeof nativeFixture>>;
  beforeAll(async () => {
    f = await nativeFixture();
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  }, 120_000);

  test('Native workflow request complete party capture before serialization', async () => {
    const person = await f.person('request-parties');
    const account = await f.bindings.workflowPorts.readAccount(person.accountId);
    const operationKey = randomUUID();
    const operation = {
      kind: 'rename',
      accountId: person.accountId,
      handle: `party_${randomUUID().replaceAll('-', '')}`,
      expectedHandle: account!.handle,
    };
    const approved = await f.call('/account-operations/approve', { operationKey, operation }, person.cookie);
    expect(approved.status).toBe(200);
    const { reference } = (await approved.json()) as { reference: string };
    const workflowId = `accounts:${createHash('sha256')
      .update(JSON.stringify(`operation:${operationKey}`))
      .digest('hex')}`;
    const restore = failNativeQueries(f.pool, (sql) => sql.includes('INSERT INTO auth_copy_work'));
    try {
      const failure = await f.call(
        '/account-operations/execute',
        { operationKey, operation, reference },
        person.cookie,
      );
      expect(failure.status).toBe(503);
    } finally {
      restore();
    }
    for (const table of ['auth_workflow_request', 'auth_copy_work'])
      expect((await f.pool.query(`SELECT 1 FROM ${table} WHERE workflow_id=$1`, [workflowId])).rowCount).toBe(0);
    expect(
      (await f.pool.query('SELECT 1 FROM auth_dbos.workflow_status WHERE workflow_uuid=$1', [workflowId])).rowCount,
    ).toBe(0);
    const response = await f.call('/account-operations/execute', { operationKey, operation, reference }, person.cookie);
    expect(response.status).toBe(200);
    const row = (await f.pool.query('SELECT * FROM auth_workflow_request WHERE workflow_id=$1', [workflowId])).rows[0]!;
    expect(row).toMatchObject({
      erasure_subject_id: person.accountId,
      erasure_actor_id: person.accountId,
      erasure_human_id: person.accountId,
      erasure_initiator_id: person.accountId,
      erasure_principal_id: null,
      erasure_delegate_id: null,
      erasure_operator_id: null,
      erasure_member_id: null,
      erasure_previous_operator_id: null,
      erasure_source_client_id: 'erasure-web',
      request_party_version: 1,
      request_context_version: 1,
    });
    const replay = await f.call('/account-operations/execute', { operationKey, operation, reference }, person.cookie);
    expect(replay.status).toBe(200);
    const after = (await f.pool.query('SELECT * FROM auth_workflow_request WHERE workflow_id=$1', [workflowId]))
      .rows[0]!;
    expect(after).toEqual(row);
    await expect(
      f.pool.query('UPDATE auth_workflow_request SET erasure_principal_id=$2 WHERE workflow_id=$1', [
        workflowId,
        person.accountId,
      ]),
    ).rejects.toThrow('Auth request parties are immutable');
  }, 120_000);
});
