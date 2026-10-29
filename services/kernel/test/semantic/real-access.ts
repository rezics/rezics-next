import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import type { AuthenticationConfig } from '../../src/access/authenticate.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import type { Access, Resource } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';

export type RealAccessCheck = {
  persona: string;
  action: string;
  resource: { route: number; id: string };
};

export type RealAccessFixture<Persona extends string> = {
  auth: AuthenticationConfig;
  access(config: AccessConfig): Access;
  writeRate: ReturnType<typeof createWriteRateLimiter>;
  bearer(persona: Persona): string;
  grant(resource: Resource, persona: Persona, action: string): Promise<void>;
  revoke(resource: Resource, persona: Persona, action: string): Promise<void>;
  checks: RealAccessCheck[];
  readChecks: RealAccessCheck[];
};

export async function createRealAccess<const Personas extends Readonly<Record<string, string>>>(
  admin: Pool,
  accounts: Personas,
  actions: readonly string[],
  options: { clock?: () => Date } = {},
): Promise<RealAccessFixture<keyof Personas & string>> {
  type Persona = keyof Personas & string;
  const accountById = new Map(Object.entries(accounts).map(([persona, accountId]) => [accountId, persona]));
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'semantic-real-access', alg: 'ES256' };
  const auth = {
    issuer: 'https://auth.example.test',
    audience: 'https://api.rezics.test',
    jwksUrl: 'https://auth.example.test/jwks',
    fetch: async () => Response.json({ keys: [jwk] }),
  };
  const bearers = new Map<Persona, string>();

  for (const [persona, accountId] of Object.entries(accounts) as [Persona, string][]) {
    const issuedAt = Math.floor((options.clock?.() ?? new Date()).getTime() / 1000);
    const bearer = await new SignJWT({
      client_id: 'web',
      scope: actions.join(' '),
      authn_epoch: 1,
      auth_time: issuedAt,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'semantic-real-access', typ: 'at+jwt' })
      .setIssuer(auth.issuer)
      .setAudience(auth.audience)
      .setSubject(accountId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 5 * 60)
      .sign(signing.privateKey);
    const route = routeOf(accountId);
    if (route === null) throw new Error(`Invalid account id for persona ${persona}`);
    await admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [route, accountId],
    );
    bearers.set(persona, bearer);
  }

  const checks: RealAccessCheck[] = [];
  const readChecks: RealAccessCheck[] = [];
  const access = (config: AccessConfig): Access => {
    const real = createAccess({ ...config, auth });
    return deriveAccess(real, {
      async authorize(client, actor, action, resource, evidence, time) {
        const check = {
          persona: actor.kind === 'account' ? (accountById.get(actor.accountId) ?? 'unknown') : 'anonymous',
          action,
          resource: { route: resource.route, id: resource.id },
        };
        if (action.endsWith(':read')) readChecks.push(check);
        else checks.push(check);
        return real.authorize(client, actor, action, resource, evidence, time);
      },
    });
  };

  async function grant(resource: Resource, persona: Persona, action: string): Promise<void> {
    const accountId = accounts[persona];
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
      [resource.route, resource.id, accountId, action],
    );
  }

  async function revoke(resource: Resource, persona: Persona, action: string): Promise<void> {
    await admin.query(
      `DELETE FROM access.resource_grant
       WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4`,
      [resource.route, resource.id, accounts[persona], action],
    );
  }

  return {
    auth,
    access,
    writeRate: createWriteRateLimiter({ secret: 'semantic-real-access-test-secret' }),
    bearer(persona) {
      const bearer = bearers.get(persona);
      if (!bearer) throw new Error(`No bearer token for persona ${persona}`);
      return bearer;
    },
    grant,
    revoke,
    checks,
    readChecks,
  };
}
