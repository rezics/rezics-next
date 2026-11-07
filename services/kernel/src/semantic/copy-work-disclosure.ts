import type { Release } from '@rezics/definitions';
import { deadlineClient, within } from '../access/authenticate.ts';
import { AccessUnavailableError, classifyUnavailability, requireAccessDeadline } from '../access/unavailable.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { partitionReadClients } from '../database/read-snapshot.ts';
import { readPartition, readPartitions } from '../partition/partition.ts';
import { accessCheck, type AccessCheck, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  admittedCopyWork,
  COPY_WORK_DISCLOSURE_LOOKAHEAD,
  COPY_WORK_PROPERTY,
} from './copy-work-disclosure-contract.ts';
import type {
  CopyWorkDisclosureObservation,
  CopyWorkDisclosureRequest,
  CopyWorkDisclosureState,
  CopyWorkReference,
} from './copy-work-disclosure-contract.ts';
import readCopyWorkLocators from './copy-work-disclosure.sql';
import { currentRelationFacts, currentRelationKey, type CurrentRelationCandidate } from './current-relations.ts';
import { activeRelease } from './definitions.ts';
import { relatedReadEligibility, subjectReadEligibility } from './eligibility.ts';
import { candidateSources, fenceKey, sourceTuple } from './fences.ts';
import { readIdentityMappings } from './identity-adapters/identity-epoch-read.ts';
import { isRelationProperty } from './item.ts';
import subjectsSQL from './list-presentation-subjects.sql';
import { withReadTransaction } from './read.ts';
import { readSubjectSummaryObservation, type SubjectSummary, type SubjectSummaryObservation } from './summaries.ts';
import type {
  CopyWorkDisclosureDependencies,
  CopyWorkDisclosureHeader,
  CopyWorkDisclosureNativeReader,
  CopyWorkPartitionCut,
  CopyWorkSourceObservation,
} from './copy-work-reader-port.ts';

export type {
  CopyWorkDisclosureObservation,
  CopyWorkDisclosureRequest,
  CopyWorkDisclosureState,
  CopyWorkReference,
} from './copy-work-disclosure-contract.ts';
export type { CopyWorkDisclosureDependencies } from './copy-work-reader-port.ts';
export {
  COPY_WORK_DISCLOSURE_LOOKAHEAD,
  COPY_WORK_DISCLOSURE_MAX_RAW,
  COPY_WORK_DISCLOSURE_MAX_WORKS,
  COPY_WORK_PROPERTY,
} from './copy-work-disclosure-contract.ts';

type Header = CopyWorkDisclosureHeader;
type Locator = {
  id: string;
  property: string;
  slot: string;
  candidate: string;
  order_key: string;
  source_revision: number;
  source_security_revision: string;
};
type Membership = { kind: 'works'; ids: string[] } | { kind: 'concealed' } | { kind: 'overflow' };
type SourceObservation = CopyWorkSourceObservation;
type PartitionCut = CopyWorkPartitionCut;

function factContent(body: unknown): string | null {
  const value = (body as { value?: { type?: unknown; content?: unknown } } | undefined)?.value;
  return value?.type === 'value' && typeof value.content === 'string' ? value.content : null;
}

const json = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry));

/** Each native home is released before Access preparation or any foreign home. */
async function snapshot<T>(
  deps: CopyWorkDisclosureDependencies,
  home: number,
  work: (client: AccessClient, position: bigint, epoch: number) => Promise<T>,
): Promise<{ value: T; cut: PartitionCut }> {
  return within(deps.deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deps.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, home);
        if (!partition || partition.writeState !== 'active') throw new AccessUnavailableError('contention');
        const value = await work(client, partition.position, partition.epoch);
        requireAccessDeadline(deps.deadline);
        await client.query('COMMIT');
        return { value, cut: { partition: home, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

async function mapIdentities(deps: CopyWorkDisclosureDependencies, ids: readonly string[]) {
  const result = new Map<string, Awaited<ReturnType<typeof readIdentityMappings>>[number]>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const mappings = await readIdentityMappings(deps.pool, batch);
    batch.forEach((id, index) => result.set(id, mappings[index]!));
  }
  return result;
}

async function prepareChecks(deps: CopyWorkDisclosureDependencies, ids: readonly string[]) {
  const checks = new Map<string, AccessCheck>();
  for (const id of ids) {
    if (checks.has(id)) continue;
    const route = routeOf(id);
    if (route === null) continue;
    checks.set(
      id,
      await accessCheck(
        deps.access,
        deps.actor,
        'subject:read',
        { route, id, eligibility: subjectReadEligibility({ route, id }) },
        { pool: deps.pool, deadline: deps.deadline },
      ),
    );
  }
  return checks;
}

async function observeHome(
  deps: CopyWorkDisclosureDependencies,
  release: Release,
  home: number,
  ids: readonly string[],
  checks: ReadonlyMap<string, AccessCheck>,
): Promise<{
  found: Map<string, SourceObservation>;
  tuples: SourceFenceTuple[];
  owners: string[];
  cut: PartitionCut;
}> {
  const observed = await snapshot(deps, home, async (client, _position, epoch) => {
    const headers = new Map(
      (await client.query<Header>(subjectsSQL.sql, [ids.map((id) => routeOf(id)!), ids])).rows.map(
        (row) => [row.id, row] as const,
      ),
    );
    const found = new Map<string, SourceObservation>();
    const visible: string[] = [];
    for (const id of ids) {
      const header = headers.get(id);
      if (!header) continue;
      const check = checks.get(id);
      const allowed = check ? await check(client) : false;
      found.set(id, { header, allowed, membership: null });
      if (header.visibility !== 'visible' || !allowed) continue;
      // A redirect on the observed terminal is unpublished mapping, not hidden membership.
      if (header.redirect) continue;
      if (admittedCopyWork(release, header.type, isRelationProperty) !== 'admitted') continue;
      if (header.revision === null || header.release === null) throw new AccessUnavailableError('contention');
      visible.push(id);
    }
    if (!visible.length) return { found, tuples: [] as SourceFenceTuple[], owners: [] as string[] };
    const checkpoint = (
      await client.query<{ epoch: number; position: string }>(
        'SELECT epoch, position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
        [home, 'semantic_links'],
      )
    ).rows[0];
    if (!checkpoint || checkpoint.epoch !== epoch) throw new AccessUnavailableError('contention');
    for (const id of visible) {
      const header = found.get(id)!.header;
      if (
        header.source_epoch === null ||
        header.source_position === null ||
        header.source_epoch !== epoch ||
        BigInt(checkpoint.position) < BigInt(header.source_position)
      )
        throw new AccessUnavailableError('contention');
    }
    const locators = (
      await client.query<Locator>(readCopyWorkLocators.sql, [
        json(visible.map((id) => ({ route: routeOf(id)!, id, property: COPY_WORK_PROPERTY }))),
        COPY_WORK_DISCLOSURE_LOOKAHEAD,
      ])
    ).rows;
    for (const locator of locators) {
      const header = found.get(locator.id)!.header;
      if (locator.source_revision !== header.revision || locator.source_security_revision !== header.security)
        throw new AccessUnavailableError('contention');
    }
    const bySource = new Map<string, Locator[]>();
    for (const locator of locators) {
      const list = bySource.get(locator.id) ?? [];
      list.push(locator);
      bySource.set(locator.id, list);
    }
    const candidates: CurrentRelationCandidate[] = [];
    for (const id of visible) {
      const group = bySource.get(id) ?? [];
      if (group.length >= COPY_WORK_DISCLOSURE_LOOKAHEAD) {
        found.get(id)!.membership = { kind: 'overflow' };
        continue;
      }
      if (!group.length) {
        found.get(id)!.membership = { kind: 'works', ids: [] };
        continue;
      }
      for (const locator of group)
        candidates.push({
          subject: id,
          property: COPY_WORK_PROPERTY,
          candidate: locator.candidate,
          target: null,
          value: 'value',
          slot: locator.slot,
          requireRelation: true,
        });
    }
    const facts = candidates.length
      ? await currentRelationFacts(client, deps.routeKey, candidates, { sourceFences: 'caller' })
      : new Map();
    const provenance: { route: number; subject_id: string; candidate_id: string; slot_id?: string }[] = [];
    for (const id of visible) {
      if (found.get(id)!.membership) continue;
      const group = bySource.get(id) ?? [];
      const works: string[] = [];
      let concealed = false;
      for (const locator of group) {
        const fact = facts.get(
          currentRelationKey({ subject: id, property: COPY_WORK_PROPERTY, candidate: locator.candidate }),
        );
        const content = fact ? factContent(fact.body) : null;
        if (!content || routeOf(content) === null) {
          concealed = true;
          continue;
        }
        provenance.push({
          route: routeOf(id)!,
          subject_id: id,
          candidate_id: locator.candidate,
          slot_id: locator.slot,
        });
        if (!works.includes(content)) works.push(content);
      }
      found.get(id)!.membership = concealed ? { kind: 'concealed' } : { kind: 'works', ids: works };
    }
    const recorded = provenance.length ? await candidateSources(client, provenance) : new Map();
    const tuples: SourceFenceTuple[] = [];
    const owners: string[] = [];
    for (const entry of provenance) {
      const source = recorded.get(`${entry.subject_id}\n${entry.candidate_id}`) ?? null;
      if (!source) {
        const row = found.get(entry.subject_id);
        if (row?.membership?.kind === 'works') row.membership = { kind: 'concealed' };
        continue;
      }
      if ('kind' in source) {
        if (source.kind !== 'agent' || routeOf(source.subject) === null) {
          const row = found.get(entry.subject_id);
          if (row?.membership?.kind === 'works') row.membership = { kind: 'concealed' };
        }
        continue;
      }
      try {
        tuples.push(sourceTuple(deps.routeKey, source));
        owners.push(entry.subject_id);
      } catch {
        const row = found.get(entry.subject_id);
        if (row?.membership?.kind === 'works') row.membership = { kind: 'concealed' };
      }
    }
    return { found, tuples, owners };
  });
  return { ...observed.value, cut: observed.cut };
}

async function readSummaries(
  deps: CopyWorkDisclosureDependencies,
  ids: readonly string[],
  options: { languages: readonly string[] },
) {
  const summaries = new Map<string, SubjectSummary | null>();
  const components: SubjectSummaryObservation['components'][number][] = [];
  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = ids.slice(offset, offset + 256);
    const observed = await readSubjectSummaryObservation(deps, batch, options);
    for (const [id, summary] of observed.summaries) summaries.set(id, summary);
    components.push(...observed.components);
  }
  return { summaries, components };
}

/** One exported native batch: current admitted copy/release-to-work membership, never a guessed primary work. */
export function createCopyWorkDisclosureNativeReader(): CopyWorkDisclosureNativeReader {
  return Object.freeze({
    requireDeadline: requireAccessDeadline,
    withinDeadline: <T>(deadline: number, work: () => Promise<T>) => within(deadline, work),
    async readActiveRelease(deps) {
      const active = (
        await snapshot(deps, 0, async (client) => {
          const release = await activeRelease(client);
          if (!release) throw new AccessUnavailableError('contention');
          return release;
        })
      ).value;
      return active;
    },
    async readIdentityMappings(deps, ids) {
      return mapIdentities(deps, ids);
    },
    async prepareChecks(deps, ids) {
      return prepareChecks(deps, ids);
    },
    async observeHome(deps, release, home, ids, checks) {
      return observeHome(deps, release, home, ids, checks);
    },
    async readTakenFenceKeys(deps, tuples) {
      const byHome = new Map<number, SourceFenceTuple[]>();
      for (const tuple of tuples) {
        const home = partitionOf(tuple.route);
        const list = byHome.get(home) ?? [];
        list.push(tuple);
        byHome.set(home, list);
      }
      const taken = new Set<string>();
      for (const [home, sourceTuples] of byHome) {
        const unique = [...new Map(sourceTuples.map((tuple) => [fenceKey(tuple), tuple])).values()];
        const rows = (
          await snapshot(deps, home, async (client) => {
            const found = [];
            for (let offset = 0; offset < unique.length; offset += 100)
              found.push(...(await readFences(client, unique.slice(offset, offset + 100))));
            return found;
          })
        ).value;
        for (const row of rows) if (row.takenDown) taken.add(fenceKey(row));
      }
      return taken;
    },
    async readSummaries(deps, ids, options) {
      return readSummaries(deps, ids, options);
    },
    observation: nativeObservation,
    isUnavailable(error) {
      return error instanceof AccessUnavailableError || classifyUnavailability(error) !== undefined;
    },
    isRelationProperty,
    fenceKey,
  });
}

export { readCopyWorkDisclosure } from './copy-work-application.ts';

function nativeObservation(
  deps: CopyWorkDisclosureDependencies,
  results: Map<string, CopyWorkDisclosureState>,
  cuts: readonly PartitionCut[],
  digest: string | null,
  head: number | null,
): CopyWorkDisclosureObservation {
  const components = cuts;
  const disclosed = [...results.entries()].flatMap(([id, state]) => {
    if (state.state === 'available') return [id, ...state.works.map((work) => work.id)];
    return state.state === 'scope' || state.state === 'unsupported' ? [id] : [];
  });
  return {
    results,
    async current() {
      return within(deps.deadline, async () => {
        requireAccessDeadline(deps.deadline);
        const active = (
          await snapshot(deps, 0, async (client) => {
            const release = await activeRelease(client);
            if (!release) return null;
            return release;
          })
        ).value;
        if (!active || active.digest !== digest || active.head !== head) return false;
        const unique = [...new Set(disclosed.filter((id) => routeOf(id) !== null))];
        const checks: AccessCheck[] = [];
        for (const id of unique) {
          const route = routeOf(id)!;
          checks.push(
            await accessCheck(
              deps.access,
              deps.actor,
              'subject:read',
              {
                route,
                id,
                eligibility: relatedReadEligibility({ route, id }, unique),
              },
              { pool: deps.pool, deadline: deps.deadline },
            ),
          );
        }
        return withReadTransaction(
          deps.pool,
          async (client) => {
            if (components.length)
              await partitionReadClients(
                client,
                components.map((cut) => cut.partition),
              );
            const current = new Map(
              (
                await readPartitions(
                  client,
                  components.map((cut) => cut.partition),
                )
              ).map((row) => [row.partitionNo, row]),
            );
            for (const cut of components) {
              const found = current.get(cut.partition);
              if (!found || found.epoch !== cut.epoch || found.position !== cut.position) return false;
            }
            for (const check of checks) if (!(await check(client))) return false;
            return true;
          },
          deps.deadline,
        );
      });
    },
  };
}
