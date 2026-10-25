/**
 * Test-only binding. PAGES_DRIVER names an absolute path or file URL exporting
 * createPagesDriver(): Promise<PagesDriver>. Each factory call owns its own
 * migrated PostgreSQL database and real createKernel(...).handle. close()
 * removes that database and its fixtures, including after a failed scenario.
 *
 * Every request goes through actual createKernel(...).handle, real Access and
 * real Auth tokens. Retain the production session-token header per persona and
 * send it on subsequent requests, as packages/client does; anonymous sends no
 * credentials. Do not follow redirects. Return actual status, Headers and parsed
 * JSON without reshaping. Never mock authorization, import product behavior
 * into the suite or substitute an in-memory page model.
 *
 * Start with the bundled definitions release and the bundled presentation
 * profile published and active, Global as the catalogue parent, and the subject
 * grants of semantic-driver.ts: public subject:read; standing subject:create
 * and statement:propose on Global for active accounts; editor's explicit
 * subject:create, statement:propose and context:create. Curator has explicit
 * presentation:publish and presentation:activate on Global, granted through the
 * API by the platform governance account that
 * services/kernel/scripts/bootstrap-governance.ts installs, never by SQL.
 * Suspended holds curator's grants but its account is suspended before its
 * first authenticated request. No other allow grants exist. The authorized
 * operator fixture for remove is separate from these personas.
 */
export type { HttpResponse } from './semantic-driver';
import type { HttpResponse } from './semantic-driver';

export type Persona = 'anonymous' | 'editor' | 'curator' | 'suspended';
export interface PagesDriver {
  /** Presentation writes carry structured-field Idempotency-Key; pages:read does not. */
  request(
    persona: Persona,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
  /** Production hide/takedown command through an authorized operator; await commit. */
  remove(subjectId: string, mode: 'hidden' | 'taken_down'): Promise<void>;
  close(): Promise<void>;
}
