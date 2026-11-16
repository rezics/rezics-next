import type { Pool, PoolClient } from 'pg';
import type { Access, AccessCheck } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { relatedReadVisibility, subjectReadEligibility } from '../semantic/eligibility.ts';
import { readReleasedIdentityMappingsInSnapshot } from '../semantic/identity-adapters/identity-epoch-read.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { accessCheck } from './access-port.ts';
import { KNOWLEDGE_REFERENCE_LIMIT, KnowledgeNotFoundError } from './knowledge-model.ts';
import type { ReadContext } from './model.ts';

async function readMappings(client: PoolClient, originals: readonly string[]) {
  const mappings = [];
  for (let start = 0; start < originals.length; start += 100) {
    const page = await readReleasedIdentityMappingsInSnapshot(client, originals.slice(start, start + 100));
    mappings.push(...page.mappings);
  }
  return mappings;
}

/** Keep stored originals pinned. Both the original and its published terminal need current Subject Access. */
export async function prepareKnowledgeSubjectDisclosure(
  deps: Readonly<{ pool: Pool; access: Access }>,
  ids: readonly string[],
  context: ReadContext,
): Promise<() => Promise<boolean>> {
  // A private comparison can select two revisions plus their common notebook Subject.
  if (ids.length > 2 * KNOWLEDGE_REFERENCE_LIMIT + 1)
    throw new RangeError('Knowledge Subject disclosure exceeds the revision comparison bound');
  const originals = [...new Set(ids)];
  if (originals.some((id) => routeOf(id) === null)) throw new KnowledgeNotFoundError();
  const selected = await withReadTransaction(deps.pool, (client) => readMappings(client, originals), context.deadline);
  const targets = new Set(originals);
  for (const mapping of selected) {
    if (mapping.state !== 'mapped') return async () => false;
    targets.add(mapping.terminal);
  }
  const endpoints = [...targets];

  // Prepare Access outside the snapshot. Verification uses one snapshot for both the mapping and its grants.
  const checks: AccessCheck[] = [];
  for (const id of endpoints) {
    const resource = { id, route: routeOf(id)! };
    checks.push(
      await accessCheck(
        deps.access,
        context.actor,
        'subject:read',
        {
          ...resource,
          eligibility: subjectReadEligibility(resource),
        },
        { pool: deps.pool, deadline: context.deadline },
      ),
    );
  }
  return () =>
    withReadTransaction(
      deps.pool,
      async (client) => {
        const current = await readMappings(client, originals);
        if (
          !current.every((mapping, index) => {
            const expected = selected[index]!;
            return (
              mapping.state === 'mapped' &&
              expected.state === 'mapped' &&
              mapping.terminal === expected.terminal &&
              mapping.epoch === expected.epoch
            );
          })
        )
          return false;
        // A signed-in grant may authorize a hidden Subject outside Knowledge.
        if (context.actor.kind !== 'anonymous') {
          for (let start = 0; start < endpoints.length; start += 256) {
            const page = endpoints.slice(start, start + 256);
            const visible = await relatedReadVisibility(client, page);
            if (!page.every((id) => visible[id])) return false;
          }
        }
        for (const check of checks) {
          if (!(await check(client))) return false;
        }
        return true;
      },
      context.deadline,
    );
}
