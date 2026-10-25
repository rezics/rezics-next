import type { Pool, PoolClient } from 'pg';

export type AccountActor = {
  kind: 'account';
  accountId: string;
  clientId: string;
  scopes: readonly string[];
  requestedBy: string | null;
  authnEpoch: number;
};

export type Actor = AccountActor | { kind: 'anonymous' };

export type Resource = { route: number; id: string };

export type AccessContext = { pool: Pool; deadline: number };

export type AccessClient = Pick<PoolClient, 'query'>;

export interface Access {
  authenticate(token: string, context: AccessContext): Promise<AccountActor>;
  authorize(client: AccessClient, actor: Actor, action: string, resource: Resource): Promise<boolean>;
}

export class AuthenticationError extends Error {
  readonly status: 400 | 401;
  readonly challenge: string;

  constructor(status: 400 | 401, challenge: string) {
    super('Authentication failed');
    this.name = 'AuthenticationError';
    this.status = status;
    this.challenge = challenge;
  }
}

const invalidRequest = () => new AuthenticationError(400, 'Bearer error="invalid_request"');

export async function actorOf(access: Access, request: Request, context: AccessContext): Promise<Actor> {
  const authorization = request.headers.get('authorization');
  if (authorization === null) return { kind: 'anonymous' };

  const scheme = /^([^\s]+)(?:[ \t]+|$)/.exec(authorization)?.[1];
  if (scheme?.toLowerCase() !== 'bearer') {
    throw new AuthenticationError(401, 'Bearer');
  }

  const credentials = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
  if (!credentials) throw invalidRequest();
  return access.authenticate(credentials[1]!, context);
}

export const anonymousAccess: Access = {
  async authenticate() {
    throw new AuthenticationError(401, 'Bearer error="invalid_token"');
  },
  async authorize(_client, _actor, action) {
    return action.slice(action.lastIndexOf('.') + 1) === 'read';
  },
};
