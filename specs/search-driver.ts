/**
 * Test-only binding. SEARCH_DRIVER names an absolute path or file URL exporting
 * createSearchDriver(): Promise<SearchDriver>. Each factory call owns its own
 * migrated PostgreSQL database, credentials, grants, production indexing runner,
 * and index names on a real OpenSearch node. close() stops the runner and removes
 * its database and indices, including after failure or while indexing is paused.
 *
 * Every request goes through actual createKernel(...).handle, real Access and
 * real Auth tokens. Retain the production session-token header per persona and
 * send it on subsequent requests, as packages/client does; anonymous sends no
 * credentials. Do not follow redirects. Return actual status, Headers and parsed
 * JSON without reshaping. Never mock authorization, simulate indexing, import
 * product behavior into the suite or substitute an in-memory search model.
 *
 * Start with the bundled release published and active, Global as the catalogue
 * parent, and the grants of semantic-driver.ts: public subject:read; standing
 * subject:create and statement:propose on Global for active accounts; editor's
 * explicit subject:create, statement:propose and context:create; acceptor's
 * context:accept, context:adopt and subject:merge. No other allow grants exist.
 * Suspended holds editor's and acceptor's grants but its account is suspended.
 * The authorized operator fixture for remove is separate from these personas.
 */
export type { HttpResponse } from './semantic-driver';
import type { HttpResponse } from './semantic-driver';

export type Persona = 'anonymous' | 'editor' | 'acceptor' | 'suspended';
export interface SearchDriver {
  readonly globalContext: string;
  /** Semantic writes carry structured-field Idempotency-Key; all requests use the real kernel HTTP path. */
  request(
    persona: Persona,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
  /** Production hide/takedown command through an authorized operator; await commit. */
  remove(subjectId: string, mode: 'hidden' | 'taken_down'): Promise<void>;
  /** Pause/resume the actual production indexing runner. */
  indexing(state: 'paused' | 'running'): Promise<void>;
  /** Make OpenSearch unreachable/reachable from the kernel, without replacing it. */
  searchNode(state: 'down' | 'up'): Promise<void>;
  /** Replay into a new index, reconcile per-partition counts, atomically switch alias. */
  rebuild(): Promise<{ generation: number }>;
  close(): Promise<void>;
}
