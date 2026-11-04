import type { SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { closedProfile, isExactRenameProfile } from './account-profile-read-transport.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

type NativeRenamePage = {
  viewer: { accountId: string; kind: 'actor' };
  profile: { id: string; kind: 'actor'; handle: string | null };
  authActions:
    | {
        state: 'ready';
        operations: {
          operationId: string;
          action: string;
          resource: { route: number; id: string };
        }[];
      }
    | { state: 'unavailable' };
};

/** Producer-owned bounded seam. It is reached only after Auth admits the exact rename profile. */
export interface AccountRenamePageAccess {
  readRenameAccountPage(input: {
    human: SessionProof;
    accountId: string;
    deadline: number;
  }): Promise<NativeRenamePage>;
}

type RenamePageBody =
  | { state: 'signed-out' }
  | { state: 'management-auth-required'; continuation: { kind: 'management-operation-step-up'; operation: 'rename' } }
  | { state: 'refused' }
  | { state: 'unavailable' }
  | {
      state: 'ready';
      viewer: {
        accountId: string;
        clientId: string;
        scopes: string[];
        kind: 'actor';
        authnEpoch: number;
        authTime: number;
        amr: ('pwd' | 'pop')[];
      };
      profile: { id: string; kind: 'actor'; handle: string | null };
      authActions:
        | {
            state: 'ready';
            operations: {
              operationId: string;
              action: string;
              resource: { route: number; id: string };
            }[];
          }
        | { state: 'unavailable' };
    };

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(value)?.[0] === value;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Close native data at the issuer, including unexpected profile fields and unrelated actions. */
function closePage(value: unknown, accountId: string, human: SessionProof): RenamePageBody {
  if (!record(value) || !record(value.viewer) || !record(value.profile) || !record(value.authActions))
    throw new TransportDenied(503);
  const viewer = value.viewer;
  if (viewer.accountId !== accountId || viewer.kind !== 'actor') throw new TransportDenied(503);
  const profile = closedProfile({ profile: value.profile }, accountId).profile;
  const sourceActions = value.authActions;
  let authActions: Extract<RenamePageBody, { state: 'ready' }>['authActions'];
  if (sourceActions.state === 'unavailable' && Object.keys(sourceActions).length === 1) {
    authActions = { state: 'unavailable' };
  } else if (
    sourceActions.state === 'ready' &&
    Object.keys(sourceActions).sort().join(',') === 'operations,state' &&
    Array.isArray(sourceActions.operations) &&
    sourceActions.operations.length <= 8
  ) {
    const operations = sourceActions.operations.map((item) => {
      if (!record(item) || Object.keys(item).sort().join(',') !== 'action,operationId,resource' || !record(item.resource))
        throw new TransportDenied(503);
      if (
        typeof item.operationId !== 'string' ||
        typeof item.action !== 'string' ||
        !Number.isSafeInteger(item.resource.route) ||
        !uuid(item.resource.id) ||
        Object.keys(item.resource).sort().join(',') !== 'id,route'
      )
        throw new TransportDenied(503);
      if (item.operationId !== 'auth.account.rename') return null;
      if (item.action !== 'account:update' || item.resource.id !== accountId) throw new TransportDenied(503);
      return {
        operationId: item.operationId,
        action: item.action,
        resource: { route: item.resource.route as number, id: item.resource.id },
      };
    });
    authActions = { state: 'ready', operations: operations.filter((operation) => operation !== null) };
  } else throw new TransportDenied(503);
  return {
    state: 'ready',
    viewer: {
      accountId,
      clientId: human.client_id,
      scopes: [...human.scope],
      kind: 'actor',
      authnEpoch: human.authn_epoch,
      authTime: human.auth_time,
      amr: [...human.amr] as ('pwd' | 'pop')[],
    },
    profile,
    authActions,
  };
}

/** Safe readiness and the existing exact-profile continuation precede any private read. */
export function accountRenamePageTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: AccountRenamePageAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/account-management/rename-page') return fallback(request);
    const response = (body: RenamePageBody, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.has('authorization') ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return response({ state: 'unavailable' }, 400);
    try {
      const body = await readJsonObject(request);
      if (Object.keys(body).length !== 0) return response({ state: 'unavailable' }, 400);
      const deadline = Date.now() + 3000;
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human): Promise<RenamePageBody> => {
          if (!isExactRenameProfile(human, human.account_id))
            return {
              state: 'management-auth-required',
              continuation: { kind: 'management-operation-step-up', operation: 'rename' },
            };
          if (!access) return { state: 'unavailable' };
          let page: RenamePageBody;
          try {
            page = closePage(
              await access.readRenameAccountPage({ human, accountId: human.account_id, deadline }),
              human.account_id,
              human,
            );
          } catch (error) {
            // A native 401 means the admitted proof no longer meets Access's
            // account, currentness or authentication floor. It is a refusal,
            // while Auth proof failures outside this seam remain signed-out.
            const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
            if (status === 401 || status === 403 || status === 409) return { state: 'refused' };
            throw error;
          }
          // Revalidate the same session, floor, client and consent after native I/O.
          try {
            await service.internal.accessTokenForProof(human);
          } catch (error) {
            const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
            if (status !== 401) throw error;
            // Issuance also checks native authority. Confirm the exact Auth
            // session still exists without treating a changed native floor as
            // sign-out.
            return (await service.internal.isProofSessionCurrent(human)) ? { state: 'refused' } : { state: 'signed-out' };
          }
          if (Date.now() >= deadline) return { state: 'unavailable' };
          return page;
        },
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (status === 401) return response({ state: 'signed-out' });
      if (status === 403 || status === 409) return response({ state: 'refused' });
      return response({ state: 'unavailable' });
    }
  };
}
