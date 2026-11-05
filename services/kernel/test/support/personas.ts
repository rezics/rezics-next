import type { Pool } from 'pg';
import {
  bootstrapGovernance,
  PLATFORM_GOVERNANCE_ROLE,
  PLATFORM_RESOURCE,
} from '../../src/access/bootstrap-governance.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { accessCheck, type Resource } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { cookies, password, type nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { registerTestClient, type TestKernel } from './test-kernel.ts';

/** Consumers pin this literal. Bump it whenever the returned persona shape changes. */
export const PERSONAS_VERSION = 1;
export type Persona = { accountId: string; bearer: string };
export type PersonasOptions = {
  version: typeof PERSONAS_VERSION;
  pool: Pool;
  auth: Awaited<ReturnType<typeof nativeFixture>>;
  /** Omit only for the first governance bootstrap in an isolated kernel database. */
  governance?: Persona;
};

/**
 * Compose the kernel with auth.host.service.verifier, its public handler transport,
 * and a native write rate limiter configured with a test secret.
 * The caller owns the nativeFixture's lifetime. Every build uses fresh physical names;
 * returned keys are the stable logical names. Organizations have no credentials: use orgOwner.
 *
 * Cost: nine human registrations, one automated registration and one organization,
 * plus a fixed number of native commands and tokens. unscoped calls reuse one account.
 */
export async function createPersonas(kernel: TestKernel, options: PersonasOptions) {
  if (options.version !== PERSONAS_VERSION) throw new Error(`Unsupported personas version: ${options.version}`);
  const { auth, pool } = options;
  const context = () => ({ pool, deadline: Date.now() + 10000 });
  const prefix = `p${PERSONAS_VERSION}_${crypto.randomUUID().replaceAll('-', '')}`;
  const key = (name: string) => `${prefix}_${name}`;
  const governanceScopes = resourceRoleCatalogue(kernel.testAccess)!.roles.get(PLATFORM_GOVERNANCE_ROLE)!;
  const scopes = [...new Set([...actionCatalogue(kernel).keys(), ...LIFECYCLE_ACTIONS.keys(), ...governanceScopes])]
    .filter((action) => action !== 'media:complete')
    .sort();
  const clientId = key('client');
  await registerTestClient(auth.host.service, { clientId, firstParty: true, scopes });

  async function checked(response: Response, operation: string) {
    if (!response.ok) throw new Error(`Personas ${operation}: ${response.status} ${await response.text()}`);
    return response;
  }
  async function token(headers: Headers, requestedBy?: string) {
    const response = await checked(
      await auth.request('/token', requestedBy === undefined ? {} : { requested_by: requestedBy }, headers),
      'token issuance',
    );
    return ((await response.json()) as { access_token: string }).access_token;
  }
  async function signIn(accountId: string, selectedScopes = scopes) {
    const response = await checked(
      await auth.request('/signin', { account_id: accountId, password, client_id: clientId, scope: selectedScopes }),
      'sign-in',
    );
    const headers = cookies(response);
    return { accountId, bearer: await token(headers), headers };
  }
  async function person(name: string) {
    const registered = await auth.person(key(name));
    return signIn(registered.accountId);
  }
  const identity = ({ accountId, bearer }: Persona): Persona => ({ accountId, bearer });
  async function command(bearer: string, path: string, body: unknown) {
    return checked(
      await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
          },
          body: JSON.stringify(body),
        }),
      ),
      path,
    );
  }

  const staff = await person('staff');
  if (options.governance) {
    await command(options.governance.bearer, '/v1/roleGrants', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: staff.accountId },
      role: PLATFORM_GOVERNANCE_ROLE,
      valid: '(,)',
    });
  } else {
    await bootstrapGovernance(pool, staff.accountId);
  }
  const alice = await person('alice');
  const bob = await person('bob');
  const orgOwner = await person('org_owner');
  const operator = await person('operator');
  const suspended = await person('suspended');
  const revoked = await person('revoked');
  const unscopedAccount = await person('unscoped');
  const delegate = await person('delegated');

  const organizationKey = key('organization');
  const organizationOperation = { kind: 'organization' as const, handle: organizationKey, authorization: 'request' };
  const organizationApproval = await auth
    .approval()
    .approve(orgOwner.bearer, { operationKey: organizationKey, operation: organizationOperation }, context());
  const organization = await auth.host.workflows.createOrganization({
    key: organizationKey,
    handle: organizationKey,
    authorization: organizationApproval.reference,
  });

  const software = await auth.automated(key('software'), operator);
  const openingKey = key('opening');
  const opening = {
    kind: 'opening' as const,
    operatorAccountId: operator.accountId,
    subjectAccountId: software.accountId,
    authorization: 'request',
  };
  const openingApproval = await auth
    .approval()
    .approve(operator.bearer, { operationKey: openingKey, operation: opening }, context());
  const opened = await checked(
    await auth.host.workflows.openOperatorSession({
      ...opening,
      key: openingKey,
      authorization: openingApproval.reference,
      headers: operator.headers,
    }),
    'operator session',
  );
  const softwareBearer = await token(cookies(opened));

  // Native workflow acceptance uses account:manage for this account-local command.
  const delegations = createDelegationCommands({ pool, access: auth.access, action: 'account:manage' });
  const assignment = await delegations.create(
    { ...context(), actor: await auth.access.authenticate(alice.bearer, context()) },
    {
      principalId: alice.accountId,
      assignedActorId: delegate.accountId,
      requestId: newId(routeOf(alice.accountId)!),
      valid: '(,)',
      key: key('assignment'),
    },
  );
  const requestedBy = assignment.value.requestedBy;
  const delegated = { accountId: delegate.accountId, bearer: await token(delegate.headers, requestedBy), requestedBy };

  await command(staff.bearer, `/v1/accounts/${suspended.accountId}:suspend`, { reason: 'Personas fixture' });
  const revocationKey = key('revocation');
  const revocation = { kind: 'revoke' as const, accountId: revoked.accountId, authorization: 'request' };
  const revocationApproval = await auth
    .approval()
    .approve(revoked.bearer, { operationKey: revocationKey, operation: revocation }, context());
  await auth.host.workflows.revokeSessions({
    accountId: revoked.accountId,
    key: revocationKey,
    authorization: revocationApproval.reference,
  });

  return {
    version: PERSONAS_VERSION,
    alice: identity(alice),
    bob: identity(bob),
    organization: { accountId: organization.accountId },
    orgOwner: identity(orgOwner),
    software: { accountId: software.accountId, bearer: softwareBearer },
    operator: identity(operator),
    suspended: identity(suspended),
    revoked: identity(revoked),
    delegated,
    staff: identity(staff),
    anonymous: { bearer: null },
    /** Defaults to the account's own grants. For other resources, supply a bearer
     * that may grant this exact action there; the ordinary grant rule still applies.
     * Each call signs in with precisely this action omitted from consented scopes.
     */
    async unscoped(
      action: string,
      resource: Resource = { route: routeOf(unscopedAccount.accountId)!, id: unscopedAccount.accountId },
      grantor: Persona = staff,
    ) {
      if (!scopes.includes(action)) throw new Error(`Unmounted persona action: ${action}`);
      const access = LIFECYCLE_ACTIONS.has(action) ? auth.access : kernel.testAccess;
      const ctx = context();
      const actor = await access.authenticate(unscopedAccount.bearer, ctx);
      const holds = await accessCheck(access, actor, action, resource, ctx);
      if (!(await holds(pool))) {
        await command(grantor.bearer, '/v1/grants', {
          resource,
          subject: { kind: 'account', id: unscopedAccount.accountId },
          actions: [action],
          valid: '(,)',
        });
      }
      return {
        ...identity(
          await signIn(
            unscopedAccount.accountId,
            scopes.filter((scope) => scope !== action),
          ),
        ),
        action,
        resource,
      };
    },
  };
}
