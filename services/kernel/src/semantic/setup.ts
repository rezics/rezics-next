import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { deadlineFor } from '../request/deadline.ts';
import { installStandingParentGrant } from '../access/index.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { bootstrapRelease } from './definitions.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import readGlobalContext from './setup-read-global.sql';

/** Install the immutable bundled release and global catalogue grants at startup. */
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
      const found = await readGlobalContext.run(client, { route: 0, context_id: GLOBAL_CONTEXT });
      return found !== null;
    },
  };
  const context = { pool, deadline: deadlineFor(30_000), actor };
  const authority = {
    action: 'semantic.setup',
    resource: parent.resource,
    denied: () => new Error('Semantic setup denied'),
    async authorize() {
      return 'execute' as const;
    },
  };
  await installStandingParentGrant({
    access,
    parent,
    authority,
    context,
    actions: ['subject:create', 'statement:propose'],
  });
  return digest;
}
