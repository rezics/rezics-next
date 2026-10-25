import type { Access, AccessConfig as KernelAccessConfig, Actor, Resource } from '../request/access.ts';
import { createAccess as permissionAccess } from './permission.ts';
import { createAuthenticator, deadlineClient, within, type AuthenticationConfig } from './authenticate.ts';

export type AccessConfig = KernelAccessConfig & { auth?: AuthenticationConfig };

type Prepared = { actor: Actor; action: string; route: number; id: string; deadline: number };

/**
 * App-local Access factory; the kernel supplies the mounted route catalogue.
 * Optional auth overrides the deployment's AUTH_ISSUER (HTTPS origin),
 * AUTH_AUDIENCE (HTTPS API URL), and AUTH_JWKS_URL (HTTPS public JWKS on the
 * issuer origin). All three are required only when authentication is used.
 * Only ES256 public keys are accepted; Auth credentials/private keys are never needed.
 */
export function createAccess(config: AccessConfig): Access {
  const actions = new Map([...config.actions].map(([action, metadata]) => [action, { ...metadata }]));
  const authentication = createAuthenticator(config.auth);
  const prepared = new WeakMap<object, Prepared>();
  const permissions = permissionAccess({
    actions,
    accountEvidence: (actor) => authentication.identity(actor)?.account,
  });
  return {
    authenticate: authentication.authenticate,
    replayAuthorization: (action) => actions.get(action)?.replay,
    async prepare(actor, action, resource, context) {
      if (!actions.has(action)) return null;
      try {
        const identity = actor.kind === 'account' ? authentication.identity(actor) : undefined;
        if (actor.kind === 'account' && (!identity || identity.pool !== context.pool)) return null;
        const deadline = Math.min(context.deadline, identity?.deadline ?? Infinity, identity?.expires ?? Infinity);
        const evidence = await within(deadline, () =>
          permissions.prepare!(actor, action, resource, {
            pool: deadlineClient(context.pool, deadline) as typeof context.pool,
            deadline,
          }),
        );
        if (typeof evidence !== 'object' || evidence === null) return null;
        prepared.set(evidence, { actor, action, route: resource.route, id: resource.id, deadline });
        return evidence;
      } catch {
        return null;
      }
    },
    async authorize(client, actor, action, resource: Resource, evidence, time) {
      if (!actions.has(action)) return false;
      const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
      if (
        !facts ||
        facts.actor !== actor ||
        facts.action !== action ||
        facts.route !== resource.route ||
        facts.id !== resource.id
      )
        return false;
      try {
        return await within(facts.deadline, () =>
          permissions.authorize(deadlineClient(client, facts.deadline), actor, action, resource, evidence, time),
        );
      } catch {
        return false;
      }
    },
  };
}

/** Standalone instance denies authorization until an app supplies its own catalogue. */
export const access: Access = createAccess({ actions: new Map() });
