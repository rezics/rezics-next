import type { AccountAnchor, LibraryLabelsInspection } from '../../../../../specs/library-labels-driver.ts';
import type { NativeConformanceWorld } from './native-conformance.ts';

export type NativeLabelCollectionObservations = Pick<
  LibraryLabelsInspection,
  'collections' | 'collectionGrants' | 'collectionOutbox' | 'collectionWork'
>;

/** Read actual Collection-owned rows selected by the inspected account and explicit Collection locators. */
export async function inspectNativeLabelCollections(
  world: Pick<NativeConformanceWorld, 'native'>,
  account: AccountAnchor,
  requestedCollectionIds: readonly string[],
): Promise<NativeLabelCollectionObservations> {
  const database = world.native.reader;
  const collectionIds = [...requestedCollectionIds];
  const collections = (
    await database.query<LibraryLabelsInspection['collections'][number]>(
      `SELECT collection_id AS "collectionId", curator_account_id AS "curatorAccountId", visibility, revision, state
         FROM library.collection
        WHERE route=$1 AND curator_account_id=$2 AND collection_id=ANY($3::uuid[])
        ORDER BY collection_id`,
      [account.route, account.id, collectionIds],
    )
  ).rows;
  const ownedCollectionIds = collections.map((collection) => collection.collectionId);

  const [collectionGrants, collectionOutbox, collectionWork] = await Promise.all([
    database.query<LibraryLabelsInspection['collectionGrants'][number]>(
      `SELECT resource_id AS "collectionId", subject_id AS "accountId",
              array_agg(DISTINCT action ORDER BY action) AS actions
         FROM access.resource_grant
        WHERE route=$1 AND resource_id=ANY($2::uuid[]) AND subject_kind='identity'
        GROUP BY resource_id, subject_id
        ORDER BY resource_id, subject_id`,
      [account.route, ownedCollectionIds],
    ),
    database.query<LibraryLabelsInspection['collectionOutbox'][number]>(
      `SELECT type, subject, data
         FROM core.outbox
        WHERE partition_no=$1 AND subject=ANY($2::text[])
        ORDER BY position, event_seq`,
      [account.partition, ownedCollectionIds],
    ),
    database.query<LibraryLabelsInspection['collectionWork'][number]>(
      `SELECT event.data->>'collectionId' AS "collectionId", workflow.name AS kind, workflow.status AS state
         FROM core.outbox AS event
         JOIN dbos.workflow_status AS workflow ON workflow.workflow_uuid=event.id::text
        WHERE event.partition_no=$1
          AND event.type='com.rezics.library.collection.listing.changed.v1'
          AND event.subject=ANY($2::text[])
          AND event.data->>'collectionId'=ANY($2::text[])
          AND workflow.name='library.collectionListing'
        ORDER BY event.position, event.event_seq`,
      [account.partition, ownedCollectionIds],
    ),
  ]);

  return {
    collections,
    collectionGrants: collectionGrants.rows,
    collectionOutbox: collectionOutbox.rows,
    collectionWork: collectionWork.rows,
  };
}
