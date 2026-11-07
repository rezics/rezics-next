import type { PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem-error.ts';
import { accessCheck } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { activeRelease } from './definition-release-read.ts';
import { relatedReadEligibility } from './eligibility.ts';
import { withReadTransaction } from './read.ts';
import { readSubjectSummaries, type SubjectSummary, type SummaryReaderDependencies } from './summaries.ts';
import statesRead from './subject-summary-states.sql';

type State = Awaited<ReturnType<typeof statesRead.run>>[number];

/** Current originals and terminals, through the ordinary public/read eligibility adapter.
 * No identity epoch readiness, retained permission, or curator substitution is involved.
 */
export async function readCurrentSubjectSummaries(
  deps: SummaryReaderDependencies,
  originals: readonly string[],
): Promise<{ summaries: Map<string, SubjectSummary | null>; verify(): Promise<void> }> {
  if (originals.length > 100) throw new RangeError('Current subject summaries accept at most 100 originals');
  const ids = [...new Set(originals)];
  const groups = (keys: readonly string[]) => {
    const homes = new Map<number, string[]>();
    for (const id of new Set(keys)) {
      const route = routeOf(id);
      if (route === null) throw new ProblemError('dependency_unavailable');
      const home = partitionOf(route);
      const batch = homes.get(home) ?? [];
      batch.push(id);
      homes.set(home, batch);
    }
    return homes;
  };
  const read = async (client: Pick<PoolClient, 'query'>, keys: readonly string[]) => {
    const result = new Map<string, State>();
    for (const [partition, batch] of groups(keys)) {
      const rows = await statesRead.run(await partitionReadClient(client, partition), {
        partition_no: partition,
        routes: batch.map((id) => routeOf(id)!),
        subject_ids: batch,
      });
      for (const row of rows) result.set(row.id, row);
    }
    return result;
  };
  const observed = await withReadTransaction(
    deps.pool,
    async (connection) => {
      const client = deadlineClient(connection, deps.deadline);
      const original = await read(client, ids);
      const terminals = ids.flatMap((id) => {
        const row = original.get(id);
        return row?.visibility === 'visible' && row.redirect ? [row.redirect] : [];
      });
      return new Map([...original, ...(await read(client, terminals))]);
    },
    deps.deadline,
  );
  const keys = [
    ...new Set([
      ...ids,
      ...ids.flatMap((id) => {
        const original = observed.get(id);
        return original?.visibility === 'visible' && original.redirect ? [original.redirect] : [];
      }),
    ]),
  ];
  const prepare = async () => {
    const checks = new Map<string, Awaited<ReturnType<typeof accessCheck>>>();
    // Preparation holds no foreign read checkout. The real Actor is preserved by reference.
    for (const id of keys) {
      const route = routeOf(id)!;
      checks.set(
        id,
        await accessCheck(
          deps.access,
          deps.actor,
          'subject:read',
          {
            route,
            id,
            eligibility: relatedReadEligibility({ route, id }, keys),
          },
          { pool: deps.pool, deadline: deps.deadline },
        ),
      );
    }
    return checks;
  };
  const checkCurrent = async () => {
    const checks = await prepare();
    return withReadTransaction(
      deps.pool,
      async (connection) => {
        // A new wrapper also prevents reuse of eligibility's client-local snapshot cache.
        const client = deadlineClient({ query: connection.query.bind(connection) }, deps.deadline);
        const current = await read(client, keys);
        const allowed = new Set<string>();
        for (const id of keys) {
          const before = observed.get(id),
            now = current.get(id);
          if (JSON.stringify(before) !== JSON.stringify(now)) throw new ProblemError('dependency_unavailable');
          if (now?.visibility === 'visible' && (await checks.get(id)!(client))) allowed.add(id);
        }
        return allowed;
      },
      deps.deadline,
    );
  };
  const allowed = await checkCurrent();
  const resolved = new Map<string, string>();
  for (const id of ids) {
    const original = observed.get(id);
    if (!original || !allowed.has(id)) continue;
    const terminal = original.redirect ?? id;
    const target = observed.get(terminal);
    // A second redirect is unsettled, never evidence for complete empty membership.
    if (target?.redirect) throw new ProblemError('dependency_unavailable');
    if (target && allowed.has(terminal)) resolved.set(id, terminal);
  }
  const terminals = [...new Set(resolved.values())];
  if (terminals.length && !(await activeRelease(deps.pool))) throw new ProblemError('dependency_unavailable');
  // One shared display batch, bounded by the original raw-key allowance.
  const projected = await readSubjectSummaries(deps, terminals);
  const summaries = new Map<string, SubjectSummary | null>();
  for (const id of ids) {
    const terminal = resolved.get(id);
    const summary = terminal ? projected.get(terminal) : null;
    if (terminal && !summary) throw new ProblemError('dependency_unavailable');
    summaries.set(id, summary ?? null);
  }
  return {
    summaries,
    async verify() {
      const current = await checkCurrent();
      // Both positive and negative decisions matter to first-three ordering/exhaustion.
      if (keys.some((id) => allowed.has(id) !== current.has(id))) throw new ProblemError('dependency_unavailable');
    },
  };
}
