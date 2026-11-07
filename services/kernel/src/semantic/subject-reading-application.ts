import type { AccessWorkAccounting } from '../access/work.ts';
import type { Release } from '@rezics/definitions';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Pool, PoolClient } from 'pg';
import type { ContentCoverRef, ContentImportedFieldGroup } from './contract/domain-ports.ts';
import type { SubjectComponent } from './contract/subject-values.ts';
import { GLOBAL_SUBJECT_CONTEXT } from './contract/subject-values.ts';
import type {
  SubjectReadingAuthorizationPort,
  SubjectReadingNativePort,
  SubjectReadingFenceTuple,
  SubjectReadingFence,
} from './contract/index.ts';
import type { ContextRecord } from './context.ts';
import { fencedIds, fenceKey, type CandidateSource } from './fences.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionReadClient, partitionReadClients } from '../database/read-snapshot.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartitions, readPartition } from '../partition/partition.ts';
import {
  accessCheck,
  type Access,
  type AccessCheck,
  type AccessClient,
  type Actor,
  type Resource,
} from '../request/access.ts';
import { relatedReadEligibility, subjectReadEligibility } from './eligibility.ts';
import { factDataTypes, isRelationProperty, resolveItem, type FactRow, type Item, type Statement } from './item.ts';
import { slotId, slotView } from './slots.ts';
import { chooseLabel } from './language.ts';
import readSummaries from './summaries-read.sql';
import readRepresentativeEditions from './summaries-representative-editions.sql';
import { currentReadSnapshot, withReadTransaction } from './read.ts';
import { SubjectRedirectError } from './contract/subject-errors.ts';
import {
  selectedSynopsisFact,
  redactSynopsisFact,
  type SelectedSynopsisInput,
  type SelectedSynopsisResult,
} from './selected-synopsis.ts';
import {
  observeReviewedPersonIdentity,
  type ReviewedPersonEndpoint,
  type ReviewedPersonSource,
} from './reviewed-person-identity.ts';
import { privateLinks, refreshStatementReaderAuthorization } from './statement-disclosure.ts';
import { currentRelationFacts, currentRelationKey } from './current-relations.ts';
import { readSourceRecords } from './source-records.ts';
import { waitForSubjectLinks } from './link-freshness.ts';
import readSubjectIdentity from './read-subject-identity.sql';
import readSubjectStatement from './read-subject.sql';
import readHiddenStatement from './subject-read-hidden.sql';
import listOutboundLinks from './list-outbound-links-by-property.sql';
import readSourceMembers from './source-records-members.sql';
import { loadRelated, readRelated as readRelatedNative } from './related-subject-read.ts';
export type { RelatedState } from './related-subject-read.ts';
import { RELATED_SUBJECT_BATCH_LIMIT as BATCH_LIMIT } from './contract/subject-values.ts';
import { withConnection } from '../database/pool.ts';
import { memoizedValue } from '../memoized.ts';
import {
  authorizedContextMetadata,
  contextNativeActions,
  ContextDirectoryPreparingError,
} from './context-application.ts';
import {
  readViewerActions,
  type ViewerActionBinding,
  type ViewerActionBindings,
  type ViewerActionResource,
  type ViewerActionResources,
} from '../access/index.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import readSubjectPublicStatesStatement from './viewer-actions.sql';

export type SubjectReadingRuntime = Readonly<{
  pool: Pool;
  access: Access;
  actor: Actor;
  routeKey: Uint8Array;
  deadline: number;
  clock: () => Date;
  work?: AccessWorkAccounting;
}>;

type SubjectDocumentRead = {
  document: {
    availability: string;
    subjectId: string;
    candidateId: string;
    digest: string;
    language: string;
  } | null;
  anchors: readonly { partition: { partitionNo: number }; epoch: number; position: bigint }[];
} | null;
type SubjectCharacterDocumentsRead = {
  documents: Record<string, unknown>;
  anchors: readonly { partition: { partitionNo: number }; epoch: number; position: bigint }[];
};
export type SubjectReadingPorts = SubjectReadingNativePort<
  SubjectReadingRuntime,
  Pool | Pick<PoolClient, 'query'>,
  Release,
  ContextRecord,
  SubjectDocumentRead,
  SubjectCharacterDocumentsRead,
  ContentCoverRef,
  SubjectFenceTuple,
  SubjectFence
>;

type SubjectFenceTuple = SubjectReadingFenceTuple & { field_group: ContentImportedFieldGroup };
type SubjectFence = SubjectReadingFenceTuple & { field_group: ContentImportedFieldGroup } & SubjectReadingFence;

export type SubjectReadOptions = {
  reviewIdentity?: ReviewedPersonSource;
  selectedSynopsis?: { input: SelectedSynopsisInput; admit: () => Promise<boolean> };
  languages?: readonly string[];
  authorize?: SummaryDependencies['authorize'];
  seen?: readonly SubjectComponent[];
  deadline?: number;
  prepareAuthorization?: () => Promise<AccessCheck>;
  prepareAuthorize?: (id: string) => Promise<AccessCheck>;
  readAs?: <T>(read: () => Promise<T>) => Promise<T>;
};
export type SubjectReadResult = {
  selectedSynopsis?: SelectedSynopsisResult;
  reviewedIdentity?: ReviewedPersonEndpoint | null;
  subject: Item;
  account: { id: string } | null;
  summary: SubjectSummary | null;
  component: SubjectComponent;
};
export type SubjectSummaryReader = (
  deps: SummaryDependencies | SummaryReaderDependencies,
  ids: readonly string[],
  options?: { languages?: readonly string[] },
) => Promise<Map<string, SubjectSummary | null>>;
export type SubjectReadingPageRequest = {
  runtime: SubjectReadingRuntime;
  subject: string;
  context: string;
  languages: readonly string[];
  authorization: SubjectReadingAuthorizationPort<AccessCheck>;
  runNative: <T>(read: () => Promise<T>) => Promise<T>;
  readAs: <T>(read: () => Promise<T>) => Promise<T>;
  seen: readonly SubjectComponent[];
  selectedSynopsis?: SelectedSynopsisInput;
  reviewIdentity?: ReviewedPersonSource;
  includeViewerActions?: boolean;
  includeDocuments?: boolean;
  viewerActionBindings?: ViewerActionBindings;
};
export type SubjectReadingPageAnswer = {
  subject: Item;
  selectedSynopsis?: SelectedSynopsisResult;
  reviewedIdentity?: ReviewedPersonEndpoint | null;
  account: { id: string } | null;
  summary: SubjectSummary | null;
  related: Record<
    string,
    {
      labels: Record<string, string>;
      redirect?: string;
      type?: string;
      types?: string[];
      cover?: CoverSummary | null;
    }
  >;
  documents?: Record<string, unknown>;
  viewerActions?:
    | { state: 'available'; actions: { action: string; operations: string[] }[] }
    | { state: 'unavailable' };
};
export type SubjectReadingPageResult =
  | { kind: 'not-found' }
  | { kind: 'redirect'; from: string; to: string }
  | {
      kind: 'answer';
      answer: SubjectReadingPageAnswer;
      revision: number;
      anchors: readonly SubjectComponent[];
      private: boolean;
    };

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
/** A merged original keeps its id; its summary is the survivor's and `redirect` names that survivor. */
export type RelatedSubjectSummary = SubjectSummary & { redirect?: string };
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
  work?: AccessWorkAccounting;
  maySeeCover?: SummaryDependencies['maySeeCover'];
};
type SummaryAuthorize = SummaryDependencies['authorize'];
type Batches = readonly (readonly string[])[];
type SummarySources = readonly Readonly<{ partition: number; epoch: number; position: bigint }>[];
export type SummaryCoverState = 'available' | 'absent' | 'concealed';
type ObserveSummaries = (
  sources: SummarySources,
  batches: Batches,
  disclosed: ReadonlySet<string>,
  covers: ReadonlyMap<string, SummaryCoverState>,
) => void;

/** Internal composition, never a browser-supplied witness or a cached allow.
 * Each component is an independent native home position, as in Subject reads.
 */
export type SubjectSummaryObservation = Readonly<{
  summaries: ReadonlyMap<string, SubjectSummary | null>;
  covers: ReadonlyMap<string, SummaryCoverState>;
  components: SummarySources;
  current: () => Promise<boolean>;
}>;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
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
async function readSubjectSummaries(
  ports: SubjectReadingPorts,
  deps: SummaryDependencies | SummaryReaderDependencies,
  ids: readonly string[],
  { languages = [] }: { languages?: readonly string[] } = {},
): Promise<Map<string, SubjectSummary | null>> {
  return readSummaryBatch(ports, deps, ids, languages);
}

/** Read the ordinary projection and retain its actual source homes for a
 * composing native reader. No owner connection survives the returned promise.
 */
async function readSubjectSummaryObservation(
  ports: SubjectReadingPorts,
  deps: SummaryReaderDependencies,
  ids: readonly string[],
  { languages = [], displayFallback = false }: { languages?: readonly string[]; displayFallback?: boolean } = {},
): Promise<SubjectSummaryObservation> {
  let sources: SummarySources = [];
  let batches: Batches = [];
  let disclosed: ReadonlySet<string> = new Set();
  let covers: ReadonlyMap<string, SummaryCoverState> = new Map();
  const summaries = await readSummaryBatch(
    ports,
    deps,
    ids,
    languages,
    (observed, selected, visible, states) => {
      sources = observed;
      batches = selected;
      disclosed = visible;
      covers = states;
    },
    boundedLabelLanguages(languages),
    displayFallback,
  );
  return {
    summaries,
    covers,
    components: sources,
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
              { pool: deps.pool, deadline: deps.deadline, ...(deps.work ? { work: deps.work } : {}) },
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
  ports: SubjectReadingPorts,
  deps: SummaryDependencies | SummaryReaderDependencies,
  ids: readonly string[],
  languages: readonly string[],
  observe?: ObserveSummaries,
  labelLanguages?: readonly string[],
  displayFallback = false,
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
            { pool: deps.pool, deadline, ...(deps.work ? { work: deps.work } : {}) },
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
          const active = 'access' in deps ? await ports.readActiveRelease(client) : null;
          if ('access' in deps && !active) {
            await partitionReadClient(client, 0);
            // A composed shelf must distinguish failed preparation from an
            // authentic empty/withheld source observation.
            if (observe) throw new AccessUnavailableError('contention');
            return results;
          }
          const release = 'access' in deps ? active!.release : deps.release;
          return projectSummaries(
            ports,
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
            labelLanguages,
            displayFallback,
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

/** Keep composed presentation reads to a fixed set of exact language keys.
 * Include bounded RFC 4647 fallbacks and English; the owner adds the source
 * language separately, so a reader never materializes every label language.
 */
function boundedLabelLanguages(languages: readonly string[]): string[] {
  const selected = new Set<string>(['en']);
  for (const language of languages.slice(0, 16)) {
    const parts = language.toLowerCase().split('-');
    while (parts.length && selected.size < 64) {
      selected.add(parts.join('-'));
      parts.pop();
      if (parts.at(-1)?.length === 1) parts.pop();
    }
  }
  return [...selected].slice(0, 64);
}

async function projectSummaries(
  ports: SubjectReadingPorts,
  storage: SummaryDependencies & { deadline: number },
  ids: readonly string[],
  languages: readonly string[],
  expectedPlan: Map<string, string> | undefined,
  needsPreparation: boolean,
  releaseHome: boolean,
  observe?: ObserveSummaries,
  labelLanguages?: readonly string[],
  displayFallback = false,
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
        context_id: GLOBAL_SUBJECT_CONTEXT,
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
      const found = (await readSummaries.run(storage.client, {
        ...summaryParameters,
        bounded_labels: labelLanguages !== undefined,
        label_languages: [...(labelLanguages ?? [])],
        display_fallback: displayFallback,
      })) as Row[];
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
  const lifecycle = ports;
  const media: ReadonlyMap<string, ContentCoverRef | null> = mediaIds.length
    ? await lifecycle.checkCovers(deps.client, mediaIds)
    : new Map<string, ContentCoverRef | null>();
  // Read each exact selected source tuple once, in independently anchored homes.
  // Media custody and source fences are facts, not permission or disclosure caches.
  const tuples = new Map<string, SubjectFenceTuple>();
  for (const reference of media.values()) {
    if (!reference) continue;
    const { source, external_id, field_group } = reference.source;
    const tuple = {
      route: lifecycle.importedTupleRoute(deps.routeKey, source, external_id),
      source,
      external_id,
      field_group,
    };
    tuples.set(fenceKey(tuple), tuple);
  }
  const homes = new Map<number, SubjectFenceTuple[]>();
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
      const fences = await ports.readCoverFences(anchored.get(partition)!, group.slice(offset, offset + 100));
      requireAccessDeadline(deadline);
      for (const fence of fences) if (!fence.takenDown) unfenced.add(fenceKey(fence));
    }
  }
  requireAccessDeadline(deadline);
  const coverStates = new Map<string, SummaryCoverState>(
    ids.map((id) => [id, subjects.has(id) ? 'absent' : 'concealed']),
  );
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
    const tuple = {
      route: lifecycle.importedTupleRoute(deps.routeKey, source, external_id),
      source,
      external_id,
      field_group,
    };
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
    if (results.has(id)) coverStates.set(id, 'available');
  }
  for (const id of ids) if (covers.has(id) && coverStates.get(id) !== 'available') coverStates.set(id, 'concealed');
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
      coverStates,
    );
  }
  return results;
}

// Native Subject projection and related identity reads moved behind the supplied-port application.
type SubjectReadRow = {
  id: string;
  account: string | null;
  redirect: string | null;
  type: string;
  revision: number;
  security_revision: string;
  release: string;
  fact_revision: number | null;
  fact_release: string | null;
  slot_id: string | null;
  log_seq: number | null;
  operation: FactRow['operation'] | null;
  kind: FactRow['kind'] | null;
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};

function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

function asFacts(rows: readonly SubjectReadRow[]): FactRow[] {
  return rows.flatMap((row) =>
    row.slot_id === null || row.log_seq === null || row.operation === null || row.kind === null
      ? []
      : [
          {
            slot_id: row.slot_id,
            log_seq: row.log_seq,
            operation: row.operation,
            kind: row.kind,
            language: row.language,
            property: row.property,
            statement_id: row.statement_id,
            body: row.body,
            fact_revision: row.fact_revision,
            fact_release: row.fact_release,
          },
        ],
  );
}

/** Fold terms first: fencing a final put must never resurrect an older put. */
function currentTerms(facts: FactRow[]): FactRow[] {
  const live = new Map<string, FactRow>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.kind, fact.language, fact.kind === 'alias' ? fact.body : null]);
    if (fact.operation === 'retract') live.delete(key);
    else if (fact.operation === 'assert' && (fact.kind !== 'alias' || !live.has(key))) live.set(key, fact);
  }
  return [...live.values()];
}

type SupportedFact = { fact: FactRow; source: CandidateSource | null };

/** Exact immutable revision locators for the final terms and selected statements only. */
async function supportedFacts(
  client: PoolClient,
  routeKey: Uint8Array | undefined,
  subject: string,
  facts: FactRow[],
): Promise<SupportedFact[]> {
  const revisions = [...new Set(facts.flatMap((fact) => (fact.fact_revision ? [fact.fact_revision] : [])))];
  const rows = listed(
    (await readHiddenStatement.run(client, {
      route: routeOf(subject)!,
      subject_id: subject,
      revisions,
    })) as
      | { revision: number; source: CandidateSource | null }[]
      | { revision: number; source: CandidateSource | null }
      | null,
  );
  const sources = new Map(rows.map((row) => [row.revision, row.source]));
  const supported = facts.flatMap((fact) => {
    const revision = fact.fact_revision;
    return revision === null || revision === undefined || !sources.has(revision)
      ? []
      : [{ fact, source: sources.get(revision) ?? null }];
  });
  const gone = routeKey
    ? await fencedIds(
        client,
        routeKey,
        supported.map((row, index) => ({ id: String(index), source: row.source })),
      )
    : new Set<string>();
  return supported.filter((_, index) => !gone.has(String(index)));
}

/** Foreign item snaks need current original and terminal disclosure as well as the holder's permission. */
async function disclosedTargets(
  pool: Pool,
  release: Release,
  supported: SupportedFact[],
  authorize: SummaryDependencies['authorize'] | undefined,
): Promise<SupportedFact[]> {
  const types = factDataTypes(
    release,
    supported.map((row) => row.fact),
  );
  const targets = (fact: FactRow): string[] => {
    if (fact.kind !== 'statement') return [];
    const body = fact.body as {
      value: { type: string; content?: unknown };
      qualifiers: { property: string; value: { type: string; content?: unknown } }[];
      references: { parts: { property: string; value: { type: string; content?: unknown } }[] }[];
    };
    return [
      { property: fact.property!, value: body.value },
      ...body.qualifiers,
      ...body.references.flatMap((ref) => ref.parts),
    ].flatMap((snak) =>
      types[snak.property] === 'wikibase-item' && snak.value.type === 'value' && typeof snak.value.content === 'string'
        ? [snak.value.content]
        : [],
    );
  };
  const pending = [...new Set(supported.flatMap((row) => targets(row.fact)))];
  // The Subject transport already accepts at most 256 related identities. Enforce
  // that boundary before preparing Access evidence at any of their homes.
  if (pending.length > BATCH_LIMIT) throw new TypeError('A related read accepts at most 256 ids');
  if (!pending.length) return supported;
  // No owner is checked out while Access prepares evidence, including on a max-one pool.
  const client = { query: pool.query.bind(pool) };
  const allowed = new Map<string, boolean>();
  const visiting = new Set<string>();
  const check = async (id: string): Promise<boolean> => {
    if (allowed.has(id)) return allowed.get(id)!;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const state = (await loadRelated(client, [id])).get(id);
    const visible =
      state?.visibility === 'visible' &&
      (!authorize || (await authorize(client, id, [id]))) &&
      (!state.redirect || (await check(state.redirect)));
    visiting.delete(id);
    allowed.set(id, !!visible);
    return !!visible;
  };
  for (const id of pending) await check(id);
  return supported.filter((row) => targets(row.fact).every((id) => allowed.get(id)));
}

async function readSubjectNative(
  ports: SubjectReadingPorts,
  readSummaries: SubjectSummaryReader,
  pool: Pool,
  id: string,
  authorize: (client: PoolClient) => Promise<boolean>,
  context = GLOBAL_SUBJECT_CONTEXT,
  routeKey: Uint8Array,
  summaries: SubjectReadOptions = {},
): Promise<SubjectReadResult | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const contextRecord = context === GLOBAL_SUBJECT_CONTEXT ? null : await ports.readContextSnapshot(pool, context);
  if (context !== GLOBAL_SUBJECT_CONTEXT && !contextRecord) return null;
  const defaults = contextRecord?.defaults ?? {};
  const active = await ports.readActiveRelease(pool);
  const deadline = summaries.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  const readSnapshot = async (subjectId: string, terminal?: string) => {
    const route = routeOf(subjectId)!;
    const readOriginal = async () => {
      const prepare = () =>
        summaries.prepareAuthorize
          ? summaries.prepareAuthorize(subjectId)
          : summaries.prepareAuthorization
            ? summaries.prepareAuthorization()
            : Promise.resolve(authorize);
      const initialAuthorize = await prepare();
      const preflight = await withReadTransaction(pool, async (client) => {
        const identity = await readSubjectIdentity.run(client, {
          route,
          subject_id: subjectId,
          partition_no: partitionOf(route),
        });
        if (!identity || identity.visibility !== 'visible' || !(await initialAuthorize(client))) return null;
        if (identity.redirect && identity.redirect !== terminal)
          throw new SubjectRedirectError(subjectId, identity.redirect);
        return {
          component: { partition: identity.partitionNo, epoch: identity.epoch, position: BigInt(identity.position) },
          revision: identity.revision,
          securityRevision: BigInt(identity.securityRevision),
        };
      });
      if (!preflight) return null;
      await waitForSubjectLinks(pool, [...(summaries.seen ?? []), preflight.component], subjectId, deadline);
      await refreshStatementReaderAuthorization();
      let check = await prepare();
      let expectedRevision = preflight.revision;
      let expectedSecurityRevision = preflight.securityRevision;
      const readCurrent = () =>
        withReadTransaction(pool, async (client) => {
          const partition = await readPartition(client, partitionOf(route));
          if (!partition) return null;
          const rows = listed(
            (await readSubjectStatement.run(client, { route, subject_id: subjectId })) as
              | SubjectReadRow[]
              | SubjectReadRow
              | null,
          );
          if (!rows.length) {
            return null;
          }
          const allowed = await check(client);
          if (!allowed) return null;
          if (rows[0]!.redirect && rows[0]!.redirect !== terminal)
            throw new SubjectRedirectError(subjectId, rows[0]!.redirect);
          const securityRevision = BigInt(rows[0]!.security_revision);
          if (rows[0]!.revision !== expectedRevision || securityRevision !== expectedSecurityRevision)
            return {
              freshnessRetry: true as const,
              component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
              revision: rows[0]!.revision,
              securityRevision,
            };
          const stored = await ports.readRelease(client, rows[0]!.release);
          if (!stored) throw new Error('Subject revision release is missing');
          // The Context's own relation types show with the subject's release; reads never register the digest.
          const layer = await ports.layerRelease(client, { digest: rows[0]!.release, release: stored }, context);
          const release = layer.release;
          let statementFacts: FactRow[] = [];
          const resolution: Record<string, 'unresolved' | 'suppressed'> = {};
          const relationCounts: Record<string, number> = {};
          if (allowed) {
            const properties = release.types[rows[0]!.type]!.properties;
            for (const property of properties) {
              if (!isRelationProperty(release, property)) {
                const view = await slotView(client, subjectId, property, context, defaults);
                statementFacts.push(...view.facts);
                if (view.resolution) resolution[property] = view.resolution;
                continue;
              }
              const preview = (await listOutboundLinks.run(client, {
                context_id: context,
                route,
                subject_id: subjectId,
                property,
                filter_value: NIL_UUID,
                after_order: '',
                after_target: NIL_UUID,
                after_statement: NIL_UUID,
                page_limit: 13,
              })) as {
                slot: string;
                statement: string;
                target: string | null;
                external: string | null;
                value: 'value' | 'somevalue' | 'novalue';
                order_key: string;
              }[];
              // Resolution describes omitted Global slots too. Keep that diagnostic at
              // the same bounded Global preview it used before Context projection rows.
              if (context !== GLOBAL_SUBJECT_CONTEXT) {
                const inheritedPreview = (await listOutboundLinks.run(client, {
                  context_id: GLOBAL_SUBJECT_CONTEXT,
                  route,
                  subject_id: subjectId,
                  property,
                  filter_value: NIL_UUID,
                  after_order: '',
                  after_target: NIL_UUID,
                  after_statement: NIL_UUID,
                  page_limit: 12,
                })) as { slot: string }[];
                for (const entry of inheritedPreview) {
                  const view = await slotView(client, subjectId, property, context, defaults, entry.slot);
                  if (view.resolution) resolution[property] = view.resolution;
                }
              }
              const privatePage = await privateLinks(client, { subject: subjectId, property, limit: 13 });
              const privatePreview = privatePage.entries.map((row) => ({
                slot: row.slot_id,
                statement: row.candidate_id,
                target: row.target_id,
                external: null,
                value: 'value' as const,
                order_key: row.order_key,
              }));
              const combined = [...preview, ...privatePreview].sort((a, b) =>
                a.order_key < b.order_key
                  ? -1
                  : a.order_key > b.order_key
                    ? 1
                    : (a.target ?? NIL_UUID) < (b.target ?? NIL_UUID)
                      ? -1
                      : (a.target ?? NIL_UUID) > (b.target ?? NIL_UUID)
                        ? 1
                        : a.statement.localeCompare(b.statement),
              );
              const selected = combined.slice(0, 12);
              const filterProperties = release.properties[property]?.relation?.filter;
              const current = await currentRelationFacts(
                client,
                routeKey,
                selected.map((entry) => ({
                  subject: subjectId,
                  property,
                  candidate: entry.statement,
                  target: entry.target,
                  external: entry.external,
                  value: entry.value,
                  context,
                  defaults,
                  slot: entry.slot,
                  ...(filterProperties === undefined
                    ? {}
                    : { filterProperties: Array.isArray(filterProperties) ? filterProperties : [filterProperties] }),
                  requireRelation: true,
                })),
              );
              for (const entry of selected) {
                const fact = current.get(
                  currentRelationKey({ subject: subjectId, property, candidate: entry.statement }),
                );
                if (fact) statementFacts.push(fact);
                else {
                  const view = await slotView(client, subjectId, property, context, defaults, entry.slot);
                  if (view.resolution) resolution[property] = view.resolution;
                }
              }
            }
          }
          if (!allowed) return null;
          return {
            freshnessRetry: false as const,
            reviewedIdentity:
              summaries.reviewIdentity && subjectId === id && !terminal
                ? await observeReviewedPersonIdentity(client, subjectId, summaries.reviewIdentity, routeKey, release)
                : null,
            rows,
            supported: await supportedFacts(client, routeKey, subjectId, [
              ...currentTerms(asFacts(rows)),
              ...statementFacts,
            ]),
            members: terminal
              ? []
              : (await readSourceMembers.run(client, { route, subject_id: subjectId })).map((row) => row.member_id),
            release,
            layerDigest: layer.digest,
            component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
            resolution,
            relationCounts,
          };
        });
      let snapshot = await readCurrent();
      while (snapshot?.freshnessRetry) {
        expectedRevision = snapshot.revision;
        expectedSecurityRevision = snapshot.securityRevision;
        requireAccessDeadline(deadline);
        await waitForSubjectLinks(pool, [...(summaries.seen ?? []), snapshot.component], subjectId, deadline);
        requireAccessDeadline(deadline);
        await refreshStatementReaderAuthorization();
        check = await prepare();
        snapshot = await readCurrent();
      }
      return snapshot;
    };
    return summaries.readAs ? summaries.readAs(readOriginal) : readOriginal();
  };
  const snapshot = await readSnapshot(id);
  if (!snapshot) return null;
  const { rows, component, release, layerDigest, resolution, relationCounts } = snapshot;
  const supported = await disclosedTargets(pool, release, snapshot.supported, summaries.authorize);
  // Membership is current identity state, never revision/candidate history. Each admitted original
  // contributes only live displayed terms and selected slots, with fresh original Access and fences.
  const termKeys = new Map<string, unknown>();
  const factKeys = new Map<string, number>();
  const displayed: FactRow[] = [];
  const proof: SupportedFact[] = [];
  const key = (fact: FactRow) => {
    if (fact.kind !== 'statement')
      return JSON.stringify([fact.kind, fact.language, fact.kind === 'alias' ? fact.body : null]);
    const body = fact.body as Record<string, unknown>;
    return JSON.stringify([fact.property, body.value, body.qualifiers, body.references]);
  };
  const add = (entries: SupportedFact[], original = false) => {
    for (const entry of entries) {
      const fact = entry.fact;
      const identity = key(fact);
      if (fact.kind !== 'statement') {
        if (termKeys.has(identity) && termKeys.get(identity) !== fact.body) continue;
        if (!termKeys.has(identity)) {
          termKeys.set(identity, fact.body);
          displayed.push(fact);
        }
      } else if (!original || !factKeys.has(identity)) {
        const count = displayed.filter((row) => row.kind === 'statement' && row.property === fact.property).length;
        if (original && count >= (isRelationProperty(release, fact.property!) ? 12 : 32)) continue;
        factKeys.set(identity, displayed.length);
        displayed.push(fact);
      }
      proof.push(entry);
    }
  };
  add(supported);
  for (const member of snapshot.members) {
    const original = await readSnapshot(member, id);
    if (!original) continue;
    add(await disclosedTargets(pool, original.release, original.supported, summaries.authorize), true);
  }
  const dataTypes = factDataTypes(release, displayed);
  const subject = resolveItem(id, displayed, rows[0]!.type, dataTypes, {
    revision: rows[0]!.revision,
    release: layerDigest,
    context,
    resolution,
    relationCounts,
  });
  if (routeKey)
    subject.sourceRecords = await readSourceRecords(
      pool,
      routeKey,
      proof.flatMap((row) =>
        row.source && 'source' in row.source && typeof row.source.source === 'string' ? [row.source] : [],
      ),
    );
  const summary = active
    ? ((
        await readSummaries(
          {
            client: { query: pool.query.bind(pool) },
            pool,
            routeKey,
            deadline,
            release: active.release,
            authorize:
              summaries.authorize ??
              (async (connection, subject) => subject === id && authorize(connection as PoolClient)),
          },
          [id],
          { languages: summaries.languages ?? [] },
        )
      ).get(id) ?? null)
    : null;
  // The display projection is independent of the fenced statement view. Recheck
  // its selected media's exact source home before disclosing the cover metadata.
  if (summary?.cover && routeKey) {
    const lifecycle = ports;
    const media = await lifecycle.checkCover({ query: pool.query.bind(pool) }, summary.cover.media);
    if (!media?.source) summary.cover = null;
    else {
      const { source, external_id, field_group } = media.source;
      const tuple = {
        route: lifecycle.importedTupleRoute(routeKey, source, external_id),
        source,
        external_id,
        field_group,
      };
      const [fence] = await ports.readAnchoredCoverFences(pool, partitionOf(tuple.route), [tuple]);
      if (!fence || fence.takenDown) summary.cover = null;
    }
    requireAccessDeadline(deadline);
  }
  let selectedSynopsis: SelectedSynopsisResult | undefined;
  if (summaries.selectedSynopsis) {
    const { input, admit } = summaries.selectedSynopsis;
    selectedSynopsis = { kind: 'changed' };
    if (context !== GLOBAL_SUBJECT_CONTEXT || input.context !== GLOBAL_SUBJECT_CONTEXT || input.realm) {
      selectedSynopsis = { kind: 'unsupported' };
    } else {
      const fact =
        input.pageRelease && input.pageRelease !== active?.digest ? undefined : selectedSynopsisFact(subject, input);
      if (fact && (await admit())) {
        // Content has released every home before this final authoritative Semantic pass.
        await refreshStatementReaderAuthorization();
        const check = summaries.prepareAuthorize ? await summaries.prepareAuthorize(id) : authorize;
        const pageRelease = input.pageRelease ? await ports.readActiveRelease(pool) : undefined;
        const final = await withReadTransaction(
          pool,
          async (client) => {
            if (input.pageRelease && pageRelease?.digest !== input.pageRelease) return null;
            const identity = await readSubjectIdentity.run(client, {
              route,
              subject_id: id,
              partition_no: partitionOf(route),
            });
            if (
              !identity ||
              identity.visibility !== 'visible' ||
              identity.redirect ||
              !(await check(client)) ||
              identity.revision !== rows[0]!.revision ||
              BigInt(identity.securityRevision) !== BigInt(rows[0]!.security_revision)
            )
              return null;
            const stored = await ports.readRelease(client, rows[0]!.release);
            if (!stored) throw new Error('Subject revision release is missing');
            const layer = await ports.layerRelease(client, { digest: rows[0]!.release, release: stored }, context);
            if (layer.digest !== input.release) return null;
            const slot = await slotView(client, id, 'schema:abstract', context, defaults);
            return supportedFacts(client, routeKey, id, slot.facts);
          },
          deadline,
        );
        if (final) {
          const current = await disclosedTargets(pool, release, final, summaries.authorize);
          const admitted = resolveItem(
            id,
            current.map((entry) => entry.fact),
            subject.type,
            factDataTypes(
              release,
              current.map((entry) => entry.fact),
            ),
            {
              revision: subject.revision,
              release: subject.release,
              context,
              resolution: {},
              relationCounts: {},
            },
          );
          const currentFact = selectedSynopsisFact(admitted, input);
          if (currentFact && JSON.stringify(currentFact) === JSON.stringify(fact))
            selectedSynopsis = {
              kind: 'matched',
              fact: redactSynopsisFact(currentFact),
              context,
              release: subject.release,
            };
        }
      } else if (fact) selectedSynopsis = { kind: 'missing' };
    }
    if (Buffer.byteLength(JSON.stringify({ input, selectedSynopsis }), 'utf8') > 262144)
      selectedSynopsis = { kind: 'unavailable' };
  }
  return {
    ...(selectedSynopsis ? { selectedSynopsis } : {}),
    ...(summaries.reviewIdentity ? { reviewedIdentity: snapshot.reviewedIdentity } : {}),
    account: rows[0]!.account === null ? null : { id: rows[0]!.account },
    summary,
    subject,
    component,
  };
}

function relatedIds(subject: Item): { propertyIds: Set<string>; subjectIds: Set<string> } {
  const propertyIds = new Set<string>();
  const subjectIds = new Set<string>();
  const visit = (snak: Item['statements'][string][number]['qualifiers'][number]) => {
    propertyIds.add(snak.property.id);
    if (
      snak.property.data_type === 'wikibase-item' &&
      snak.value.type === 'value' &&
      typeof snak.value.content === 'string'
    )
      subjectIds.add(snak.value.content);
  };
  for (const [property, statements] of Object.entries(subject.statements)) {
    propertyIds.add(property);
    for (const statement of statements) {
      statement.qualifiers.forEach(visit);
      statement.references.forEach((reference) => reference.parts.forEach(visit));
      if (
        statement.property.data_type === 'wikibase-item' &&
        statement.value.type === 'value' &&
        typeof statement.value.content === 'string'
      )
        subjectIds.add(statement.value.content);
    }
  }
  return { propertyIds, subjectIds };
}

export type SubjectCorrectionActions =
  | { state: 'available'; actions: { action: string; operations: string[] }[] }
  | { state: 'concealed' | 'stale' | 'unavailable' };

export type SubjectCorrectionActionsInput = {
  pool: Pool;
  access: Access;
  bindings: ViewerActionBindings;
  actor: Actor;
  clock: () => Date;
  subject: string;
  type: string;
  revision: number;
  deadline: number;
};

export type SubjectReadingApplication = Readonly<{
  readSubject(
    pool: Pool,
    id: string,
    authorize: (client: PoolClient) => Promise<boolean>,
    context: string,
    routeKey: Uint8Array,
    options?: SubjectReadOptions,
  ): Promise<SubjectReadResult | null>;
  readSubjectSummaries: SubjectSummaryReader;
  readSubjectSummaryObservation: (
    deps: SummaryReaderDependencies,
    ids: readonly string[],
    options?: { languages?: readonly string[]; displayFallback?: boolean },
  ) => Promise<SubjectSummaryObservation>;
  readSubjectCorrectionActions(input: SubjectCorrectionActionsInput): Promise<SubjectCorrectionActions>;
  readRelated(db: Pool | PoolClient, ids: readonly string[]): ReturnType<typeof readRelatedNative>;
  loadRelated(client: object, ids: readonly string[]): ReturnType<typeof loadRelated>;
  readPage(input: SubjectReadingPageRequest): Promise<SubjectReadingPageResult>;
}>;

/** Build one read application from explicit Semantic and current Content capabilities. */
export function createSubjectReadingApplication(ports: SubjectReadingPorts): SubjectReadingApplication {
  let application: SubjectReadingApplication;
  application = Object.freeze({
    readSubject: (pool, id, authorize, context, routeKey, options = {}) =>
      readSubjectNative(
        ports,
        (deps, ids, summaryOptions) => application.readSubjectSummaries(deps, ids, summaryOptions),
        pool,
        id,
        authorize,
        context,
        routeKey,
        options,
      ),
    readSubjectSummaries: (deps, ids, options = {}) => readSubjectSummaries(ports, deps, ids, options),
    readSubjectSummaryObservation: (deps, ids, options = {}) =>
      readSubjectSummaryObservation(ports, deps, ids, options),
    readSubjectCorrectionActions: readSubjectCorrectionActionsNative,
    readRelated: readRelatedNative,
    loadRelated,
    readPage: (input) => readSubjectPage(application, ports, input),
  });
  return application;
}

async function readSubjectPage(
  application: SubjectReadingApplication,
  ports: SubjectReadingPorts,
  input: SubjectReadingPageRequest,
): Promise<SubjectReadingPageResult> {
  const { runtime } = input;
  const { pool, routeKey, actor, access, deadline } = runtime;
  const authorizeSummary = summaryAuthorization(async (id, batch) => {
    if (routeOf(id) === null) return async () => false;
    return input.authorization.prepareSummary(id, batch);
  });
  const synopsisAnchors: SubjectComponent[] = [];
  const result = await input
    .runNative(() =>
      application.readSubject(pool, input.subject, async () => false, input.context, routeKey, {
        languages: input.languages,
        ...(input.reviewIdentity ? { reviewIdentity: input.reviewIdentity } : {}),
        ...(input.selectedSynopsis
          ? {
              selectedSynopsis: {
                input: input.selectedSynopsis,
                admit: async () => {
                  const admitted = await ports.readCurrentDocument(runtime, input.selectedSynopsis!.document);
                  for (const anchor of admitted?.anchors ?? [])
                    synopsisAnchors.push({
                      partition: anchor.partition.partitionNo,
                      epoch: anchor.epoch,
                      position: anchor.position,
                    });
                  const document = admitted?.document;
                  return (
                    !!document &&
                    document.availability === 'available' &&
                    document.subjectId === input.subject &&
                    document.candidateId === input.selectedSynopsis!.statement &&
                    document.digest === input.selectedSynopsis!.digest &&
                    document.language === input.selectedSynopsis!.language
                  );
                },
              },
            }
          : {}),
        authorize: authorizeSummary,
        seen: input.seen,
        deadline,
        prepareAuthorize: input.authorization.prepareDetail,
        readAs: input.readAs,
      }),
    )
    .catch((error: unknown) => {
      if (error instanceof SubjectRedirectError) return { redirect: error } as const;
      throw error;
    });
  if (result && 'redirect' in result) return { kind: 'redirect', from: result.redirect.from, to: result.redirect.to };
  if (!result) return { kind: 'not-found' };

  const release = await ports.readRelease(pool, result.subject.release);
  if (!release) throw new Error('Subject revision release is missing');
  const { propertyIds, subjectIds } = relatedIds(result.subject);
  const related: SubjectReadingPageAnswer['related'] = {};
  for (const property of propertyIds) {
    const definition = release.properties[property];
    if (definition) related[property] = { labels: definition.labels };
  }
  const relatedList = [...subjectIds];
  if (relatedList.length > 256) throw new TypeError('A related read accepts at most 256 ids');
  const checks = await Promise.all(
    relatedList.map(async (id) => {
      const route = routeOf(id);
      if (route === null) return null;
      return input.authorization.prepareSummary(id, relatedList);
    }),
  );
  const references = await input.runNative(() =>
    withConnection(pool, async (client) => {
      const allowed: string[] = [];
      for (let index = 0; index < relatedList.length; index++) {
        const check = checks[index];
        const id = relatedList[index];
        if (!check || id === undefined || !(await check(client))) continue;
        allowed.push(id);
      }
      return application.readRelated(client, allowed);
    }),
  );

  const active = await ports.readActiveRelease(pool);
  let currentViewerActions: SubjectReadingPageAnswer['viewerActions'];
  if (input.includeViewerActions) {
    if (!active || !Object.hasOwn(active.release.types, result.subject.type) || !input.viewerActionBindings) {
      currentViewerActions = { state: 'unavailable' };
    } else {
      let actionRead: SubjectCorrectionActions;
      try {
        actionRead = await application.readSubjectCorrectionActions({
          pool,
          access,
          bindings: input.viewerActionBindings,
          actor,
          clock: runtime.clock,
          subject: input.subject,
          type: result.subject.type,
          revision: result.subject.revision,
          deadline,
        });
      } catch {
        actionRead = { state: 'unavailable' };
      }
      currentViewerActions =
        actionRead.state === 'available'
          ? { state: 'available', actions: actionRead.actions }
          : { state: 'unavailable' };
    }
  }

  const summaries = active
    ? await application.readSubjectSummaries(
        {
          client: { query: pool.query.bind(pool) },
          pool,
          routeKey,
          deadline,
          release: active.release,
          authorize: authorizeSummary,
        },
        Object.entries(references).map(([id, value]) => value.redirect ?? id),
        { languages: input.languages },
      )
    : new Map<string, SubjectSummary | null>();
  for (const [id, reference] of Object.entries(references)) {
    const summary = summaries.get(reference.redirect ?? id);
    if (summary) related[id] = { ...reference, type: summary.type, types: summary.types, cover: summary.cover };
  }
  if (input.selectedSynopsis && result.selectedSynopsis?.kind === 'matched') {
    const fact = result.selectedSynopsis.fact;
    const ids = new Set(
      [fact, ...fact.qualifiers, ...fact.references.flatMap((reference) => reference.parts)].flatMap((snak) => [
        snak.property.id,
        ...(snak.property.data_type === 'wikibase-item' &&
        snak.value.type === 'value' &&
        typeof snak.value.content === 'string'
          ? [snak.value.content]
          : []),
      ]),
    );
    const labels = Object.fromEntries(
      Object.entries(related)
        .filter(([id]) => ids.has(id))
        .map(([id, entry]) => [id, { labels: entry.labels }]),
    );
    if (
      Buffer.byteLength(
        JSON.stringify({
          input: input.selectedSynopsis,
          result: result.selectedSynopsis,
          labels,
          subject: result.subject.labels,
        }),
        'utf8',
      ) > 262144
    )
      result.selectedSynopsis = { kind: 'unavailable' };
  }

  const documentRead = input.includeDocuments
    ? await ports.readCharacterDocuments(runtime, result.subject, release, input.languages[0] ?? 'en')
    : undefined;
  const anchors: SubjectComponent[] = [
    ...synopsisAnchors,
    ...(documentRead?.anchors ?? []).map((anchor) => ({
      partition: anchor.partition.partitionNo,
      epoch: anchor.epoch,
      position: anchor.position,
    })),
    result.component,
  ];
  const answer: SubjectReadingPageAnswer = {
    subject: result.subject,
    ...(result.selectedSynopsis ? { selectedSynopsis: result.selectedSynopsis } : {}),
    ...(input.reviewIdentity ? { reviewedIdentity: result.reviewedIdentity ?? null } : {}),
    account: result.account,
    summary: result.summary,
    related,
    ...(documentRead ? { documents: documentRead.documents } : {}),
    ...(currentViewerActions ? { viewerActions: currentViewerActions } : {}),
  };
  return {
    kind: 'answer',
    answer,
    revision: result.subject.revision,
    anchors,
    private: Boolean(input.includeViewerActions || documentRead || input.reviewIdentity || input.selectedSynopsis),
  };
}

// Viewer action resources and correction advice now share the composed reading application.
/** Shared native evidence for ordinary subject disclosure and personal batches. */
export async function readSubjectPublicStates(client: AccessClient, ids: readonly string[]) {
  return readSubjectPublicStatesStatement.run(client, { routes: ids.map((id) => routeOf(id)!), ids: [...ids] });
}

/** Native Subject points supply both generic disclosure and exact released-Type disclosure. */
function subjectViewerActionResource(type?: string): ViewerActionResource {
  return {
    readAction: 'subject:read',
    async read(client, ids) {
      const rows = await readSubjectPublicStates(client, ids);
      // Hidden subjects are absent even if a caller independently holds subject:read.
      return Object.fromEntries(
        rows
          .filter((row) => (type === undefined || row.type === type) && row.visibility === 'visible')
          .map((row) => [row.id, true]),
      );
    },
  };
}

/** Register generic Subject disclosure and the released catalogue, including namespaced Types. */
export function subjectViewerActionResources(): ViewerActionResources {
  return memoizedValue(
    subjectViewerActionResources,
    () =>
      new Map([
        ['semantic.subject', subjectViewerActionResource()],
        ...Object.keys(bundledRelease.types).map((type): [string, ViewerActionResource] => [
          type,
          subjectViewerActionResource(type),
        ]),
      ]),
  );
}

/** Native Context resolver shares the exact directory lifecycle reader; candidates and creators never grant. */
export const contextViewerActionResource: ViewerActionResource = {
  readAction: 'context:read',
  async read() {
    throw new ContextDirectoryPreparingError();
  },
  async prepare({ pool, access, actor, ids, deadline }) {
    const entries = await authorizedContextMetadata({ pool, access }, { actor, ids, deadline });
    const visible = new Map(entries.map((entry) => [entry.id, entry]));
    return {
      readAction: 'context:read',
      async read(client, keys, at) {
        const rows = await client.query<{ id: string; state: string; labels: Record<string, string> }>(
          `SELECT context_id::text AS id,state,labels FROM semantic.context
           WHERE (route,context_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
             AND (state='active' OR (state='deleted' AND $3::timestamptz<purge_after))`,
          [keys.map((id) => routeOf(id)!), [...keys], at],
        );
        return Object.fromEntries(
          rows.rows
            .filter((row) => {
              const prepared = visible.get(row.id);
              return (
                prepared &&
                prepared.state === row.state &&
                JSON.stringify(prepared.labels) === JSON.stringify(row.labels)
              );
            })
            .map((row) => [row.id, true]),
        );
      },
      async actionAvailability(client, keys, actor, time) {
        const available = await contextNativeActions(client, keys, actor, time);
        return Object.fromEntries(
          keys.map((id) => {
            const actions = Object.fromEntries(
              ['context:read', 'context:create', 'context:delete', 'context:restore'].map((action) => [
                action,
                available[id]?.includes(action) ?? false,
              ]),
            );
            return [
              id,
              {
                ...actions,
                'context:accept': visible.get(id)?.state === 'active',
                'context:adopt': visible.get(id)?.state === 'active',
                'statement:propose': id === GLOBAL_SUBJECT_CONTEXT,
              },
            ];
          }),
        );
      },
    };
  },
};

/** Read mounted current correction operations against their Global parent and recheck the Subject. */
async function readSubjectCorrectionActionsNative(
  input: SubjectCorrectionActionsInput,
): Promise<SubjectCorrectionActions> {
  const route = routeOf(input.subject);
  if (
    route === null ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision >= Number.MAX_SAFE_INTEGER
  )
    return { state: 'unavailable' };
  const correctionOperations = new Set(['subject.propose', 'subject.terms']);
  const mounted = (input.bindings.get('semantic.context') ?? []).filter(
    (binding) => binding.action === 'statement:propose' && correctionOperations.has(binding.operationId),
  );
  if (
    !mounted.length ||
    mounted.some(
      (binding) =>
        binding.authority !== 'resource' ||
        binding.fixedResourceId !== GLOBAL_SUBJECT_CONTEXT ||
        binding.accountAuthority,
    )
  )
    return { state: 'unavailable' };
  const witness: { state: 'pending' | 'ready' | 'concealed' | 'stale' } = { state: 'pending' };
  const inputSubject = input.subject;
  const inputType = input.type;
  const inputRevision = input.revision;
  const inputRoute = route;
  const sourceBoundContext: ViewerActionResource = {
    readAction: contextViewerActionResource.readAction,
    async read(client, ids, at, time) {
      return contextViewerActionResource.read(client, ids, at, time);
    },
    async prepare(input) {
      const prepared = await contextViewerActionResource.prepare!(input);
      return {
        ...prepared,
        async read(client, ids, at, time) {
          if (!ids.includes(GLOBAL_SUBJECT_CONTEXT)) return {};
          const subjects = await readSubjectPublicStates(client, [inputSubject]);
          const subject = subjects.find((row) => row.id === inputSubject);
          if (subject?.visibility !== 'visible' || subject.type !== inputType) {
            witness.state = 'concealed';
            return {};
          }
          const current = await client.query<{ revision: number }>(
            `SELECT revision FROM semantic.revision WHERE route=$1 AND subject_id=$2
             ORDER BY revision DESC LIMIT 1`,
            [inputRoute, inputSubject],
          );
          if (current.rows[0]?.revision !== inputRevision) {
            witness.state = current.rows.length ? 'stale' : 'concealed';
            return {};
          }
          witness.state = 'ready';
          return prepared.read(client, ids, at, time);
        },
      };
    },
  };
  const resources: ViewerActionResources = new Map([['semantic.context', sourceBoundContext]]);
  const bindings: ViewerActionBindings = new Map([
    [
      'semantic.context',
      mounted.map(
        ({ action, operationId, exposure }) =>
          ({
            action,
            operationId,
            exposure,
            authority: 'resource',
            fixedResourceId: GLOBAL_SUBJECT_CONTEXT,
          }) satisfies ViewerActionBinding,
      ),
    ],
  ]);
  try {
    const result = await readViewerActions(
      { pool: input.pool, access: input.access, resources, bindings, clock: input.clock },
      input.actor,
      [{ type: 'semantic.context', id: GLOBAL_SUBJECT_CONTEXT }],
      input.deadline,
    );
    if (witness.state === 'concealed') return { state: 'concealed' };
    if (witness.state === 'stale') return { state: 'stale' };
    const selected = result.resources[0];
    if (!selected || 'error' in selected || witness.state !== 'ready') return { state: 'unavailable' };
    return {
      state: 'available',
      actions: selected.viewerActions.flatMap((entry) => {
        if (entry.action !== 'statement:propose') return [];
        const operations = [...new Set(entry.operations.filter((operation) => correctionOperations.has(operation)))];
        return operations.length ? [{ action: entry.action, operations }] : [];
      }),
    };
  } catch {
    return witness.state === 'concealed' || witness.state === 'stale'
      ? { state: witness.state }
      : { state: 'unavailable' };
  }
}
