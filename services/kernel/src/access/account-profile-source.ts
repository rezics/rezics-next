import type { Pool } from 'pg';
import {
  AUTH_MANAGEMENT_CLIENT_ID,
  AUTH_MANAGEMENT_SCOPES,
  type AuthSessionPort,
  type SessionProof,
} from '@rezics/auth-contract';
import type { Access } from '../request/access.ts';
import { viewerActionReadTime } from './index.ts';
import { readEditableAccountProfile } from './account-edit-profile.ts';
import { readManagedAuthActions } from './account-management-auth-actions.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineClient } from './authenticate.ts';
import { routeOf } from '../route/route.ts';
import { readAccount } from './account-data.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import { requireAccessDeadline } from './unavailable.ts';
import type { AccountManagementPage } from './account-management.ts';

export type RenameAccountProfile = { profile: { id: string; kind: 'actor'; handle: string | null } };
export type RenameAccountPage = {
  viewer: { accountId: string; kind: 'actor' };
  profile: RenameAccountProfile['profile'];
  authActions: NonNullable<AccountManagementPage['authActions']>;
};
/** Producer-owned private seam until generated bindings expose this read.
 * The human is a live Auth proof supplied by the issuer, never browser JSON. */
export interface AccountProfileAccess {
  readRenameAccountProfile(input: {
    human: SessionProof;
    accountId: string;
    deadline: number;
  }): Promise<RenameAccountProfile>;
}

export interface RenameAccountPageAccess {
  readRenameAccountPage(input: {
    human: SessionProof;
    accountId: string;
    deadline: number;
  }): Promise<RenameAccountPage>;
}

type ProfileAccess = AccountProfileAccess & RenameAccountPageAccess;

export function createAccountProfileAccess(deps: {
  pool: Pool;
  access: Access;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): ProfileAccess {
  async function admittedActor(human: SessionProof, accountId: string, deadline: number) {
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
    return { actor, context };
  }
  async function closedProfile(human: SessionProof, accountId: string, deadline: number) {
    const { actor, context } = await admittedActor(human, accountId, deadline);
    const profileContext = { ...context, actor };
    // Identical source and native account:update profile formula to the existing
    // exact-ID read, including current authority and floor.
    const { profile } = await readEditableAccountProfile(deps.access, profileContext, accountId);
    if (profile.id !== accountId || profile.kind !== 'actor') throw new AuthBindingDeniedError();
    requireAccessDeadline(deadline);
    return {
      actor,
      context: profileContext,
      profile: { id: profile.id, kind: 'actor' as const, handle: profile.handle },
    };
  }
  return {
    async readRenameAccountProfile({ human, accountId, deadline }) {
      return { profile: (await closedProfile(human, accountId, deadline)).profile };
    },
    async readRenameAccountPage({ human, accountId, deadline }) {
      const { actor, context, profile } = await closedProfile(human, accountId, deadline);
      const route = routeOf(accountId);
      if (route === null) throw new AuthBindingDeniedError();
      const currentAccount = await withConnection(deps.pool, (connection) =>
        readAccount(deadlineClient(connection, deadline), route, accountId),
      );
      if (!currentAccount || currentAccount.kind !== 'actor' || currentAccount.operatorAccountId !== null)
        throw new AuthBindingDeniedError();
      const authActions = await readManagedAuthActions(
        { pool: deps.pool, access: deps.access },
        actor,
        { account: currentAccount, relation: null },
        { deadline, time: viewerActionReadTime(deps.access, context) },
      );
      requireAccessDeadline(deadline);
      return {
        viewer: { accountId: actor.accountId, kind: 'actor' },
        profile,
        authActions,
      };
    },
  };
}
