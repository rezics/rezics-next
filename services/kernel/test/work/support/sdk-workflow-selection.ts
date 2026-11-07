import {
  DBOS,
  DBOSClient,
  WORKFLOW_STATUS_SCAN_INDEX,
  WORKFLOW_STATUS_SCAN_RAW_LIMIT,
  type WorkflowStatusScanContinuation,
  type WorkflowStatusScanPage,
} from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';

export { WORKFLOW_STATUS_SCAN_INDEX, WORKFLOW_STATUS_SCAN_RAW_LIMIT };

export type ScanStatusFields = {
  readonly application: string;
  readonly status: string;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly name?: string;
};

export type ScanPlan = {
  readonly query: string;
  readonly nodeTypes: readonly string[];
  readonly indexes: readonly string[];
  readonly relations: readonly string[];
  readonly actualRows: number;
  readonly sharedBlocks: number;
  readonly output: readonly string[];
};

const planMarker = 'plan:\n';

export function scanPrefix(): string {
  return `scan:${crypto.randomUUID()}:`;
}

export async function insertScanStatus(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
  fields: ScanStatusFields,
): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `INSERT INTO dbos.workflow_status
       (workflow_uuid, status, name, authenticated_roles, recovery_attempts,
        created_at, updated_at, completed_at, application_name)
     SELECT value, $2, $3, '[]', 0, $4, $4, $5, $6
       FROM unnest($1::text[]) AS value`,
    [ids, fields.status, fields.name ?? 'scan.fixture', fields.createdAt, fields.completedAt, fields.application],
  );
}

export async function insertScanPayload(pool: Pick<Pool, 'query'>, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `INSERT INTO dbos.workflow_input (workflow_uuid, inputs)
     SELECT value, $2 FROM unnest($1::text[]) AS value
     ON CONFLICT (workflow_uuid) DO NOTHING`,
    [ids, JSON.stringify(['scan-input-payload'])],
  );
  await pool.query(
    `INSERT INTO dbos.workflow_output (workflow_uuid, output, error)
     SELECT value, $2, NULL FROM unnest($1::text[]) AS value
     ON CONFLICT (workflow_uuid) DO NOTHING`,
    [ids, JSON.stringify({ payload: 'scan-output-payload' })],
  );
}

export async function deleteScanRows(pool: Pick<Pool, 'query'>, idPattern: string): Promise<void> {
  await pool.query('DELETE FROM dbos.workflow_input WHERE workflow_uuid LIKE $1', [idPattern]);
  await pool.query('DELETE FROM dbos.workflow_output WHERE workflow_uuid LIKE $1', [idPattern]);
  await pool.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [idPattern]);
}

export async function readScanIndex(pool: Pick<Pool, 'query'>): Promise<string | undefined> {
  const result = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'dbos' AND indexname = $1`,
    [WORKFLOW_STATUS_SCAN_INDEX],
  );
  return result.rows[0]?.indexdef;
}

export function expectScanIndex(definition: string | undefined): void {
  if (!definition) throw new Error(`${WORKFLOW_STATUS_SCAN_INDEX} is missing`);
  for (const part of [
    WORKFLOW_STATUS_SCAN_INDEX,
    'application_name',
    'created_at',
    'workflow_uuid',
    'INCLUDE',
    'name',
    'status',
    'completed_at',
  ]) {
    if (!definition.includes(part)) throw new Error(`${WORKFLOW_STATUS_SCAN_INDEX} missing ${part}: ${definition}`);
  }
}

export async function createScanClient(url: string, pool: Pool): Promise<DBOSClient> {
  return DBOSClient.create({ systemDatabaseUrl: url, systemDatabasePool: pool });
}

export function assertScanProducer(): void {
  if (typeof DBOS.openWorkflowStatusScan !== 'function' || typeof DBOS.readWorkflowStatusScanPage !== 'function') {
    throw new Error('DBOS static workflow-status scan is missing');
  }
  if (
    typeof DBOSClient.prototype.openWorkflowStatusScan !== 'function' ||
    typeof DBOSClient.prototype.readWorkflowStatusScanPage !== 'function'
  ) {
    throw new Error('DBOSClient workflow-status scan is missing');
  }
}

export async function readAllPages(
  client: DBOSClient,
  continuation: WorkflowStatusScanContinuation,
  rawLimit = WORKFLOW_STATUS_SCAN_RAW_LIMIT,
): Promise<WorkflowStatusScanPage[]> {
  const pages: WorkflowStatusScanPage[] = [];
  let current = continuation;
  for (let step = 0; step < 80; step++) {
    const page = await client.readWorkflowStatusScanPage(current, { rawLimit });
    pages.push(page);
    current = page.continuation;
    if (page.exhausted) return pages;
  }
  throw new Error('Workflow status scan did not exhaust');
}

export function observeScanPlans(pool: Pool, plans: ScanPlan[]): () => void {
  const observed = new WeakSet<PoolClient>();
  const attach = (connection: PoolClient) => {
    if (observed.has(connection)) return;
    observed.add(connection);
    connection.on('notice', ({ message }) => {
      if (!message?.startsWith('duration:') || !message.includes(planMarker)) return;
      if (!message.includes('dbos:workflow-status-scan-')) return;
      try {
        plans.push(summarizePlan(JSON.parse(message.slice(message.indexOf(planMarker) + planMarker.length))));
      } catch {
        // Invalid notices are not plans.
      }
    });
  };
  const onConnect = (connection: PoolClient) => attach(connection);
  pool.on('connect', onConnect);
  pool.on('acquire', onConnect);
  for (const connection of (pool as Pool & { _clients?: PoolClient[] })._clients ?? []) attach(connection);
  return () => {
    pool.off('connect', onConnect);
    pool.off('acquire', onConnect);
  };
}

export async function enableAutoExplain(pool: Pool): Promise<void> {
  const configure = async (connection: PoolClient) => {
    await connection.query("LOAD 'auto_explain'");
    await connection.query('SET auto_explain.log_min_duration = 0');
    await connection.query('SET auto_explain.log_analyze = on');
    await connection.query('SET auto_explain.log_buffers = on');
    await connection.query('SET auto_explain.log_timing = off');
    await connection.query('SET auto_explain.log_nested_statements = on');
    await connection.query("SET auto_explain.log_format = 'json'");
    await connection.query("SET auto_explain.log_level = 'notice'");
  };
  pool.on('connect', (connection) => {
    void configure(connection);
  });
  const connection = await pool.connect();
  try {
    await configure(connection);
  } finally {
    connection.release();
  }
}

function summarizePlan(document: unknown): ScanPlan {
  const roots = Array.isArray(document) ? document : [document];
  const entry = roots.find((root) => typeof root === 'object' && root !== null && 'Plan' in root) as
    | { readonly 'Query Text'?: string; readonly Plan?: Record<string, unknown> }
    | undefined;
  const plan = entry?.Plan ?? {};
  const nodeTypes: string[] = [];
  const indexes: string[] = [];
  const relations: string[] = [];
  const output: string[] = [];
  let actualRows = 0;
  let sharedBlocks = 0;
  const stack: unknown[] = [plan];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typeof record['Node Type'] === 'string') nodeTypes.push(record['Node Type']);
    if (typeof record['Index Name'] === 'string') indexes.push(record['Index Name']);
    if (typeof record['Relation Name'] === 'string') relations.push(record['Relation Name']);
    if (typeof record['Actual Rows'] === 'number') actualRows += record['Actual Rows'];
    if (typeof record['Shared Hit Blocks'] === 'number') sharedBlocks += record['Shared Hit Blocks'];
    if (typeof record['Shared Read Blocks'] === 'number') sharedBlocks += record['Shared Read Blocks'];
    if (Array.isArray(record.Output)) output.push(...record.Output.filter((item) => typeof item === 'string'));
    if (Array.isArray(record.Plans)) stack.push(...record.Plans);
  }
  return {
    query: typeof entry?.['Query Text'] === 'string' ? entry['Query Text'] : '',
    nodeTypes,
    indexes,
    relations,
    actualRows,
    sharedBlocks,
    output,
  };
}

export function expectIndexedScan(plan: ScanPlan, kind: 'open' | 'page'): void {
  if (!plan.query.includes(`dbos:workflow-status-scan-${kind}`)) {
    throw new Error(`missing ${kind} tag: ${plan.query}`);
  }
  if (plan.indexes.every((index) => index !== WORKFLOW_STATUS_SCAN_INDEX)) {
    throw new Error(`${kind} did not use ${WORKFLOW_STATUS_SCAN_INDEX}: ${plan.indexes.join(',')}`);
  }
  if (plan.nodeTypes.some((type) => type.includes('Seq Scan'))) {
    throw new Error(`${kind} sequential scan: ${plan.nodeTypes.join(',')}`);
  }
  if (/\boffset\b/i.test(plan.query)) throw new Error(`${kind} used OFFSET`);
  if (plan.query.includes('workflow_input') || plan.query.includes('workflow_output')) {
    throw new Error(`${kind} projected payload tables`);
  }
  if (plan.relations.some((relation) => relation === 'workflow_input' || relation === 'workflow_output')) {
    throw new Error(`${kind} touched payload relations: ${plan.relations.join(',')}`);
  }
}
