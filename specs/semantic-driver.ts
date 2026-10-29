/**
 * Test-only binding. SEMANTIC_DRIVER names an absolute path or file URL exporting
 * createSemanticDriver(): Promise<SemanticDriver>. Each factory call owns its own
 * migrated PostgreSQL database, credentials, grants and production projection
 * runner. close() stops the runner and removes that database and all fixtures,
 * including after a failed scenario or while projection is paused.
 *
 * Every request goes through actual createKernel(...).handle with real Access,
 * real Auth tokens and the production session-token header. Keep one session
 * token per persona and return it on subsequent requests, as packages/client
 * does; anonymous sends no credentials. Do not follow redirects automatically.
 * Return actual response status, headers and parsed JSON without reshaping it.
 * Never implement product behavior, mock authorization or keep an in-memory model.
 *
 * Initial state: bundled release published and active; public subject:read for
 * anonymous and all active accounts. Semantic setup installs a standing grant
 * of subject:create and statement:propose on Global for every active account;
 * content setup also installs reaction:set standing on Global. Creation is
 * authorized on the parent, and the Global Context is the parent of the global
 * catalogue. On Global, editor still
 * has explicit subject:create, statement:propose and context:create grants;
 * acceptor has context:accept, context:adopt and subject:merge; steward has
 * definitions:publish and
 * definitions:activate. Suspended has editor's and acceptor's grants but its
 * account is suspended. No other allow grants exist initially.
 */
export type Persona = 'anonymous' | 'editor' | 'acceptor' | 'steward' | 'suspended';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Release = { [key: string]: Json };
export type Labels = Record<string, string>;
export interface Value {
  type: 'value';
  content: Json;
}
export interface Part {
  property: { id: string };
  value: Value;
}
export interface Reference {
  parts: Part[];
}
export interface StatementInput extends Part {
  rank?: 'normal' | 'preferred' | 'deprecated';
  qualifiers?: Part[];
  references?: Reference[];
}
export interface Statement extends StatementInput {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: { id: string; data_type: string };
  qualifiers: Part[];
  references: (Reference & { hash: string })[];
  rezics: { release: string; revision: number };
}
export interface Subject {
  id: string;
  type: string;
  revision: number;
  release: string;
  context: string;
  labels: Labels;
  descriptions: Labels;
  aliases: Record<string, string[]>;
  statements: Record<string, Statement[]>;
  resolution: Record<string, 'unresolved' | 'suppressed'>;
}
export interface Candidate {
  id: string;
  statement: Statement;
  release: string;
  revision: number;
  decision: 'accepted' | 'rejected' | 'abstained' | null;
  /** Effective acceptance head, never the adoption slot's head. */
  head: number | null;
  rank: 'normal' | 'preferred' | 'deprecated' | null;
}
export interface ResponseBody {
  [key: string]: unknown;
}
export interface HttpResponse {
  status: number;
  headers: Headers;
  body: ResponseBody;
}
export interface Revision {
  revision: number;
  partition: number;
  transactionId: string;
}
export interface SemanticDriver {
  readonly globalContext: string;
  /** Suite supplies structured-field Idempotency-Key headers for all writes. */
  request(
    persona: Persona,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
  /**
   * Use @rezics/definitions, including its bundled core.yaml, book.yaml,
   * recipe.yaml and rezics.yaml in the source map. root is a schema filename;
   * schemas maps filenames to LinkML YAML. presentation maps BCP 47 tags to
   * type and property labels, merged over bundled presentation by the driver
   * so bundled terms keep their labels.
   * Never import product code from the suite or hand-build compiler output.
   */
  compile(
    root: string,
    schemas: Record<string, string>,
    presentation: Record<
      string,
      {
        types?: Record<string, string>;
        properties?: Record<string, string>;
      }
    >,
  ): Promise<{ digest: string; release: Release }>;
  /** Fixture setup through accounts grant administration, never fake Access. */
  grant(persona: Persona, actions: string[], resourceId: string): Promise<void>;
  /** Pause/resume the actual production inbound-link projection runner. */
  projection(state: 'paused' | 'running'): Promise<void>;
  inspect: {
    /** Ordered authoritative rows; partition is the subject's actual partition. */
    revisions(subjectId: string): Promise<Revision[]>;
  };
  close(): Promise<void>;
}
