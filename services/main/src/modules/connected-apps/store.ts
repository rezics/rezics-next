import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { argumentsMatch, canonicalJson, isObject, sha256, validateInputSchema,
  type JsonObject } from './json.ts';
import { MCP_MAX_TOOLS, McpCancelled, McpHttpError, McpProtocolClient, McpProtocolError,
  SafeMcpTransport, type McpSnapshot, type McpToolResult, type McpTransport } from './protocol.ts';

export class ConnectedAppInvalid extends Error {}
export class ConnectedAppDenied extends Error {}
export class ConnectedAppConflict extends Error {}
export class ConnectedAppStale extends Error {}
export class ConnectedAppUnavailable extends Error {}

export interface ConnectedAppConsentBasis {
  clientId: string;
  consentId: string;
  generation: string;
  audiences: readonly string[];
  scopes: readonly string[];
}

export interface ObservationView {
  observation: string;
  endpoint: string;
  protocolVersion: string;
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  snapshotSha256: string;
  pageCount: number;
  toolCount: number;
  predecessor: string | null;
  drift: 'initial' | 'unchanged' | 'changed';
  observedAt: string;
  tools: Array<{ name: string; definition: Record<string, unknown>; definitionSha256: string;
    schemaValidation: 'valid' | 'invalid' | 'unsupported'; pageNumber: number }>;
}

export interface ConsentCeilingView {
  ceiling: string;
  observation: string;
  endpoint: string;
  resource: string;
  consentId: string;
  consentGeneration: string;
  tools: Array<{ name: string; definitionSha256: string }>;
  createdAt: string;
}

export interface InvocationView {
  invocation: string;
  ceiling: string;
  observation: string;
  toolName: string;
  definitionSha256: string;
  argumentsSha256: string;
  state: 'admitted' | 'sent' | 'completed' | 'tool-error' | 'protocol-error'
    | 'cancel-requested' | 'cancelled' | 'uncertain';
  resultSha256: string | null;
  protocolError: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  replayed: boolean;
}

interface ObservationRow {
  id: string; principal_id: string; idempotency_key: string; endpoint: string;
  protocol_version: string; server_info: Record<string, unknown>; capabilities: Record<string, unknown>;
  tools_sha256: string; page_count: number; tool_count: number; predecessor_id: string | null;
  drift: 'initial' | 'unchanged' | 'changed'; observed_at: Date;
}
interface PageRow { page_number: number; request_cursor: string | null; next_cursor: string | null;
  response_bytes: Buffer }
interface ToolRow { tool_name: string; page_number: number; definition: Record<string, unknown>;
  definition_jcs_sha256: string; schema_validation: 'valid' | 'invalid' | 'unsupported' }
interface CeilingRow { id: string; principal_id: string; idempotency_key: string; account_client_id: string;
  account_consent_id: string; account_consent_generation: string; endpoint: string; resource: string;
  observation_id: string; tool_count: number; created_at: Date }
interface InvocationDbRow { id: string; principal_id: string; idempotency_key: string; request_digest: string;
  ceiling_id: string; account_consent_generation: string; credential_audience: string; observation_id: string;
  tool_name: string; definition_jcs_sha256: string; arguments_sha256: string; state: InvocationView['state'];
  result_sha256: string | null; protocol_error: Record<string, unknown> | null; created_at: Date; updated_at: Date }

export interface ConnectedAppEndpointLock {
  readonly principalId: string;
  readonly endpoint: string;
  readonly client: PoolClient;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY = /^[A-Za-z0-9:_./-]{1,128}$/;
const CONSENT_GENERATION = UUID;
const MAX_ARGUMENT_BYTES = 262_144;
const MAX_SERVER_INFO_BYTES = 4_096;
const MAX_CAPABILITIES_BYTES = 16_384;

function jsonBytes(value: unknown, message: string, maximum: number): string {
  let encoded: string;
  try { encoded = canonicalJson(value); } catch { throw new ConnectedAppInvalid(message); }
  if (Buffer.byteLength(encoded) > maximum) throw new ConnectedAppInvalid(message);
  return encoded;
}

function requireKey(key: string): void {
  if (!IDEMPOTENCY.test(key)) throw new ConnectedAppInvalid('A valid Idempotency-Key is required');
}

function checkBasis(basis: ConnectedAppConsentBasis): void {
  if (!basis.clientId || basis.clientId.length > 256 || !basis.consentId || basis.consentId.length > 256
    || !CONSENT_GENERATION.test(basis.generation)) {
    throw new ConnectedAppDenied('A current explicit Account consent is required');
  }
}

function checkResource(endpoint: string, resource: string, basis: ConnectedAppConsentBasis): void {
  let endpointUrl: URL;
  let resourceUrl: URL;
  try { endpointUrl = new URL(endpoint); resourceUrl = new URL(resource); }
  catch { throw new ConnectedAppInvalid('Endpoint and resource must be URLs'); }
  if (endpointUrl.origin !== resourceUrl.origin || endpointUrl.protocol !== resourceUrl.protocol
    || resourceUrl.username || resourceUrl.password || resourceUrl.search || resourceUrl.hash
    || !basis.audiences.includes(resource)) {
    throw new ConnectedAppDenied('Account consent does not name this MCP resource');
  }
}

function requireRow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new ConnectedAppUnavailable(message);
  return row;
}

function pgError(error: unknown): { code?: string; constraint?: string } {
  return error as { code?: string; constraint?: string };
}

/**
 * Connected-app owner for immutable MCP observations, explicit Account-bound
 * tool ceilings and single-dispatch invocations. It never opens Account's DB.
 */
export class ConnectedAppStore {
  constructor(private readonly pool: Pool, private readonly transport: McpTransport = new SafeMcpTransport()) {}

  async withEndpointLock<T>(principalId: string, endpoint: string,
    action: (lock: ConnectedAppEndpointLock) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockKey = `connected-app:${sha256(canonicalJson([principalId, endpoint]))}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      return await action({ principalId, endpoint, client });
    } catch (error) {
      const code = pgError(error).code;
      if (code === '57014' || code === '55P03') throw new ConnectedAppUnavailable('Connected-app endpoint is busy');
      throw error;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async observe(principalId: string, idempotencyKey: string, endpoint: string,
    bearerToken?: string, signal?: AbortSignal, lock?: ConnectedAppEndpointLock): Promise<{
      value: ObservationView; replayed: boolean }> {
    requireKey(idempotencyKey);
    if (!endpoint || endpoint.length > 2048) throw new ConnectedAppInvalid('MCP endpoint is invalid');
    if (lock && (lock.principalId !== principalId || lock.endpoint !== endpoint)) {
      throw new ConnectedAppInvalid('Connected-app endpoint lock does not match request');
    }
    if (!lock) return this.withEndpointLock(principalId, endpoint,
      held => this.observe(principalId, idempotencyKey, endpoint, bearerToken, signal, held));
    const prior = await lock.client.query<ObservationRow>(`SELECT * FROM connected_app.server_observation
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].endpoint !== endpoint) throw new ConnectedAppConflict('Idempotency-Key was used for another endpoint');
      return { value: await this.readObservation(prior.rows[0].id), replayed: true };
    }
    let snapshot: McpSnapshot;
    try { snapshot = await new McpProtocolClient(this.transport, endpoint, bearerToken).observe(signal); }
    catch (error) {
      if (error instanceof McpProtocolError || error instanceof McpHttpError || error instanceof McpCancelled) throw error;
      throw new ConnectedAppUnavailable('MCP server could not be reached');
    }
    const latest = (await lock.client.query<ObservationRow>(`SELECT * FROM connected_app.server_observation
      WHERE principal_id = $1 AND endpoint = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [principalId, endpoint])).rows[0];
    const now = new Date();
    // Identical checks refresh confidence without making an existing immutable
    // consent ceiling unusable. A new row is written for every schema or server
    // capability/version change, which atomically invalidates the old ceiling.
    if (latest?.tools_sha256 === snapshot.snapshotSha256) {
      return { value: { ...await this.readObservation(latest.id), drift: 'unchanged', observedAt: now.toISOString() },
        replayed: false };
    }
    const id = randomUUID();
    const drift = latest ? 'changed' : 'initial';
    try {
      await lock.client.query('BEGIN');
      await lock.client.query(`INSERT INTO connected_app.server_observation
        (id, principal_id, idempotency_key, endpoint, protocol_version, server_info, capabilities,
         tools_sha256, page_count, tool_count, predecessor_id, drift, observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, principalId, idempotencyKey,
        endpoint, snapshot.protocolVersion, JSON.stringify(snapshot.serverInfo), JSON.stringify(snapshot.capabilities),
        snapshot.snapshotSha256, snapshot.pages.length, snapshot.tools.length, latest?.id ?? null, drift, now]);
      for (const page of snapshot.pages) {
        await lock.client.query(`INSERT INTO connected_app.observation_page
          (observation_id, page_number, request_cursor, next_cursor, response_bytes, response_sha256)
          VALUES ($1,$2,$3,$4,$5,$6)`, [id, page.pageNumber, page.requestCursor, page.nextCursor,
          page.responseBytes, sha256(page.responseBytes)]);
      }
      for (const tool of snapshot.tools) {
        await lock.client.query(`INSERT INTO connected_app.tool_schema
          (observation_id, tool_name, page_number, definition, definition_jcs_sha256, schema_validation)
          VALUES ($1,$2,$3,$4,$5,$6)`, [id, tool.name, tool.pageNumber, JSON.stringify(tool.definition),
          tool.definitionJcsSha256, tool.schemaValidation]);
      }
      await lock.client.query('COMMIT');
    } catch (error) {
      await lock.client.query('ROLLBACK').catch(() => undefined);
      const pg = pgError(error);
      if (pg.code === '23505' || pg.code === '23514') {
        throw new ConnectedAppConflict(`MCP observation conflicted with current state (${pg.constraint ?? pg.code})`);
      }
      throw new ConnectedAppUnavailable('MCP observation could not be retained');
    }
    return { value: await this.readObservation(id), replayed: false };
  }

  async createCeiling(principalId: string, idempotencyKey: string, input: {
    observation: string; resource: string; tools: string[];
  }, basis: ConnectedAppConsentBasis): Promise<{ value: ConsentCeilingView; replayed: boolean }> {
    requireKey(idempotencyKey);
    checkBasis(basis);
    if (!UUID.test(input.observation) || !Array.isArray(input.tools) || input.tools.length < 1
      || input.tools.length > MCP_MAX_TOOLS || input.tools.some(name => typeof name !== 'string')
      || new Set(input.tools).size !== input.tools.length) {
      throw new ConnectedAppInvalid('Consent ceiling tool selection is invalid');
    }
    const preliminary = await this.pool.query<ObservationRow>(`SELECT * FROM connected_app.server_observation
      WHERE id = $1 AND principal_id = $2`, [input.observation, principalId]);
    const observation = preliminary.rows[0];
    if (!observation) throw new ConnectedAppUnavailable('MCP observation is unavailable');
    checkResource(observation.endpoint, input.resource, basis);
    return this.withEndpointLock(principalId, observation.endpoint, async lock => {
      const existing = (await lock.client.query<CeilingRow>(`SELECT * FROM connected_app.consent_ceiling
        WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, idempotencyKey])).rows[0];
      if (existing) {
        const value = await this.readCeiling(existing.id);
        const requestedNames = [...input.tools].sort();
        if (existing.observation_id !== input.observation || existing.resource !== input.resource
          || existing.account_client_id !== basis.clientId || existing.account_consent_id !== basis.consentId
          || existing.account_consent_generation !== basis.generation
          || value.tools.map(tool => tool.name).sort().join('\0') !== requestedNames.join('\0')) {
          throw new ConnectedAppConflict('Idempotency-Key was used for a different consent ceiling');
        }
        return { value, replayed: true };
      }
      const current = await lock.client.query(`SELECT 1 FROM connected_app.server_observation o
        WHERE o.id = $1 AND NOT EXISTS (SELECT 1 FROM connected_app.server_observation n
          WHERE n.predecessor_id = o.id)`, [input.observation]);
      if (current.rowCount !== 1) throw new ConnectedAppStale('MCP observation has changed; observe and obtain renewed consent');
      const selected = (await lock.client.query<ToolRow>(`SELECT * FROM connected_app.tool_schema
        WHERE observation_id = $1 AND tool_name = ANY($2::text[]) ORDER BY tool_name`,
      [input.observation, input.tools])).rows;
      if (selected.length !== input.tools.length) throw new ConnectedAppInvalid('Selected MCP tool is not in this observation');
      if (selected.some(tool => tool.schema_validation !== 'valid')) {
        throw new ConnectedAppInvalid('Unsupported or invalid MCP tool schemas cannot be consented');
      }
      const id = randomUUID();
      try {
        await lock.client.query('BEGIN');
        await lock.client.query(`INSERT INTO connected_app.consent_ceiling
          (id, principal_id, idempotency_key, account_client_id, account_consent_id,
           account_consent_generation, endpoint, resource, observation_id, tool_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, principalId, idempotencyKey, basis.clientId,
          basis.consentId, basis.generation, observation.endpoint, input.resource, input.observation, selected.length]);
        for (const tool of selected) await lock.client.query(`INSERT INTO connected_app.consent_ceiling_tool
          (ceiling_id, observation_id, tool_name, definition_jcs_sha256)
          VALUES ($1,$2,$3,$4)`, [id, input.observation, tool.tool_name, tool.definition_jcs_sha256]);
        await lock.client.query('COMMIT');
      } catch (error) {
        await lock.client.query('ROLLBACK').catch(() => undefined);
        const pg = pgError(error);
        if (pg.code === '23505' || pg.code === '23514') {
          throw new ConnectedAppConflict('Account consent already has an MCP ceiling for this endpoint');
        }
        throw new ConnectedAppUnavailable('MCP consent ceiling could not be retained');
      }
      return { value: await this.readCeiling(id), replayed: false };
    });
  }

  async readCeilingForPrincipal(principalId: string, id: string): Promise<ConsentCeilingView | null> {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query<CeilingRow>(`SELECT * FROM connected_app.consent_ceiling
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    return row ? this.readCeiling(id) : null;
  }

  async readInvocationByKey(principalId: string, key: string, requestDigest: string,
    basis: ConnectedAppConsentBasis): Promise<InvocationView | null> {
    const row = (await this.pool.query<InvocationDbRow>(`SELECT * FROM connected_app.invocation
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row) return null;
    if (row.request_digest !== requestDigest) throw new ConnectedAppConflict('Idempotency-Key was used for a different invocation');
    await this.getCeilingBasis(principalId, row.ceiling_id, basis);
    return invocationView(row, true);
  }

  async beginInvocation(principalId: string, idempotencyKey: string, input: {
    ceiling: string; toolName: string; arguments: Record<string, unknown>;
  }, basis: ConnectedAppConsentBasis): Promise<{ value: InvocationView; endpoint: string; resource: string;
    bearerAudience: string; replayed: boolean }> {
    requireKey(idempotencyKey);
    checkBasis(basis);
    if (!UUID.test(input.ceiling) || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.toolName) || !isObject(input.arguments)) {
      throw new ConnectedAppInvalid('MCP invocation request is invalid');
    }
    const argumentsBytes = jsonBytes(input.arguments, 'MCP arguments are not bounded JSON', MAX_ARGUMENT_BYTES);
    const argumentsSha256 = sha256(argumentsBytes);
    const requestDigest = sha256(canonicalJson({ ceiling: input.ceiling, toolName: input.toolName,
      arguments: input.arguments }));
    const existing = (await this.pool.query<InvocationDbRow>(`SELECT * FROM connected_app.invocation
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new ConnectedAppConflict('Idempotency-Key was used for a different invocation');
      const ceiling = await this.getCeilingBasis(principalId, existing.ceiling_id, basis);
      if (existing.state === 'admitted') {
        const latest = await this.isLatestObservation(existing.observation_id);
        if (!latest) {
          await this.cancelUnsent(existing.id);
          throw new ConnectedAppStale('MCP tool schema changed before dispatch; renewed consent is required');
        }
      }
      return { value: invocationView(existing, true), endpoint: ceiling.endpoint, resource: ceiling.resource,
        bearerAudience: ceiling.resource, replayed: true };
    }
    const ceiling = await this.getCeilingBasis(principalId, input.ceiling, basis);
    checkResource(ceiling.endpoint, ceiling.resource, basis);
    if (!basis.audiences.includes(ceiling.resource)) throw new ConnectedAppDenied('MCP credential audience is not in the current Account consent');
    const currentObservation = await this.isLatestObservation(ceiling.observation_id);
    if (!currentObservation) throw new ConnectedAppStale('MCP tool schema changed; renewed consent is required');
    const selected = (await this.pool.query<ToolRow>(`SELECT s.* FROM connected_app.consent_ceiling_tool c
      JOIN connected_app.tool_schema s ON s.observation_id = c.observation_id
        AND s.tool_name = c.tool_name AND s.definition_jcs_sha256 = c.definition_jcs_sha256
      WHERE c.ceiling_id = $1 AND c.tool_name = $2 AND c.schema_validation = 'valid'`,
    [input.ceiling, input.toolName])).rows[0];
    if (!selected) throw new ConnectedAppDenied('MCP tool is outside the Account consent ceiling');
    if (validateInputSchema(selected.definition.inputSchema) !== 'valid'
      || !argumentsMatch(selected.definition.inputSchema as JsonObject, input.arguments)) {
      throw new ConnectedAppInvalid('MCP arguments do not match the consented tool schema');
    }
    const id = randomUUID();
    let row: InvocationDbRow;
    try {
      row = requireRow((await this.pool.query<InvocationDbRow>(`INSERT INTO connected_app.invocation
        (id, principal_id, idempotency_key, request_digest, ceiling_id, account_consent_generation,
         credential_audience, observation_id, tool_name, definition_jcs_sha256,
         schema_validation, arguments_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'valid',$11) RETURNING *`, [id, principalId,
        idempotencyKey, requestDigest, input.ceiling, basis.generation, ceiling.resource, ceiling.observation_id,
        input.toolName, selected.definition_jcs_sha256, argumentsSha256])).rows, 'Invocation could not be admitted');
    } catch (error) {
      const pg = pgError(error);
      if (pg.code === '23505') {
        const raced = await this.readInvocationByKey(principalId, idempotencyKey, requestDigest, basis);
        if (raced) {
          const latest = await this.getCeilingBasis(principalId, input.ceiling, basis);
          return { value: raced, endpoint: latest.endpoint, resource: latest.resource,
            bearerAudience: latest.resource, replayed: true };
        }
        throw new ConnectedAppConflict('MCP invocation conflicted with another request');
      }
      if (pg.code === '23514' || pg.code === '23503') throw new ConnectedAppStale('MCP invocation basis changed');
      throw new ConnectedAppUnavailable('MCP invocation could not be admitted');
    }
    return { value: invocationView(row, false), endpoint: ceiling.endpoint, resource: ceiling.resource,
      bearerAudience: ceiling.resource, replayed: false };
  }

  async claimDispatch(id: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE connected_app.invocation SET state = 'sent'
      WHERE id = $1 AND state = 'admitted'`, [id]);
    return result.rowCount === 1;
  }

  async cancelUnsent(id: string): Promise<void> {
    await this.pool.query(`UPDATE connected_app.invocation SET state = 'cancelled'
      WHERE id = $1 AND state = 'admitted'`, [id]);
  }

  async markCancelRequested(id: string): Promise<void> {
    await this.pool.query(`UPDATE connected_app.invocation SET state = 'cancel-requested'
      WHERE id = $1 AND state = 'sent'`, [id]);
  }

  async finishInvocation(id: string, outcome: { state: 'completed' | 'tool-error'; resultSha256: string }
    | { state: 'protocol-error'; protocolError: Record<string, unknown> }
    | { state: 'uncertain' }): Promise<InvocationView> {
    const result = await this.pool.query<InvocationDbRow>(`UPDATE connected_app.invocation
      SET state = $2, result_sha256 = $3, protocol_error = $4
      WHERE id = $1 AND state IN ('sent', 'cancel-requested', 'uncertain') RETURNING *`, [id,
    outcome.state, 'resultSha256' in outcome ? outcome.resultSha256 : null,
    'protocolError' in outcome ? JSON.stringify(outcome.protocolError) : null]);
    if (result.rows[0]) return invocationView(result.rows[0], false);
    const row = (await this.pool.query<InvocationDbRow>(`SELECT * FROM connected_app.invocation WHERE id = $1`, [id])).rows[0];
    return invocationView(requireRow(row ? [row] : [], 'Invocation receipt is unavailable'), true);
  }

  async readInvocation(principalId: string, id: string): Promise<InvocationView | null> {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query<InvocationDbRow>(`SELECT * FROM connected_app.invocation
      WHERE principal_id = $1 AND id = $2`, [principalId, id])).rows[0];
    return row ? invocationView(row, true) : null;
  }

  async invoke(endpoint: string, token: string, toolName: string, args: Record<string, unknown>,
    signal: AbortSignal, onCancelRequested: () => Promise<void>): Promise<McpToolResult> {
    return new McpProtocolClient(this.transport, endpoint, token).callTool(toolName, args, signal, onCancelRequested);
  }

  async getInvocationCeiling(principalId: string, ceilingId: string,
    basis: ConnectedAppConsentBasis): Promise<ConsentCeilingView | null> {
    if (!UUID.test(ceilingId)) return null;
    const row = (await this.pool.query<CeilingRow>(`SELECT * FROM connected_app.consent_ceiling
      WHERE id = $1 AND principal_id = $2`, [ceilingId, principalId])).rows[0];
    if (!row) return null;
    if (row.account_client_id !== basis.clientId || row.account_consent_id !== basis.consentId
      || row.account_consent_generation !== basis.generation) {
      throw new ConnectedAppStale('Account consent changed; renewed approval is required');
    }
    checkResource(row.endpoint, row.resource, basis);
    return this.readCeiling(row.id);
  }

  private async getCeilingBasis(principalId: string, ceilingId: string,
    basis: ConnectedAppConsentBasis): Promise<CeilingRow> {
    if (!UUID.test(ceilingId)) throw new ConnectedAppUnavailable('MCP consent ceiling is unavailable');
    const row = (await this.pool.query<CeilingRow>(`SELECT * FROM connected_app.consent_ceiling
      WHERE id = $1 AND principal_id = $2 AND account_client_id = $3 AND account_consent_id = $4
        AND account_consent_generation = $5`, [ceilingId, principalId, basis.clientId, basis.consentId,
    basis.generation])).rows[0];
    if (!row) throw new ConnectedAppDenied('MCP consent ceiling does not match current Account consent');
    return row;
  }

  private async isLatestObservation(id: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM connected_app.server_observation o
      WHERE o.id = $1 AND NOT EXISTS (SELECT 1 FROM connected_app.server_observation n
        WHERE n.predecessor_id = o.id)`, [id]);
    return result.rowCount === 1;
  }

  private async readObservation(id: string): Promise<ObservationView> {
    const row = requireRow((await this.pool.query<ObservationRow>(`SELECT * FROM connected_app.server_observation
      WHERE id = $1`, [id])).rows, 'MCP observation is unavailable');
    const [pages, tools] = await Promise.all([
      this.pool.query<PageRow>(`SELECT page_number, request_cursor, next_cursor, response_bytes
        FROM connected_app.observation_page WHERE observation_id = $1 ORDER BY page_number`, [id]),
      this.pool.query<ToolRow>(`SELECT tool_name, page_number, definition, definition_jcs_sha256,
        schema_validation FROM connected_app.tool_schema WHERE observation_id = $1 ORDER BY tool_name`, [id]),
    ]);
    return { observation: row.id, endpoint: row.endpoint, protocolVersion: row.protocol_version,
      serverInfo: row.server_info, capabilities: row.capabilities, snapshotSha256: row.tools_sha256,
      pageCount: pages.rows.length, toolCount: tools.rows.length, predecessor: row.predecessor_id,
      drift: row.drift, observedAt: row.observed_at.toISOString(),
      tools: tools.rows.map(tool => ({ name: tool.tool_name, definition: tool.definition,
        definitionSha256: tool.definition_jcs_sha256, schemaValidation: tool.schema_validation,
        pageNumber: tool.page_number })) };
  }

  private async readCeiling(id: string): Promise<ConsentCeilingView> {
    const row = requireRow((await this.pool.query<CeilingRow>(`SELECT * FROM connected_app.consent_ceiling
      WHERE id = $1`, [id])).rows, 'MCP consent ceiling is unavailable');
    const tools = await this.pool.query<{ tool_name: string; definition_jcs_sha256: string }>(`
      SELECT tool_name, definition_jcs_sha256 FROM connected_app.consent_ceiling_tool
      WHERE ceiling_id = $1 ORDER BY tool_name`, [id]);
    return { ceiling: row.id, observation: row.observation_id, endpoint: row.endpoint, resource: row.resource,
      consentId: row.account_consent_id, consentGeneration: row.account_consent_generation,
      tools: tools.rows.map(tool => ({ name: tool.tool_name, definitionSha256: tool.definition_jcs_sha256 })),
      createdAt: row.created_at.toISOString() };
  }
}

function invocationView(row: InvocationDbRow, replayed: boolean): InvocationView {
  return { invocation: row.id, ceiling: row.ceiling_id, observation: row.observation_id,
    toolName: row.tool_name, definitionSha256: row.definition_jcs_sha256,
    argumentsSha256: row.arguments_sha256, state: row.state, resultSha256: row.result_sha256,
    protocolError: row.protocol_error, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), replayed };
}

export function connectedAppRequestDigest(value: { ceiling: string; toolName: string;
  arguments: Record<string, unknown> }): string {
  return sha256(canonicalJson(value));
}

export function isMcpToolError(result: Record<string, unknown>): boolean {
  return result.isError === true;
}

export function invocationProtocolError(error: unknown): Record<string, unknown> {
  if (error instanceof McpHttpError) return { code: error.status >= 400 ? -32000 : -32603,
    message: `MCP server returned HTTP ${error.status}` };
  if (error instanceof McpProtocolError && error.protocolError) {
    return { code: error.protocolError.code, message: String(error.protocolError.message).slice(0, 2048) };
  }
  return { code: -32603, message: 'MCP server response was invalid' };
}

export function isDefiniteMcpProtocolFailure(error: unknown): boolean {
  return (error instanceof McpProtocolError && error.protocolError !== undefined)
    || (error instanceof McpHttpError && error.status < 500);
}

export function validMcpToolResult(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Array.isArray(value.content)
    && value.content.every(item => isObject(item) && typeof item.type === 'string')
    && (value.isError === undefined || typeof value.isError === 'boolean');
}
