import type { Release } from '@rezics/definitions';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Pool, PoolClient } from 'pg';
import { checkMediaObjects, type CoverReference } from '../content/cover-reference.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import type { SourceFenceTuple } from '../content/source-fences.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { deadlineFor } from '../request/deadline.ts';
import { fenceKey, readAnchoredFences } from './fences.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { activeRelease, GLOBAL_CONTEXT } from './definitions.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { relatedReadEligibility } from './eligibility.ts';
import type { Statement } from './item.ts';
import { slotId } from './slots.ts';
import { chooseLabel } from './language.ts';
import readSummaries from './summaries-read.sql';
import readRepresentativeEditions from './summaries-representative-editions.sql';
import { withReadTransaction } from './read.ts';

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
  if (!(deps.routeKey instanceof Uint8Array) || deps.routeKey.byteLength < 32)
    throw new TypeError('Subject summaries require the server route key');
  if (deps.deadline !== undefined) requireAccessDeadline(deps.deadline);
  if (ids.length > 256) throw new RangeError('Subject summaries accept at most 256 ids');
  const results = new Map<string, SubjectSummary | null>(ids.map((id) => [id, null]));
  if (!ids.length) return results;
  if ('access' in deps) {
    const reader = deps;
    const active = await activeRelease(reader.pool);
    if (!active) return results;
    const checks = new Map<string, ReturnType<typeof accessCheck>>();
    const client = { query: reader.pool.query.bind(reader.pool) };
    return readSubjectSummaries(
      {
        client,
        pool: reader.pool,
        routeKey: reader.routeKey,
        deadline: reader.deadline,
        release: active.release,
        ...(reader.maySeeCover ? { maySeeCover: reader.maySeeCover } : {}),
        async authorize(connection, id, batch) {
          const route = routeOf(id);
          if (route === null) return false;
          let check = checks.get(id);
          if (!check) {
            check = accessCheck(
              reader.access,
              reader.actor,
              'subject:read',
              { route, id, eligibility: relatedReadEligibility({ route, id }, batch) },
              { pool: reader.pool, deadline: reader.deadline },
            );
            checks.set(id, check);
          }
          return (await check)(connection);
        },
      },
      ids,
      { languages },
    );
  }
  const storage = deps;
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
      const representatives = storage.pool
        ? await withReadTransaction(storage.pool, async (client) => {
            const found = await readRepresentativeEditions.run(client, { partition_no: partition, subjects });
            return found.map((row) => ({ id: row.id, slot_id: row.slot_id, ordinal: Number(row.ordinal) }));
          })
        : (await readRepresentativeEditions.run(storage.client, { partition_no: partition, subjects })).map((row) => ({
            id: row.id,
            slot_id: row.slot_id,
            ordinal: Number(row.ordinal),
          }));
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
  const unfenced = new Set<string>();
  // Reader calls retain their existing aggregate deadline. Storage-level calls
  // retain the request's budget, or the existing per-read budget outside a request;
  // do not impose a new aggregate timeout on their caller-owned authorization work.
  const deadline = deps.deadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  for (const [partition, group] of homes) {
    for (let offset = 0; offset < group.length; offset += 100) {
      requireAccessDeadline(deadline);
      const fences = await readAnchoredFences(deps.pool, partition, group.slice(offset, offset + 100));
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
  return results;
}
