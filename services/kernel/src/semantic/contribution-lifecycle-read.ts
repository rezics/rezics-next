import type { Pool, PoolClient } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { readViewerActions, type ViewerActionBindings } from '../access/viewer-actions.ts';
import { authoritativeTimeValue } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from '../access/read-transaction.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { latestAdoption } from './slots.ts';
import readSlotOperation from './slots-read-operation.sql';
import readSelection from './contribution-lifecycle-read-selection.sql';
import { redirectOf } from './merges.ts';
import { fencedIds, type CandidateSource } from './fences.ts';
import { statementAudience, refreshStatementReaderAuthorization } from './statement-disclosure.ts';
import { readSemanticLifecycle } from './lifecycle-state.ts';
import { contributionAuthorResource, ContributionLifecycleNotFoundError } from './contribution-lifecycle.ts';
import readLocator from './contribution-lifecycle-read-locator.sql';
import readSubject from './moderation-read-subject.sql';
import readState from './contribution-lifecycle-read-state.sql';
import readHidden from './candidates-read-hidden-ids.sql';
import readOwner from './contribution-lifecycle-read-owner.sql';
import provenance from './scope-leaf-selection-provenance.sql';

export type ContributionLifecycleView = {
  subject: string;
  candidate: string;
  property: string;
  viewer: 'account' | 'anonymous';
  state: 'available' | 'deleted';
  selected: boolean;
  actions: { state: 'available'; operations: ('delete' | 'restore')[] } | { state: 'unavailable' };
};
const listed = <T>(value: T | T[] | null): T[] => (value === null ? [] : Array.isArray(value) ? value : [value]);

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
    propose: () => Promise<(client: PoolClient) => Promise<boolean>>;
  },
) {
  const subjectRoute = routeOf(input.subject);
  if (subjectRoute === null || routeOf(input.candidate) !== subjectRoute)
    throw new ContributionLifecycleNotFoundError();
  const route = subjectRoute;
  const parameters = { route, subject_id: input.subject, candidate_id: input.candidate };
  async function observe(client: PoolClient) {
    const subject = await readSubject.run(client, parameters);
    if (
      !subject ||
      subject.visibility !== 'visible' ||
      !(await input.authorize(client)) ||
      (await redirectOf(client, input.subject))
    )
      throw new ContributionLifecycleNotFoundError();
    const located = await readLocator.run(client, parameters);
    if (!located || located.property !== input.property || !located.slot_id)
      throw new ContributionLifecycleNotFoundError();
    const hidden = listed(
      await readHidden.run(client, {
        ...parameters,
        candidate_ids: [input.candidate],
        ...(await statementAudience(client)),
      }),
    );
    if (hidden.length) throw new ContributionLifecycleNotFoundError();
    // Both compact and expanded identities retain the original revision's author witness.
    const owner = await readOwner.run(client, {
      ...parameters,
      revision: located.revision,
    });
    if (!owner?.visible) throw new ContributionLifecycleNotFoundError();
    // Provenance is needed only for source disclosure. Bound it before hydration and
    // fail closed if it cannot be inspected; withheld provenance is never absent provenance.
    const sourceParameters = {
      routes: [route],
      subjects: [input.subject],
      candidates: [input.candidate],
      max_bytes: 16_384,
    };
    const sources = await client.query<{ source: CandidateSource | null; source_bytes: number }>(
      provenance.sql,
      provenance.params.map((name) => sourceParameters[name as keyof typeof sourceParameters]),
    );
    const source = sources.rows[0];
    if (!source || (source.source_bytes > 0 && source.source === null)) throw new ContributionLifecycleNotFoundError();
    if ((await fencedIds(client, deps.routeKey, [{ id: input.candidate, source: source.source }])).size)
      throw new ContributionLifecycleNotFoundError();
    const state = await readState.run(client, parameters);
    if (state && !['active', 'deleted'].includes(state.state)) throw new ContributionLifecycleNotFoundError();
    return { located, subject, state };
  }
  const first = await withReadTransaction(deps.pool, observe, input.deadline);
  const resource = contributionAuthorResource(input.subject, first.located.revision);
  let actions: ContributionLifecycleView['actions'] = { state: 'unavailable' };
  try {
    const propose = await input.propose();
    const result = await readViewerActions(
      {
        ...deps,
        resources: new Map([
          [
            'semantic.revision',
            {
              // Metadata shares the already validated Subject disclosure floor. Mutation
              // grants remain independent on the actual original revision resource.
              readAction: 'subject:read',
              async read(client, ids) {
                const row = await client.query(
                  "SELECT 1 FROM access.resource_initialization WHERE route=$1 AND resource_id=$2 AND resource_type='semantic.revision'",
                  [resource.route, resource.id],
                );
                return Object.fromEntries(ids.map((id) => [id, id === resource.id && row.rows.length === 1]));
              },
              async actionAvailability(client, ids, actor, time) {
                const evidence =
                  actor.kind === 'account'
                    ? await readSemanticLifecycle(client, {
                        target: { kind: 'candidate', subject: input.subject, candidate: input.candidate },
                        accountId: actor.accountId,
                        nativeT: time,
                      })
                    : null;
                const own = evidence?.owner?.kind === 'write_basis';
                const restore =
                  own &&
                  evidence.state === 'deleted' &&
                  evidence.purgeAfter !== null &&
                  authoritativeTimeValue(time) < evidence.purgeAfter &&
                  (await propose(client as PoolClient));
                return Object.fromEntries(
                  ids.map((id) => [
                    id,
                    { 'statement:delete': own && evidence.state === 'active', 'statement:restore': !!restore },
                  ]),
                );
              },
            },
          ],
        ]),
      },
      input.actor,
      [{ type: 'semantic.revision', id: resource.id }],
      input.deadline,
    );
    const entry = result.resources[0];
    actions = {
      state: 'available',
      operations:
        entry && 'viewerActions' in entry
          ? entry.viewerActions.flatMap((action) =>
              action.operations.flatMap((operation) =>
                operation === 'statement.delete'
                  ? ['delete' as const]
                  : operation === 'statement.restore_deleted'
                    ? ['restore' as const]
                    : [],
              ),
            )
          : [],
    };
  } catch {
    // Dependency failure is distinct from a confirmed empty set of allowed operations.
  }
  await refreshStatementReaderAuthorization();
  return withReadTransaction(
    deps.pool,
    async (client) => {
      const current = await observe(client);
      const partition = await readPartition(client, partitionOf(route));
      if (
        !partition ||
        current.located.revision !== first.located.revision ||
        current.subject.securityRevision !== first.subject.securityRevision ||
        current.state?.security_revision !== first.state?.security_revision
      )
        throw new ContributionLifecycleNotFoundError();
      // Read only selection metadata. A tombstone never causes statement payload hydration.
      let selected = false;
      if (current.state?.state !== 'deleted') {
        const slot = current.located.slot_id!;
        const operation = await readSlotOperation.run(client, { ...parameters, slot_id: slot });
        if (operation?.operation === 'expand') {
          const adoption = await latestAdoption(client, input.subject, input.property, GLOBAL_CONTEXT, slot);
          selected =
            adoption?.mode === 'replace' && adoption.selection.some((entry) => entry.candidate === input.candidate);
        } else {
          selected = (await readSelection.run(client, parameters))?.operation === 'assert';
        }
      }
      const result: ContributionLifecycleView = {
        subject: input.subject,
        candidate: input.candidate,
        property: input.property,
        viewer: input.actor.kind === 'account' ? 'account' : 'anonymous',
        state: current.state?.state === 'deleted' ? 'deleted' : 'available',
        selected,
        actions,
      };
      return {
        ...result,
        component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
      };
    },
    input.deadline,
  );
}
