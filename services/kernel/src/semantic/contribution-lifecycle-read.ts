import type { Pool, PoolClient } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { readViewerActions, type ViewerActionBindings } from '../access/viewer-actions.ts';
import { authoritativeTimeValue } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from './read.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { slotView } from './slots.ts';
import { redirectOf } from './merges.ts';
import { candidateSources, fencedIds } from './fences.ts';
import { statementAudience } from './statement-disclosure.ts';
import { readSemanticLifecycle } from './lifecycle-state.ts';
import { contributionAuthorResource, ContributionLifecycleNotFoundError } from './contribution-lifecycle.ts';
import readLocator from './contribution-lifecycle-read-locator.sql';
import readSubject from './moderation-read-subject.sql';
import readState from './contribution-lifecycle-read-state.sql';
import readHidden from './candidates-read-hidden-ids.sql';
import readOwners from './candidates-read-owners.sql';

export type ContributionLifecycleView = {
  subject: string;
  candidate: string;
  property: string;
  viewer: 'account' | 'anonymous';
  state: 'available' | 'deleted';
  selected: boolean;
  actions: { state: 'available'; operations: ('delete' | 'restore')[] } | { state: 'unavailable' };
};
const listed = <T>(value: T | T[] | null): T[] => value === null ? [] : Array.isArray(value) ? value : [value];

/** Exact metadata only. The normal candidate audience, author-account and source witnesses apply to tombstones too. */
export async function readContributionLifecycle(
  deps: { pool: Pool; access: Access; bindings: ViewerActionBindings; clock: () => Date; routeKey: Uint8Array },
  input: {
    subject: string;
    candidate: string;
    property: string;
    actor: Actor;
    deadline: number;
    authorize: (client: PoolClient) => Promise<boolean>;
    propose: (client: PoolClient) => Promise<boolean>;
  },
) {
  const route = routeOf(input.subject);
  if (route === null || routeOf(input.candidate) !== route) throw new ContributionLifecycleNotFoundError();
  const parameters = { route, subject_id: input.subject, candidate_id: input.candidate };
  async function observe(client: PoolClient) {
    const subject = await readSubject.run(client, parameters);
    if (!subject || subject.visibility !== 'visible' || !(await input.authorize(client)) || await redirectOf(client, input.subject))
      throw new ContributionLifecycleNotFoundError();
    const located = await readLocator.run(client, parameters);
    if (!located || located.property !== input.property || !located.slot_id) throw new ContributionLifecycleNotFoundError();
    const hidden = listed(await readHidden.run(client, { ...parameters, candidate_ids: [input.candidate], ...await statementAudience(client) }));
    if (hidden.length) throw new ContributionLifecycleNotFoundError();
    // Expanded candidates use the ordinary candidate owner witness. Compact assertions keep their original locator.
    const owners = listed(await readOwners.run(client, { ...parameters, candidate_ids: [input.candidate] }));
    if (located.origin === 'proposal' && !owners.length || owners.some(owner => owner.principal_kind === 'account' && (owner.account_state !== 'active' || owner.account_fenced !== false)))
      throw new ContributionLifecycleNotFoundError();
    const sources = await candidateSources(client, [{ route, subject_id: input.subject, candidate_id: input.candidate }]);
    if ((await fencedIds(client, deps.routeKey, [{ id: input.candidate, source: sources.get(`${input.subject}\n${input.candidate}`) ?? null }])).size)
      throw new ContributionLifecycleNotFoundError();
    const state = await readState.run(client, parameters);
    if (state && !['active', 'deleted'].includes(state.state)) throw new ContributionLifecycleNotFoundError();
    return { located, subject, state };
  }
  const first = await withReadTransaction(deps.pool, observe, input.deadline);
  const resource = contributionAuthorResource(input.subject, first.located.revision);
  let actions: ContributionLifecycleView['actions'] = { state: 'unavailable' };
  try {
    const result = await readViewerActions({
      ...deps,
      resources: new Map([['semantic.revision', {
        readAction: 'statement:delete',
        async read(client, ids) {
          const row = await client.query('SELECT 1 FROM access.resource_initialization WHERE route=$1 AND resource_id=$2 AND resource_type=\'semantic.revision\'', [resource.route, resource.id]);
          return Object.fromEntries(ids.map(id => [id, id === resource.id && row.rows.length === 1]));
        },
        async actionAvailability(client, ids, actor, time) {
          const evidence = actor.kind === 'account' ? await readSemanticLifecycle(client, {
            target: { kind: 'candidate', subject: input.subject, candidate: input.candidate },
            accountId: actor.accountId, nativeT: time,
          }) : null;
          const own = evidence?.owner?.kind === 'write_basis';
          const restore = own && evidence.state === 'deleted' && evidence.purgeAfter !== null && authoritativeTimeValue(time) < evidence.purgeAfter && await input.propose(client as PoolClient);
          return Object.fromEntries(ids.map(id => [id, { 'statement:delete': own && evidence.state === 'active', 'statement:restore': !!restore }]));
        },
      }]]),
    }, input.actor, [{ type: 'semantic.revision', id: resource.id }], input.deadline);
    const entry = result.resources[0];
    actions = { state: 'available', operations: entry && 'viewerActions' in entry ? entry.viewerActions.flatMap(action => action.operations.flatMap(operation => operation === 'statement.delete' ? ['delete' as const] : operation === 'statement.restore_deleted' ? ['restore' as const] : [])) : [] };
  } catch {
    // Dependency failure is distinct from a confirmed empty set of allowed operations.
  }
  return withReadTransaction(deps.pool, async client => {
    const current = await observe(client);
    const partition = await readPartition(client, partitionOf(route));
    if (!partition || current.located.revision !== first.located.revision || current.subject.securityRevision !== first.subject.securityRevision || current.state?.security_revision !== first.state?.security_revision)
      throw new ContributionLifecycleNotFoundError();
    const view = await slotView(client, input.subject, input.property, GLOBAL_CONTEXT, {}, current.located.slot_id!);
    const result: ContributionLifecycleView = {
      subject: input.subject, candidate: input.candidate, property: input.property,
      viewer: input.actor.kind === 'account' ? 'account' : 'anonymous',
      state: current.state?.state === 'deleted' ? 'deleted' : 'available',
      selected: view.facts.some(fact => fact.statement_id === input.candidate), actions,
    };
    return { ...result, component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position } };
  }, input.deadline);
}
