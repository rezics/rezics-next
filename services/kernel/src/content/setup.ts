import type { Pool } from 'pg';
import { deadlineFor } from '../request/deadline.ts';
import { installStandingParentGrant } from '../access/index.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import readGlobalContext from '../semantic/setup-read-global.sql';

/** Install Global subject reaction standing once, without restoring revoked grants. */
export async function setupContent(pool: Pool): Promise<void> {
  const actor: AccountActor = {
    kind: 'account',
    // A separate setup principal keeps its receipt independent of semantic setup.
    accountId: '00000000-0000-8000-8000-000000000002',
    clientId: 'content-setup',
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
      const found = await readGlobalContext.run(client, { route: 0, context_id: GLOBAL_CONTEXT });
      return found !== null;
    },
  };
  const context = { pool, deadline: deadlineFor(30_000), actor };
  const authority = {
    action: 'content.setup',
    resource: parent.resource,
    denied: () => new Error('Content setup denied'),
    async authorize() {
      return 'execute' as const;
    },
  };
  await installStandingParentGrant({
    access,
    parent,
    authority,
    context,
    actions: ['reaction:set'],
  });
}
