import type { Pool } from 'pg';
import { managementOperationProfile, type AuthSessionPort, type SessionProof } from '@rezics/auth-contract';
import type { Access } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { readAccount } from './account-data.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import { deadlineClient, within } from './authenticate.ts';
import { readOperatorTransferState, ManagementSourceRefusedError } from './management-source.ts';
import { requireAccessDeadline } from './unavailable.ts';

export type OperatorOpeningPage = {
  stage: 'current';
  viewer: { accountId: string };
  subject: { id: string; kind: 'actor' };
  operator: { id: string; kind: 'actor' | 'organization' };
  relation: { reservationId: string; version: string };
  disclosure: 'unavailable';
  allowedActions: ['opening'];
};
export interface OperatorOpeningPageAccess {
  readOperatorOpeningPage(input: {
    human: SessionProof;
    subjectAccountId: string;
    operatorAccountId: string;
    deadline: number;
  }): Promise<OperatorOpeningPage | null>;
}

/** Advice only. Two unchanged native management observations surround one exact
 * installed operator-kind read. No approval, credential staging or command runs.
 * The manage-only client cannot acquire account:read for presentation labels.
 * Static bound: one authentication, two existing bounded relation reads and one
 * full-key account read, all sharing a ten-second transport deadline. */
export function createOperatorOpeningPageAccess(deps: {
  pool: Pool;
  access: Access;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): OperatorOpeningPageAccess {
  return {
    async readOperatorOpeningPage({ human, subjectAccountId, operatorAccountId, deadline }) {
      return within(deadline, async () => {
        requireAccessDeadline(deadline);
        const profile = managementOperationProfile('opening');
        if (
          human.client_id !== profile.client_id ||
          JSON.stringify(human.scope) !== JSON.stringify(profile.scope) ||
          human.amr.length !== 1 ||
          !['pwd', 'pop'].includes(human.amr[0]!)
        )
          throw new AuthBindingDeniedError();
        const context = { pool: deps.pool, deadline };
        const actor = await deps.access.authenticate(await deps.accessTokenForProof(human), context);
        if (
          actor.kind !== 'account' ||
          actor.accountId !== human.account_id ||
          actor.clientId !== human.client_id ||
          actor.authnEpoch !== human.authn_epoch ||
          actor.requestedBy !== null ||
          JSON.stringify(actor.scopes) !== JSON.stringify(human.scope)
        )
          throw new AuthBindingDeniedError();
        const before = await readOperatorTransferState(deps, actor, { subjectAccountId }, context);
        if (!before || before.previous.operatorAccountId !== operatorAccountId) return null;
        const route = routeOf(operatorAccountId);
        if (route === null) throw new AuthBindingDeniedError();
        const operator = await withConnection(deps.pool, (client) =>
          readAccount(deadlineClient(client, deadline), route, operatorAccountId),
        );
        const current = await readOperatorTransferState(deps, actor, { subjectAccountId }, context);
        if (JSON.stringify(before) !== JSON.stringify(current)) throw new ManagementSourceRefusedError('stale');
        if (
          !operator ||
          !['actor', 'organization'].includes(operator.kind) ||
          operator.state !== 'active' ||
          operator.fenced ||
          operator.operatorAccountId !== null
        )
          throw new ManagementSourceRefusedError('denied');
        requireAccessDeadline(deadline);
        return {
          stage: 'current',
          viewer: { accountId: human.account_id },
          subject: { id: subjectAccountId, kind: 'actor' },
          operator: { id: operatorAccountId, kind: operator.kind as 'actor' | 'organization' },
          relation: { reservationId: before.previous.reservationId, version: before.expectedVersion },
          disclosure: 'unavailable',
          allowedActions: ['opening'],
        };
      });
    },
  };
}
