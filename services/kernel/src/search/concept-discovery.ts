import type { DiscoveryFilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { searchSourcePublicationApplication } from './source-publication-application.ts';
import { createConceptBrowseStore } from './concept-browse-store.ts';
import { prepareConceptDisclosure } from './disclosure-application.ts';

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
    now?: () => number;
  }>,
) {
  const source = searchSourcePublicationApplication().subjectSource(input.pool, input.routeKey);
  return prepareConceptDisclosure(
    { ...input, now: input.now ?? Date.now },
    {
      browse: source.conceptBrowse,
      readStatements: source.readConceptStatements,
      store: (id, options) => createConceptBrowseStore(input.pool, input.prefix, id, options),
    },
  );
}
