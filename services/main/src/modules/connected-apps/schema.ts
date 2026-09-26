import type { Columns, Sha256Hex } from '../package/lock-schema.ts';

/**
 * Row types for MCP observations, tool-schema versions and their binding to
 * Account consent generations (`services/content/migrations/054_*`). Account
 * owns consent; these rows only reference its consent id and generation.
 */
export interface ServerObservationRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  endpoint: string;
  /** Pinned stateless MCP protocol revision date. */
  protocol_version: string;
  server_info: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  tools_sha256: Sha256Hex;
  page_count: number;
  tool_count: number;
  predecessor_id: string | null;
  drift: 'initial' | 'unchanged' | 'changed';
  observed_at: Date;
  created_at: Date;
}

export interface ObservationPageRow {
  observation_id: string;
  page_number: number;
  request_cursor: string | null;
  next_cursor: string | null;
  response_bytes: Buffer;
  response_sha256: Sha256Hex;
}

export interface ToolSchemaRow {
  observation_id: string;
  tool_name: string;
  page_number: number;
  definition: Record<string, unknown>;
  /** SHA-256 of the RFC 8785 canonical JSON of the observed definition. */
  definition_jcs_sha256: Sha256Hex;
  schema_validation: 'valid' | 'invalid' | 'unsupported';
}

export interface ConsentCeilingRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  account_client_id: string;
  account_consent_id: string;
  account_consent_generation: string;
  endpoint: string;
  /** Audience of the credential forwarded to this server (RFC 8707 resource). */
  resource: string;
  observation_id: string;
  tool_count: number;
  created_at: Date;
}

export interface ConsentCeilingToolRow {
  ceiling_id: string;
  observation_id: string;
  tool_name: string;
  definition_jcs_sha256: Sha256Hex;
  schema_validation: 'valid';
}

type InvocationState = 'admitted' | 'sent' | 'completed' | 'tool-error' | 'protocol-error'
  | 'cancel-requested' | 'cancelled' | 'uncertain';

export interface InvocationRow {
  id: string;
  principal_id: string;
  idempotency_key: string;
  request_digest: Sha256Hex;
  ceiling_id: string;
  account_consent_generation: string;
  credential_audience: string;
  observation_id: string;
  tool_name: string;
  definition_jcs_sha256: Sha256Hex;
  schema_validation: 'valid';
  arguments_sha256: Sha256Hex;
  state: InvocationState;
  result_sha256: Sha256Hex | null;
  protocol_error: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export const connectedAppTables = {
  'connected_app.server_observation': {
    id: true, principal_id: true, idempotency_key: true, endpoint: true, protocol_version: true,
    server_info: true, capabilities: true, tools_sha256: true, page_count: true, tool_count: true,
    predecessor_id: true, drift: true, observed_at: true, created_at: true,
  } satisfies Columns<ServerObservationRow>,
  'connected_app.observation_page': {
    observation_id: true, page_number: true, request_cursor: true, next_cursor: true,
    response_bytes: true, response_sha256: true,
  } satisfies Columns<ObservationPageRow>,
  'connected_app.tool_schema': {
    observation_id: true, tool_name: true, page_number: true, definition: true,
    definition_jcs_sha256: true, schema_validation: true,
  } satisfies Columns<ToolSchemaRow>,
  'connected_app.consent_ceiling': {
    id: true, principal_id: true, idempotency_key: true, account_client_id: true,
    account_consent_id: true, account_consent_generation: true, endpoint: true, resource: true,
    observation_id: true, tool_count: true, created_at: true,
  } satisfies Columns<ConsentCeilingRow>,
  'connected_app.consent_ceiling_tool': {
    ceiling_id: true, observation_id: true, tool_name: true, definition_jcs_sha256: true,
    schema_validation: true,
  } satisfies Columns<ConsentCeilingToolRow>,
  'connected_app.invocation': {
    id: true, principal_id: true, idempotency_key: true, request_digest: true, ceiling_id: true,
    account_consent_generation: true, credential_audience: true, observation_id: true,
    tool_name: true, definition_jcs_sha256: true, schema_validation: true,
    arguments_sha256: true, state: true, result_sha256: true, protocol_error: true,
    created_at: true, updated_at: true,
  } satisfies Columns<InvocationRow>,
} as const;
