import type { ContentApplication, ContentApplicationPorts } from '../contract/index.ts';
import { createAuthoredFields } from './authored-field.ts';
import { createBoardCursors } from './board-cursor.ts';
import { createDocumentReads } from './document-read.ts';
import { createHttpContext } from './http-context.ts';
import { createPublication } from './publication.ts';
import { createRanking } from './ranking.ts';
import { createWorkBudgets } from './work.ts';

/** Use cases over Content-owned ports. Downstream implementations are never imported here. */
export function createContentApplication(ports: ContentApplicationPorts): ContentApplication {
  const documents = createDocumentReads(ports, ports.ambient);
  const authoredFields = createAuthoredFields(ports, ports.ambient);
  const ranking = createRanking(ports, ports.ambient);
  const cursors = createBoardCursors();
  const work = createWorkBudgets(ports.ambient);
  const http = createHttpContext(ports.ambient);
  const publication = createPublication(ports, ports.ambient);
  return Object.freeze({
    ports,
    ambient: ports.ambient,
    elapsed: (deadline) => documents.elapsed(deadline),
    admitsDocumentRead: (route, deadline, maxSourceBytes) => documents.admits(route, deadline, maxSourceBytes),
    activeRank: (score, activityAt) => ranking.activeRank(score, activityAt),
    refreshRanks: (pool, partitions) => ranking.refresh(pool, partitions),
    admitAuthoredField: (input) => authoredFields.admit(input),
    nextAuthoredFieldId: () => authoredFields.nextId(),
    eraseAuthoredField: (id, deadline) => authoredFields.erase(id, deadline),
    normalizeBoardQuery: (query) => cursors.normalizeQuery(query),
    workerStepDeadline: () => work.step(),
    workerLongStepDeadline: () => work.longStep(),
    requestContext: (deadline, idempotencyKey) => http.requestContext(deadline, idempotencyKey),
    createThread: (deadline) => publication.createThread(deadline),
  });
}
