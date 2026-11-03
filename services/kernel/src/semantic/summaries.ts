import type { Release } from '@rezics/definitions';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Pool, PoolClient } from 'pg';
import { checkMediaObjects, type CoverReference } from '../content/cover-reference.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { deadlineFor } from '../request/deadline.ts';
import { fenceKey } from './fences.ts';
import { partitionReadClient, partitionReadClients } from '../database/read-snapshot.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartitions } from '../partition/partition.ts';
import { activeRelease, GLOBAL_CONTEXT } from './definitions.ts';
import { accessCheck, type Access, type AccessCheck, type Actor } from '../request/access.ts';
import { relatedReadEligibility } from './eligibility.ts';
import type { Statement } from './item.ts';
import { slotId } from './slots.ts';
import { chooseLabel } from './language.ts';
import readSummaries from './summaries-read.sql';
import readRepresentativeEditions from './summaries-representative-editions.sql';
import { currentReadSnapshot, withReadTransaction } from './read.ts';

export type CoverSummary = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: { x: number; y: number } | null;
  credit: MediaImportRequest['credit'];
};
export type SubjectSummary = {
  id: string;
  type: string;
  types: string[];
  label: { value: string; language: string } | null;
  creativeWork: boolean;
  cover: CoverSummary | null;
};
export type SummaryDependencies = {
  /** Compatibility input; the executor binds the live same-pool snapshot, never a pool.query facade. */
  client: Pick<PoolClient, 'query'>;
  pool: Pool;
  /** Trusted server routing configuration; never selected by the reader. */
  routeKey: Uint8Array;
  deadline?: number;
  /** The active release, resolved once by the caller for the whole page. */
  release: Release;
  authorize: (client: Pick<PoolClient, 'query'>, id: string, batch: readonly string[]) => Promise<boolean>;
  /** Reader suitability policy. Withholding an image never withholds the subject. */
  maySeeCover?: (media: string, subject: string) => boolean;
};
export type SummaryReaderDependencies = {
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  actor: Actor;
  deadline: number;
  maySeeCover?: SummaryDependencies['maySeeCover'];
};
type SummaryAuthorize = SummaryDependencies['authorize'];
type Batches = readonly (readonly string[])[];
type SummarySources = readonly Readonly<{ partition: number; epoch: number; position: bigint }>[];
type ObserveSummaries = (sources: SummarySources, batches: Batches, disclosed: ReadonlySet<string>) => void;

/** Internal composition, never a browser-supplied witness or a cached allow.
 * Each component is an independent native home position, as in Subject reads.
 */
export type SubjectSummaryObservation = Readonly<{
  summaries: ReadonlyMap<string, SubjectSummary | null>;
  current: () => Promise<boolean>;
}>;
const preparations = new WeakMap<SummaryAuthorize, (batches: Batches) => Promise<SummaryAuthorize>>();

/** Preserve the callable related-read adapter, and expose preparation to the batch owner.
 * Preparation never runs while the final snapshot is checked out. Only the returned
 * native checks execute on that snapshot; no allow decision is retained.
 */
export function summaryAuthorization(
  prepare: (id: string, batch: readonly string[]) => Promise<AccessCheck>,
): SummaryAuthorize {
  const authorize: SummaryAuthorize = async (client, id, batch) =>
    routeOf(id) === null ? false : (await prepare(id, batch))(client);
  preparations.set(authorize, async (batches) => {
    const checks = new Map<string, AccessCheck>();
    for (const batch of batches) {
      for (const id of new Set(batch)) {
        if (routeOf(id) !== null && !checks.has(id)) checks.set(id, await prepare(id, batch));
      }
    }
    return async (client, id) => (await checks.get(id)?.(client)) ?? false;
  });
  return authorize;
}

class SummaryPlanChanged extends Error {
  constructor(readonly representatives: Map<string, string>) {
    super('Subject summary representative plan changed');
  }
}

type StoredStatement = Pick<Statement, 'rank' | 'value'> & {
  qualifiers?: { property: string; value: Statement['value'] }[];
};
type Row = {
  id: string;
  type: string;
  labels: Record<string, string>;
  original: string | null;
  choices: { property: string; statement: StoredStatement }[];
};

function content(statement: StoredStatement | undefined): string | null {
  return statement?.value.type === 'value' && typeof statement.value.content === 'string'
    ? statement.value.content
    : null;
}
function image(row: Row): string | null {
  const images = row.choices.filter((choice) => choice.property === 'schema:image').map((choice) => choice.statement);
  return content(images.find((statement) => statement.rank === 'preferred') ?? images[0]!);
}

/** One bounded, shared display projection. Unknown and undisclosed ids remain explicit null entries. */
export async function readSubjectSummaries(
  deps: SummaryDependencies | SummaryReaderDependencies,
  ids: readonly string[],
  { languages = [] }: { languages?: readonly string[] } = {},
): Promise<Map<string, SubjectSummary | null>> {
  return readSummaryBatch(deps, ids, languages);
}

/** Read the ordinary projection and retain its actual source homes for a
 * composing native reader. No owner connection survives the returned promise.
 */
export async function readSubjectSummaryObservation(
  deps: SummaryReaderDependencies,
  ids: readonly string[],
  { languages = [] }: { languages?: readonly string[] } = {},
): Promise<SubjectSummaryObservation> {
  let sources: SummarySources = [];
  let batches: Batches = [];
  let disclosed: ReadonlySet<string> = new Set();
  const summaries = await readSummaryBatch(deps, ids, languages, (observed, selected, visible) => {
    sources = observed;
    batches = selected;
    disclosed = visible;
  });
  return {
    summaries,
    async current() {
      requireAccessDeadline(deps.deadline);
      // Reprepare native disclosure outside the source snapshot. The same
      // initial and representative batches preserve related-read eligibility.
      const checks: AccessCheck[] = [];
      for (const batch of batches) {
        for (const id of new Set(batch)) {
          if (!disclosed.has(id)) continue;
          const route = routeOf(id);
          if (route === null) continue;
          checks.push(
            await accessCheck(
              deps.access,
              deps.actor,
              'subject:read',
              { route, id, eligibility: relatedReadEligibility({ route, id }, batch) },
              { pool: deps.pool, deadline: deps.deadline },
            ),
          );
        }
      }
      return withReadTransaction(
        deps.pool,
        async (client) => {
          await partitionReadClients(
            client,
            sources.map((source) => source.partition),
          );
          const current = new Map(
            (
              await readPartitions(
                client,
                sources.map((source) => source.partition),
              )
            ).map((source) => [source.partitionNo, source]),
          );
          for (const source of sources) {
            const found = current.get(source.partition);
            if (!found || found.epoch !== source.epoch || found.position !== source.position) return false;
          }
          for (const check of checks) if (!(await check(client))) return false;
          return true;
        },
        deps.deadline,
      );
    },
  };
}

async function readSummaryBatch(
  deps: SummaryDependencies | SummaryReaderDependencies,
  ids: readonly string[],
  languages: readonly string[],
  observe?: ObserveSummaries,
): Promise<Map<string, SubjectSummary | null>> {
  if (!(deps.routeKey instanceof Uint8Array) || deps.routeKey.byteLength < 32)
    throw new TypeError('Subject summaries require the server route key');
  if (deps.deadline !== undefined) requireAccessDeadline(deps.deadline);
  if (ids.length > 256) throw new RangeError('Subject summaries accept at most 256 ids');
  const results = new Map<string, SubjectSummary | null>(ids.map((id) => [id, null]));
  if (!ids.length) return results;
  const deadline = deps.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  const authorize =
    'access' in deps
      ? summaryAuthorization(async (id, batch) =>
          accessCheck(
            deps.access,
            deps.actor,
            'subject:read',
            { route: routeOf(id)!, id, eligibility: relatedReadEligibility({ route: routeOf(id)!, id }, batch) },
            { pool: deps.pool, deadline },
          ),
        )
      : deps.authorize;
  const prepare = preparations.get(authorize);
  const owned = currentReadSnapshot(deps.pool);
  // An already-owned snapshot can use previously prepared checks, but must never
  // acquire preparation evidence through another same-pool checkout.
  if (owned && prepare) throw new AccessUnavailableError('contention');
  let plan: Map<string, string> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    requireAccessDeadline(deadline);
    const planned = [...new Set(plan?.values() ?? [])].filter((id) => !results.has(id));
    const ready = prepare ? await prepare([[...results.keys()], planned]) : authorize;
    try {
      return await withReadTransaction(
        deps.pool,
        async (client) => {
          const active = 'access' in deps ? await activeRelease(client) : null;
          if ('access' in deps && !active) {
            await partitionReadClient(client, 0);
            // A composed shelf must distinguish failed preparation from an
            // authentic empty/withheld source observation.
            if (observe) throw new AccessUnavailableError('contention');
            return results;
          }
          const release = 'access' in deps ? active!.release : deps.release;
          return projectSummaries(
            {
              pool: deps.pool,
              routeKey: deps.routeKey,
              ...(deps.maySeeCover ? { maySeeCover: deps.maySeeCover } : {}),
              client,
              release,
              authorize: ready,
              deadline,
            },
            [...results.keys()],
            languages,
            plan,
            Boolean(prepare),
            'access' in deps,
            observe,
          );
        },
        deadline,
      );
    } catch (error) {
      if (!(error instanceof SummaryPlanChanged) || owned) throw error;
      plan = error.representatives;
    }
  }
  throw new AccessUnavailableError('contention');
}

async function projectSummaries(
  storage: SummaryDependencies & { deadline: number },
  ids: readonly string[],
  languages: readonly string[],
  expectedPlan: Map<string, string> | undefined,
  needsPreparation: boolean,
  releaseHome: boolean,
  observe?: ObserveSummaries,
): Promise<Map<string, SubjectSummary | null>> {
  const deps = storage;
  const results = new Map<string, SubjectSummary | null>(ids.map((id) => [id, null]));
  const partitions = new Set<number>(releaseHome ? [0] : []);
  async function read(batch: readonly string[]): Promise<Map<string, Row>> {
    const groups = new Map<number, string[]>();
    for (const id of new Set(batch)) {
      const route = routeOf(id);
      if (route === null) continue;
      const partition = partitionOf(route);
      const group = groups.get(partition) ?? [];
      group.push(id);
      groups.set(partition, group);
    }
    const rows = new Map<string, Row>();
    for (const [partition, group] of groups) {
      const parameters = {
        partition_no: partition,
        context_id: GLOBAL_CONTEXT,
        subjects: group.map((id) => ({
          route: routeOf(id)!,
          id,
          image: slotId(id, 'schema:image'),
          original: slotId(id, 'schema:inLanguage'),
        })),
      };
      const subjects = group.map((id) => ({ route: routeOf(id)!, id }));
      partitions.add(partition);
      const representatives = (
        await readRepresentativeEditions.run(storage.client, { partition_no: partition, subjects })
      ).map((row) => ({ id: row.id, slot_id: row.slot_id, ordinal: Number(row.ordinal) }));
      const summaryParameters = { ...parameters, representatives };
      const found = (await readSummaries.run(storage.client, summaryParameters)) as Row[];
      for (const row of found) if (await storage.authorize(storage.client, row.id, batch)) rows.set(row.id, row);
    }
    return rows;
  }
  const subjects = await read([...results.keys()]);
  const covers = new Map<string, string>();
  const representatives = new Map<string, string>();
  for (const row of subjects.values()) {
    const types = [...new Set([row.type, ...(deps.release.types[row.type]?.bases ?? [])])];
    const label = chooseLabel(row.labels, languages, row.original);
    const creativeWork = types.includes('schema:CreativeWork');
    results.set(row.id, { id: row.id, type: row.type, types, label, creativeWork, cover: null });
    const own = image(row);
    if (own) {
      covers.set(row.id, own);
      continue;
    }
    if (!creativeWork) continue;
    const editions = row.choices
      .filter((choice) => choice.property === 'rezics:representativeEdition')
      .map((choice) => choice.statement);
    const language = (statement: StoredStatement) =>
      statement.qualifiers?.find((part) => part.property === 'schema:inLanguage');
    const selected =
      editions.find((statement) => {
        const qualifier = language(statement);
        return label !== null && qualifier?.value.type === 'value' && qualifier.value.content === label.language;
      }) ??
      editions.find((statement) => !language(statement)) ??
      editions[0];
    if (selected) {
      const edition = content(selected);
      if (edition) representatives.set(row.id, edition);
    }
  }
  // The first attempt may be a bounded planning read. Release it before
  // preparing the newly addressed edition keys; re-read and compare the exact
  // selection under the final snapshot. Churn cannot renew the request budget.
  const changedPlan = expectedPlan
    ? JSON.stringify([...expectedPlan].sort()) !== JSON.stringify([...representatives].sort())
    : [...representatives.values()].some((id) => !results.has(id));
  if (needsPreparation && changedPlan) {
    await partitionReadClients(deps.client, [...partitions]);
    throw new SummaryPlanChanged(representatives);
  }
  const editions = await read([...new Set(representatives.values())].filter((id) => !subjects.has(id)));
  for (const [id, edition] of representatives) {
    const row = subjects.get(edition) ?? editions.get(edition);
    const media = row ? image(row) : null;
    if (media) covers.set(id, media);
  }
  const mediaIds = [
    ...new Set(
      [...covers].filter(([subject, media]) => deps.maySeeCover?.(media, subject) !== false).map(([, media]) => media),
    ),
  ];
  for (const partition of new Set(
    mediaIds.flatMap((id) => {
      const route = routeOf(id);
      return route === null ? [] : [partitionOf(route)];
    }),
  ))
    partitions.add(partition);
  const media: Map<string, CoverReference | null> = mediaIds.length
    ? await checkMediaObjects(deps.client, mediaIds, 'cover')
    : new Map();
  // Read each exact selected source tuple once, in independently anchored homes.
  // Media custody and source fences are facts, not permission or disclosure caches.
  const tuples = new Map<string, SourceFenceTuple>();
  for (const reference of media.values()) {
    if (!reference) continue;
    const { source, external_id, field_group } = reference.source;
    const tuple = { route: tupleRoute(deps.routeKey, source, external_id), source, external_id, field_group };
    tuples.set(fenceKey(tuple), tuple);
  }
  const homes = new Map<number, SourceFenceTuple[]>();
  for (const tuple of tuples.values()) {
    const partition = partitionOf(tuple.route);
    const group = homes.get(partition) ?? [];
    group.push(tuple);
    homes.set(partition, group);
  }
  // The same RR snapshot also binds every home that produced facts, including
  // empty/missing probes. Batched partition metadata is not a cross-home row join.
  const anchored = await partitionReadClients(deps.client, [...partitions, ...homes.keys()]);
  const unfenced = new Set<string>();
  const deadline = deps.deadline;
  for (const [partition, group] of homes) {
    for (let offset = 0; offset < group.length; offset += 100) {
      requireAccessDeadline(deadline);
      const fences = await readFences(anchored.get(partition)!, group.slice(offset, offset + 100));
      requireAccessDeadline(deadline);
      for (const fence of fences) if (!fence.takenDown) unfenced.add(fenceKey(fence));
    }
  }
  requireAccessDeadline(deadline);
  for (const [id, mediaId] of covers) {
    if (deps.maySeeCover?.(mediaId, id) === false) continue;
    const reference = media.get(mediaId);
    const summary = results.get(id);
    if (
      !summary ||
      !reference?.width ||
      !reference.height ||
      !reference.placeholder ||
      !reference.variants ||
      !reference.credit
    )
      continue;
    const { source, external_id, field_group } = reference.source;
    const tuple = { route: tupleRoute(deps.routeKey, source, external_id), source, external_id, field_group };
    if (!unfenced.has(fenceKey(tuple))) continue;
    summary.cover = {
      media: mediaId,
      width: reference.width,
      height: reference.height,
      placeholder: reference.placeholder,
      variants: reference.variants.map((variant) => ({ ...variant })),
      focalPoint: reference.focalPoint ?? null,
      credit: reference.credit,
    };
  }
  if (observe) {
    const sourceHomes = [...new Set([...partitions, ...homes.keys()])];
    observe(
      (await readPartitions(deps.client, sourceHomes)).map((home) => ({
        partition: home.partitionNo,
        epoch: home.epoch,
        position: home.position,
      })),
      [[...results.keys()], [...new Set(representatives.values())].filter((id) => !subjects.has(id))],
      new Set([...subjects.keys(), ...editions.keys()]),
    );
  }
  return results;
}
