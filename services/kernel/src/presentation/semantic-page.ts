import { definedViews, resolveView, type PresentationProfile, type View } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  requireAccessDeadline,
} from '../access/unavailable.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { globalReadEligibility, relatedReadEligibility } from '../semantic/eligibility.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readItemDetails } from '../semantic/subject.ts';
import statesRead from '../semantic/subject-summary-states.sql';
import type { SummaryReaderDependencies } from '../semantic/summaries.ts';
import { activeProfile } from './profiles.ts';

export type PageViewer =
  | { kind: 'anonymous' }
  | { kind: 'account'; account: string };
export type PageActionState = 'allowed' | 'denied' | 'unavailable' | 'unsupported' | 'withheld';

/** Native Access under the actual caller; never a Type descriptor or frontend role. */
export async function subjectPageViewerState(input: {
  access: Access;
  pool: Pool;
  actor: Actor;
  deadline: number;
  subject: string;
}): Promise<{ viewer: PageViewer; actions: Record<string, PageActionState> }> {
  const viewer: PageViewer =
    input.actor.kind === 'account' ? { kind: 'account', account: input.actor.accountId } : { kind: 'anonymous' };
  const route = routeOf(input.subject);
  if (route === null) return { viewer, actions: { propose: 'unavailable' } };
  try {
    const check = await accessCheck(
      input.access,
      input.actor,
      'statement:propose',
      { route, id: input.subject },
      { pool: input.pool, deadline: input.deadline },
    );
    const allowed = await withReadTransaction(input.pool, (client) => check(client), input.deadline);
    return { viewer, actions: { propose: allowed ? 'allowed' : 'denied' } };
  } catch (error) {
    if (error instanceof CommandUnavailableError || error instanceof AccessUnavailableError)
      return { viewer, actions: { propose: 'unavailable' } };
    return { viewer, actions: { propose: 'unavailable' } };
  }
}

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
