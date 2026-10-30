import { DBOS } from '@dbos-inc/dbos-sdk';
import { withConnection } from '../database/pool.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { requireRoute } from './command-support.ts';
import { syncSubjectListing } from './listing.ts';
import memberSubjects from './work-member-subjects.sql';

const COLLECTION_LISTING_WORKFLOW = 'library.collectionListing';
const PAGE_SIZE = 100;
const SEGMENT_PAGES = 2;

export function registerLibraryWork({ pool, client, addEffects }: WorkContext): void {
  const syncPage = DBOS.registerStep<unknown, [string, string], string | null>(
    async (collectionId: string, after: string): Promise<string | null> => {
      // The route/Collection/subject index bounds this seek, including tombstoned Collections.
      const subjects = await withConnection(pool, (connection) =>
        memberSubjects.run(
          { query: connection.query.bind(connection) },
          { route: requireRoute(collectionId), collection_id: collectionId, after, limit: PAGE_SIZE },
        ),
      );
      // Release the Collection connection before entering any subject partition command.
      // A retry repeats the whole page against current source truth; completed syncs are no-ops.
      for (const { subjectId } of subjects) {
        if (subjectId === null) throw new Error('Collection member has no subject locator');
        await syncSubjectListing({ pool, client }, { subjectId, collectionId });
      }
      return subjects.length === PAGE_SIZE ? subjects[PAGE_SIZE - 1]!.subjectId : null;
    },
    { name: 'library.syncCollectionPage', ...COMMAND_STEP_RETRIES },
  );
  const continueListing = DBOS.registerStep<unknown, [string, string, string], void>(
    async (collectionId: string, after: string, root: string) => {
      await client.enqueue(
        {
          workflowName: COLLECTION_LISTING_WORKFLOW,
          workflowID: `${root}:${after}`,
          workflowIDReusePolicy: 'return-existing',
          queueName: 'workflows',
        },
        collectionId,
        after,
        root,
      );
    },
    { name: 'library.continueCollectionListing', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow<unknown, [string, string?, string?], void>(
    async (
      collectionId: string,
      start: string = '00000000-0000-0000-0000-000000000000',
      root: string = DBOS.workflowID!,
    ) => {
      let after: string | null = start;
      for (let page = 0; page < SEGMENT_PAGES && after !== null; page++) after = await syncPage(collectionId, after);
      // A finite segment retains only an immutable source locator in existing DBOS work.
      if (after !== null) await continueListing(collectionId, after, root);
    },
    { name: COLLECTION_LISTING_WORKFLOW },
  );
  addEffects([
    {
      name: 'library_member_listing',
      types: ['com.rezics.library.collection.member.changed.v1'],
      async run(event) {
        const { subjectId, collectionId } = event.data as { subjectId: string; collectionId: string };
        await syncSubjectListing({ pool, client }, { subjectId, collectionId });
      },
    },
    {
      name: 'library_collection_listing',
      types: ['com.rezics.library.collection.listing.changed.v1'],
      async run(event) {
        const { collectionId } = event.data as { collectionId: string };
        await client.enqueue(
          {
            workflowName: COLLECTION_LISTING_WORKFLOW,
            workflowID: event.id,
            workflowIDReusePolicy: 'return-existing',
            queueName: 'workflows',
          },
          collectionId,
        );
      },
    },
  ]);
}
