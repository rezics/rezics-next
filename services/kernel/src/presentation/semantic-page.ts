import { definedViews, resolveView, type PresentationProfile, type View } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { deadlineClient } from '../access/authenticate.ts';
import {
  classifyUnavailability,
  CommandUnavailableError,
  requireAccessDeadline,
} from '../access/unavailable.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { globalReadEligibility, relatedReadEligibility } from '../semantic/eligibility.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readItemDetails } from '../semantic/subject.ts';
import statesRead from '../semantic/subject-summary-states.sql';
import type { SummaryReaderDependencies } from '../semantic/summaries.ts';
import { activeProfile } from './profiles.ts';

/** The ordinary native page's template order and offered views, shared with pages.read. */
export function semanticPageView(
  profile: PresentationProfile,
  release: Release | undefined,
  type: string,
  view: View = 'overview',
) {
  const definition = release?.types[type];
  const target = { type, ...(definition === undefined ? {} : { bases: definition.bases }) };
  const resolved = resolveView(profile, target, view);
  return resolved === null ? null : { resolved, views: definedViews(profile, target) };
}

export type PublicSemanticPageMetadata = {
  views: readonly string[];
  /** An Account association vetoes independent Subject fallback; it never proves an Account target. */
  independentSubject: boolean;
};

/** Native metadata only: no renderer, leaf dispatch, profile-declared permission or retained allow. */
export async function preparePublicSemanticPageMetadata(deps: SummaryReaderDependencies, ids: readonly string[]) {
  if (ids.length > 100) throw new RangeError('Page metadata accepts at most 100 ids');
  const groups = new Map<number, string[]>();
  for (const id of new Set(ids)) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Page metadata requires full routed keys');
    const home = partitionOf(route);
    const group = groups.get(home) ?? [];
    group.push(id);
    groups.set(home, group);
  }
  const actor = { kind: 'anonymous' as const };
  const observe = async () => {
    requireAccessDeadline(deps.deadline);
    // Prepare outside every source checkout. Each observation creates fresh native Access evidence.
    const gates = await Promise.all(
      (['presentation:read', 'subject:read'] as const).map((action) =>
        accessCheck(
          deps.access,
          actor,
          action,
          { route: 0, id: GLOBAL_CONTEXT, eligibility: globalReadEligibility(action) },
          { pool: deps.pool, deadline: deps.deadline },
        ),
      ),
    );
    const anchor = async (client: Parameters<typeof readPartition>[0], home: number) => {
      const owner = await readPartition(client, home);
      if (!owner) throw new CommandUnavailableError('contention', home);
      if (owner.writeState !== 'active')
        throw new CommandUnavailableError(owner.writeState === 'moved' ? 'moved' : 'fenced', home, owner.movedTo);
      return owner.epoch;
    };
    const global = await withReadTransaction(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deps.deadline);
      const epoch = await anchor(client, 0);
      let allowed = true;
      for (const gate of gates) if (!(await gate(client))) allowed = false;
      return { epoch, allowed };
    });
    const profile = await activeProfile(deps.pool);
    const release = await activeRelease(deps.pool);
    type State = Awaited<ReturnType<typeof statesRead.run>>[number];
    type Detail = Awaited<ReturnType<typeof readItemDetails>> extends Map<string, infer T> ? T : never;
    const rows = new Map<string, { state: State; detail: Detail; epoch: number; allowed: boolean }>();
    if (global.allowed && profile && release) {
      for (const [home, group] of groups) {
        const checks = new Map(
          await Promise.all(
            group.map(
              async (id) =>
                [
                  id,
                  await accessCheck(
                    deps.access,
                    actor,
                    'subject:read',
                    {
                      route: routeOf(id)!,
                      id,
                      eligibility: relatedReadEligibility({ route: routeOf(id)!, id }, group),
                    },
                    { pool: deps.pool, deadline: deps.deadline },
                  ),
                ] as const,
            ),
          ),
        );
        await withReadTransaction(deps.pool, async (connection) => {
          // Eligibility memoization is limited to this snapshot, never a pooled connection.
          const client = deadlineClient({ query: connection.query.bind(connection) }, deps.deadline);
          const epoch = await anchor(client, home);
          const states = await statesRead.run(client, {
            partition_no: home,
            routes: group.map((id) => routeOf(id)!),
            subject_ids: group,
          });
          const details = await readItemDetails(client, group);
          for (const state of states) {
            const detail = details.get(state.id);
            if (detail) rows.set(state.id, { state, detail, epoch, allowed: await checks.get(state.id)!(client) });
          }
        });
      }
    }
    requireAccessDeadline(deps.deadline);
    return { global, profile, release, rows };
  };
  const before = await observe();
  return {
    async finish(): Promise<Map<string, PublicSemanticPageMetadata | null>> {
      const current = await observe();
      const result = new Map<string, PublicSemanticPageMetadata | null>(ids.map((id) => [id, null]));
      if (
        !before.global.allowed ||
        !current.global.allowed ||
        before.global.epoch !== current.global.epoch ||
        !before.profile ||
        !current.profile ||
        !before.release ||
        !current.release ||
        before.profile.head !== current.profile.head ||
        before.profile.digest !== current.profile.digest ||
        before.release.head !== current.release.head ||
        before.release.digest !== current.release.digest
      )
        return result;
      for (const id of result.keys()) {
        const old = before.rows.get(id),
          row = current.rows.get(id);
        // Equality only rejects changed data. Fresh native guards above supply permission.
        if (
          !old?.allowed ||
          !row?.allowed ||
          JSON.stringify(old) !== JSON.stringify(row) ||
          row.state.visibility !== 'visible' ||
          row.state.redirect
        )
          continue;
        const page = semanticPageView(current.profile.profile, current.release.release, row.detail.type);
        if (page) result.set(id, { views: page.views, independentSubject: row.detail.agentAccountId === null });
      }
      return result;
    },
  };
}

const peopleProducerRoots = new Set(['schema:Person', 'schema:Organization']);
const peopleProducerCorrectionActions = [
  { action: 'statement:propose', operationId: 'subject.propose' },
  { action: 'context:accept', operationId: 'subject.accept_candidate' },
  { action: 'context:adopt', operationId: 'subject.adopt' },
] as const;

export type PeopleProducerActionState =
  | 'allowed'
  | 'denied'
  | 'unavailable'
  | 'unsupported'
  | 'absent'
  | 'withheld';

/** Person and Organization, including descendants, admit correction actions on the ordinary page. */
export function peopleProducerTypeAdmitted(
  release: { types: Record<string, { bases?: readonly string[] }> } | undefined,
  type: string,
) {
  if (!release) return false;
  const seen = new Set<string>();
  const matches = (current: string): boolean => {
    if (peopleProducerRoots.has(current)) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    return (release.types[current]?.bases ?? []).some(matches);
  };
  return matches(type);
}

export async function readPeopleProducerPageAuthority(
  deps: { access: Access; pool: Pool },
  actor: Actor,
  deadline: number,
): Promise<{
  viewer: { kind: 'anonymous' | 'account' };
  actions: { action: string; operationId: string; state: PeopleProducerActionState }[];
}> {
  const viewer = { kind: actor.kind === 'account' ? ('account' as const) : ('anonymous' as const) };
  const unavailable = peopleProducerCorrectionActions.map((entry) => ({
    action: entry.action,
    operationId: entry.operationId,
    state: 'unavailable' as const,
  }));
  try {
    requireAccessDeadline(deadline);
    const prepared = await Promise.all(
      peopleProducerCorrectionActions.map(async (entry) => ({
        ...entry,
        check: await accessCheck(
          deps.access,
          actor,
          entry.action,
          { route: 0, id: GLOBAL_CONTEXT },
          { pool: deps.pool, deadline },
        ),
      })),
    );
    requireAccessDeadline(deadline);
    const actions = await withReadTransaction(
      deps.pool,
      async (client) => {
        const states: { action: string; operationId: string; state: PeopleProducerActionState }[] = [];
        for (const entry of prepared) {
          let state: PeopleProducerActionState = 'denied';
          try {
            state = (await entry.check(client)) ? 'allowed' : 'denied';
          } catch (error) {
            if (classifyUnavailability(error)) state = 'unavailable';
            else throw error;
          }
          states.push({ action: entry.action, operationId: entry.operationId, state });
        }
        return states;
      },
      deadline,
    );
    return { viewer, actions };
  } catch (error) {
    if (classifyUnavailability(error)) return { viewer, actions: unavailable };
    throw error;
  }
}
