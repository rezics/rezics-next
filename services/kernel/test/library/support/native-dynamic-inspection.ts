import type { DynamicCollectionsInspection } from '../../../../../specs/dynamic-collections-driver.ts';
import { unavailable, type NativeConformanceWorld } from './native-conformance.ts';

type CollectionObservation = Omit<DynamicCollectionsInspection['collections'][number], 'curatorAccountId'> & {
  curatorAccountId: string | null;
};
type MembershipObservation = Omit<
  DynamicCollectionsInspection['publicMembership'][number],
  'sourceEpoch' | 'sourcePosition'
> & { sourceEpoch: number | null; sourcePosition: string | null };

/** Owning rows can retain nulls that the frozen complete inspection cannot represent. */
export interface NativeDynamicLibraryInspection extends Omit<
  DynamicCollectionsInspection,
  'collections' | 'publicMembership' | 'searchDocuments'
> {
  collections: readonly CollectionObservation[];
  publicMembership: readonly MembershipObservation[];
}

/** Exhaustive read-only Library observations, including retained rows and original source stamps.
 * This is deliberately not a complete DynamicCollectionsInspection or a privacy proof.
 */
export async function inspectNativeDynamicLibrary(
  world: Pick<NativeConformanceWorld, 'inspect' | 'native'>,
): Promise<NativeDynamicLibraryInspection> {
  const base = await world.inspect();
  const reader = world.native.reader;
  const [headers, publicMembership, facts, events, projections] = await Promise.all([
    reader.query<CollectionObservation>(
      `SELECT collection_id AS id, curator_account_id AS "curatorAccountId",
              membership_kind AS "membershipKind", visibility, revision,
              source_generation::text AS "sourceGeneration", rule_revision::text AS "queryRevision",
              curator_account_id IS NULL AS frozen,
              CASE builtin_kind
                WHEN 'everything' THEN jsonb_build_object('kind', builtin_kind)
                WHEN 'state' THEN jsonb_build_object('kind', builtin_kind,
                  'profileId', builtin_profile_id, 'stateSetId', builtin_state_set_id, 'stateId', builtin_state_id)
              END AS "builtinKey"
         FROM library.collection ORDER BY route, collection_id`,
    ),
    reader.query<MembershipObservation>(
      `SELECT collection_id AS "collectionId", subject_id AS "subjectId", multiplicity,
              source_epoch AS "sourceEpoch", source_position::text AS "sourcePosition"
         FROM library.subject_collection ORDER BY route, subject_id, collection_id`,
    ),
    reader.query<DynamicCollectionsInspection['facts'][number]>(
      `SELECT account_id AS "accountId", subject_id AS "subjectId", 'state' AS kind, library_profile_pin AS pin,
              route, subject_id::text AS identity
         FROM library.entry
        UNION ALL
       SELECT account_id, subject_id, 'label', NULL::jsonb, route, label_id::text
         FROM library.label_assignment
        UNION ALL
       SELECT account_id, subject_id, 'session', library_profile_pin, route, session_id::text
         FROM library.progress_session
        UNION ALL
       SELECT account_id, subject_id, 'holding', library_profile_pin, route, copy_id::text
         FROM library.copy
        ORDER BY route, "accountId", "subjectId", kind, identity`,
    ),
    reader.query<DynamicCollectionsInspection['events'][number]>(
      `SELECT id, type AS kind, epoch AS "sourceEpoch", position::text AS "sourcePosition"
         FROM core.outbox ORDER BY partition_no, position, event_seq`,
    ),
    reader.query<DynamicCollectionsInspection['projections'][number]>(
      `SELECT COALESCE(v.collection_id, f.collection_id) AS "collectionId",
              COALESCE(v.source_epoch, f.source_epoch) AS "appliedEpoch",
              COALESCE(v.source_position, f.source_position)::text AS "appliedPosition",
              COALESCE(f.terminal, false) AS terminal
         FROM library.subject_collection_version v
         FULL JOIN library.subject_collection_source_fence f
           ON f.partition_no=v.route>>4 AND f.collection_id=v.collection_id
        ORDER BY COALESCE(v.route>>4, f.partition_no), "collectionId", v.subject_id`,
    ),
  ]);
  if (headers.rows.length !== base.collections.length)
    return unavailable('DynamicCollectionsInspection.collections: Collection inventory changed during observation');
  const byId = new Map(headers.rows.map((row) => [row.id, row]));
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return {
    collections: base.collections.map(({ id }) => {
      const row = byId.get(id);
      if (!row)
        return unavailable(`DynamicCollectionsInspection.collections: Collection ${id} changed during observation`);
      // Curated and saved-query Collections have no builtin identity; preserve absence.
      const { builtinKey, ...header } = row;
      return builtinKey === null || builtinKey === undefined ? header : { ...header, builtinKey };
    }),
    curatedOccurrences: [...base.members]
      .sort(
        (left, right) =>
          left.route - right.route ||
          compare(left.collectionId, right.collectionId) ||
          compare(left.orderKey, right.orderKey) ||
          compare(left.id, right.id),
      )
      .map(({ collectionId, id, subjectId, note }) => ({ collectionId, id, subjectId, note })),
    publicMembership: publicMembership.rows,
    facts: facts.rows.map(({ accountId, subjectId, kind, pin }) => ({ accountId, subjectId, kind, pin })),
    events: events.rows,
    projections: projections.rows,
  };
}

export const missingDynamicSearchObservation =
  "DynamicCollectionsInspection.searchDocuments: readonly { subjectId: string; source: 'catalogue' | 'personal' }[] " +
  '(no installed Search document observation in NativeConformanceWorld)';

/** Never turn incomplete native observations into a successful exclusion assertion. */
export async function inspectNativeDynamicCollections(
  world: Pick<NativeConformanceWorld, 'inspect' | 'native'>,
): Promise<DynamicCollectionsInspection> {
  await inspectNativeDynamicLibrary(world);
  // The Library world has no installed Search document reader. The separate Search
  // supervisor observes worker lifecycle, not documents belonging to this world.
  // Subject rows and subject_collection rows cannot stand in for Search sources.
  return unavailable(missingDynamicSearchObservation);
}
