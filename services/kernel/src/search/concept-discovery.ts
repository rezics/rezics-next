import type { DiscoveryFilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { deadlineFor } from '../request/deadline.ts';
import { searchSourcePublicationApplication } from './source-publication-application.ts';
import { createConceptBrowseStore } from './concept-browse-store.ts';
import { prepareConceptDisclosure, type SearchDisclosureApplication } from './disclosure-application.ts';

/** Bind the native relation owner and retained store; orchestration stays in Search application. */
export async function prepareConceptDiscoveryFilter(
  input: Readonly<{
    pool: Pool;
    prefix: string;
    routeKey: Uint8Array;
    principal: string;
    request: unknown;
    filter: DiscoveryFilterDocument;
    limit: number;
    countCandidateLimit: number;
    /** Original request deadline, shared by every retained membership probe. */
    deadline?: number;
    now?: () => number;
  }>,
  disclosure: Pick<SearchDisclosureApplication, 'prepareConceptFilter'> = {
    prepareConceptFilter: prepareConceptDisclosure,
  },
) {
  // Capture before source observation or a deferred store factory can outlive the request.
  const deadline = input.deadline ?? deadlineFor(30_000);
  const { pool, prefix } = input;
  const source = searchSourcePublicationApplication().subjectSource(pool, input.routeKey);
  return disclosure.prepareConceptFilter(
    { ...input, now: input.now ?? Date.now },
    {
      browse: source.conceptBrowse,
      readStatements: source.readConceptStatements,
      store: (id, options) => createConceptBrowseStore(pool, prefix, id, { ...options, deadline }),
    },
  );
}
