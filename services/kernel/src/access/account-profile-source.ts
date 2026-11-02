import type { Pool } from 'pg';
import {
  AUTH_MANAGEMENT_CLIENT_ID,
  AUTH_MANAGEMENT_SCOPES,
  type AuthSessionPort,
  type SessionProof,
} from '@rezics/auth-contract';
import type { Access } from '../request/access.ts';
import { readEditableAccountProfile } from './account-edit-profile.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import { requireAccessDeadline } from './unavailable.ts';

export type RenameAccountProfile = { profile: { id: string; kind: 'actor'; handle: string | null } };
/** Producer-owned private seam until generated bindings expose this read.
 * The human is a live Auth proof supplied by the issuer, never browser JSON. */
export interface AccountProfileAccess {
  readRenameAccountProfile(input: {
    human: SessionProof;
    accountId: string;
    deadline: number;
  }): Promise<RenameAccountProfile>;
}

export function createAccountProfileAccess(deps: {
  pool: Pool;
  access: Access;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): AccountProfileAccess {
  return {
    async readRenameAccountProfile({ human, accountId, deadline }) {
      requireAccessDeadline(deadline);
      if (
        accountId !== human.account_id ||
        human.client_id !== AUTH_MANAGEMENT_CLIENT_ID ||
        JSON.stringify(human.scope) !== JSON.stringify(AUTH_MANAGEMENT_SCOPES.rename) ||
        human.amr.length !== 1 ||
        (human.amr[0] !== 'pwd' && human.amr[0] !== 'pop')
      )
        throw new AuthBindingDeniedError();
      const context = { pool: deps.pool, deadline };
      const actor = await deps.access.authenticate(await deps.accessTokenForProof(human), context);
      if (
        actor.kind !== 'account' ||
        actor.accountId !== accountId ||
        actor.clientId !== human.client_id ||
        actor.authnEpoch !== human.authn_epoch ||
        actor.requestedBy !== null ||
        JSON.stringify(actor.scopes) !== JSON.stringify(human.scope)
      )
        throw new AuthBindingDeniedError();
      // Identical source and native account:update profile formula to
      // GET /v1/accounts/{accountId}/profile, including current authority/floor.
      const { profile } = await readEditableAccountProfile(deps.access, { ...context, actor }, accountId);
      if (profile.id !== accountId || profile.kind !== 'actor') throw new AuthBindingDeniedError();
      requireAccessDeadline(deadline);
      return { profile: { id: profile.id, kind: 'actor', handle: profile.handle } };
    },
  };
}
