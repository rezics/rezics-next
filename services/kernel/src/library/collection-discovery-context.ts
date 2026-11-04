/** Public, bounded context for a native Collection card. No saved query or personal facts. */
import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { readSubjectSummaryObservation } from '../semantic/summaries.ts';
import type { SummaryReaderDependencies, SubjectSummary } from '../semantic/summaries.ts';

export const COLLECTION_PREVIEW_SIZE = 3;
export const COLLECTION_PREVIEW_EXAMINED = COLLECTION_PREVIEW_SIZE + 1;
export type CollectionCurator =
  | Readonly<{ state: 'available'; id: string; label: string | null; destination: string | null }>
  | Readonly<{ state: 'unavailable'; reason: 'deidentified' | 'withheld' | 'native_projection' }>;
export type CollectionPreviewMember = Readonly<{
  id: string;
  subject: Pick<SubjectSummary, 'id' | 'type' | 'types' | 'label'>;
}>;
export type CollectionPreview =
  | Readonly<{ state: 'available'; members: readonly CollectionPreviewMember[]; partial: boolean; truncated: boolean }>
  | Readonly<{ state: 'empty' | 'withheld' | 'unavailable' }>;
export type CollectionDiscoveryContext = Readonly<{ curator: CollectionCurator; preview: CollectionPreview }>;
export type DiscoveryMemberKey = Readonly<{ id: string; subjectId: string }>;
export type ContextSource = Readonly<{
  id: string;
  route: number;
  curatorAccountId: string | null;
  membershipKind: string;
  outputGeneration: string | null;
}>;

/** Two input-bounded statements, each with an indexed lateral LIMIT 4 per full Collection key.
 * Curated occurrences keep their native order; dynamic rows use only the selected published output.
 */
export async function readDiscoveryMemberKeys(
  client: Pick<PoolClient, 'query'>,
  sources: readonly ContextSource[],
): Promise<ReadonlyMap<string, readonly DiscoveryMemberKey[]>> {
  const result = new Map<string, DiscoveryMemberKey[]>(sources.map(({ id }) => [id, []]));
  for (const kind of ['curated', 'dynamic'] as const) {
    const selected = sources.filter(
      (row) => row.membershipKind === kind && (kind === 'curated' || row.outputGeneration),
    );
    if (!selected.length) continue;
    const rows = await client.query<{ collectionId: string; id: string; subjectId: string }>(
      kind === 'curated'
        ? `SELECT requested.id::text AS "collectionId", member.id, member."subjectId"
           FROM unnest($1::integer[], $2::uuid[]) WITH ORDINALITY requested(route, id, position)
           CROSS JOIN LATERAL (
             SELECT member_id::text AS id, subject_id::text AS "subjectId", ordinal_key
             FROM library.collection_member
             WHERE route=requested.route AND collection_id=requested.id AND deletion_id IS NULL
             ORDER BY ordinal_key, member_id LIMIT 4
           ) member ORDER BY requested.position, member.ordinal_key, member.id`
        : `SELECT requested.id::text AS "collectionId", member.id, member."subjectId"
           FROM unnest($1::integer[], $2::uuid[], $3::uuid[]) WITH ORDINALITY requested(route, id, generation, position)
           CROSS JOIN LATERAL (
             SELECT subject_id::text AS id, subject_id::text AS "subjectId"
             FROM library.collection_source_output_member
             WHERE route=requested.route AND collection_id=requested.id AND generation=requested.generation
             ORDER BY subject_id LIMIT 4
           ) member ORDER BY requested.position, member.id`,
      kind === 'curated'
        ? [selected.map((row) => row.route), selected.map((row) => row.id)]
        : [
            selected.map((row) => row.route),
            selected.map((row) => row.id),
            selected.map((row) => row.outputGeneration),
          ],
    );
    for (const row of rows.rows) {
      const members = result.get(row.collectionId);
      if (!members || members.length >= COLLECTION_PREVIEW_EXAMINED)
        throw new Error('Collection preview exceeded its native bound');
      members.push({ id: row.id, subjectId: row.subjectId });
    }
  }
  return result;
}

/** Withhold optional context if the native foreign projection is not installed. */
export async function prepareCollectionDiscoveryContext(
  dependencies: Omit<SummaryReaderDependencies, 'actor'> | null,
  sources: readonly ContextSource[],
  members: ReadonlyMap<string, readonly DiscoveryMemberKey[]>,
  languages: readonly string[] = [],
): Promise<Readonly<{ values: ReadonlyMap<string, CollectionDiscoveryContext>; current: () => Promise<boolean> }>> {
  const unavailable = new Map(
    sources.map((source) => [
      source.id,
      {
        curator: {
          state: 'unavailable',
          reason: source.curatorAccountId === null ? 'deidentified' : 'native_projection',
        },
        preview: { state: 'unavailable' },
      } satisfies CollectionDiscoveryContext,
    ]),
  );
  if (!dependencies) return { values: unavailable, current: async () => true };
  // Public cards always use anonymous disclosure, independent of a signed-in reader's grants.
  const deps = { ...dependencies, actor: { kind: 'anonymous' } as const };
  const curatorIds = [
    ...new Set(sources.flatMap((source) => (source.curatorAccountId ? [source.curatorAccountId] : []))),
  ];
  const curators = await readAccountDiscoverySummaries(deps, curatorIds, { languages });
  const subjectIds = [...new Set([...members.values()].flatMap((rows) => rows.map((row) => row.subjectId)))];
  const observations: Awaited<ReturnType<typeof readSubjectSummaryObservation>>[] = [];
  const subjects = new Map<string, SubjectSummary | null>();
  for (let offset = 0; offset < subjectIds.length; offset += 100) {
    const observation = await readSubjectSummaryObservation(deps, subjectIds.slice(offset, offset + 100), {
      languages,
    });
    observations.push(observation);
    for (const [id, summary] of observation.summaries) subjects.set(id, summary);
  }
  const values = new Map<string, CollectionDiscoveryContext>();
  for (const source of sources) {
    const account = source.curatorAccountId ? curators.get(source.curatorAccountId) : null;
    const curator: CollectionCurator = account
      ? {
          state: 'available',
          id: account.id,
          label: (account.displayName || (account.handle ? `@${account.handle}` : null))?.slice(0, 160) ?? null,
          destination:
            account.handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account.handle) ? `/@${account.handle}` : null,
        }
      : { state: 'unavailable', reason: source.curatorAccountId === null ? 'deidentified' : 'withheld' };
    const raw = members.get(source.id) ?? [];
    const admitted = raw.flatMap((member): CollectionPreviewMember[] => {
      const subject = subjects.get(member.subjectId);
      if (
        !subject ||
        subject.type.length > 256 ||
        subject.types.length > 32 ||
        subject.types.some((type) => type.length > 256)
      )
        return [];
      return [
        {
          id: member.id,
          subject: {
            id: subject.id,
            type: subject.type,
            types: [...subject.types],
            label: subject.label ? { ...subject.label, value: subject.label.value.slice(0, 160) } : null,
          },
        },
      ];
    });
    const preview: CollectionPreview =
      raw.length === 0
        ? { state: 'empty' }
        : admitted.length === 0
          ? { state: 'withheld' }
          : {
              state: 'available',
              members: admitted.slice(0, COLLECTION_PREVIEW_SIZE),
              partial: admitted.length < raw.length,
              truncated: raw.length > COLLECTION_PREVIEW_SIZE,
            };
    const value = { curator, preview };
    values.set(
      source.id,
      Buffer.byteLength(JSON.stringify(value)) <= 4096 ? value : { curator, preview: { state: 'unavailable' } },
    );
  }
  return {
    values,
    current: async () => {
      if (!isDeepStrictEqual(curators, await readAccountDiscoverySummaries(deps, curatorIds, { languages })))
        return false;
      for (const observation of observations) if (!(await observation.current())) return false;
      return true;
    },
  };
}
