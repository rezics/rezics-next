import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { installStandingParentGrant } from '../access/index.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from './definitions.ts';

/** Install the immutable bundled release and global catalogue creation grant at startup. */
export async function setupSemantic(pool: Pool, release: Release): Promise<string> {
  const digest = await bootstrapRelease(pool, release);
  const actor: AccountActor = {
    kind: 'account',
    accountId: '00000000-0000-8000-8000-000000000001',
    clientId: 'semantic-setup',
    scopes: [],
    requestedBy: null,
    authnEpoch: 1,
  };
  const access: Access = {
    async authenticate() {
      throw new Error('Setup access cannot authenticate');
    },
    async authorize() {
      return true;
    },
  };
  const parent = {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    async validate(client: { query: Pool['query'] }) {
      const result = await client.query(
        "SELECT 1 FROM semantic.context WHERE route = 0 AND context_id = $1::uuid AND kind = 'global'",
        [GLOBAL_CONTEXT],
      );
      return result.rowCount === 1;
    },
  };
  const context = { pool, deadline: Date.now() + 30_000, actor };
  const authority = {
    action: 'semantic.setup',
    resource: parent.resource,
    denied: () => new Error('Semantic setup denied'),
    async authorize() {
      return 'execute' as const;
    },
  };
  await installStandingParentGrant({ access, parent, authority, context, actions: ['subject:create'] });
  return digest;
}
