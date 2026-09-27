// Typed declarations for the shared derived-generation owner (Access migration
// 110). The SQL migration remains the DDL owner; the schema test compares these
// column lists with the catalog. pg returns bigint and numeric as decimal text.

type Exhaustive<Row, Columns extends readonly (keyof Row)[]> =
  Exclude<keyof Row, Columns[number]> extends never ? Columns : never;

export interface TableDeclaration<Row> {
  schema: 'access' | 'content';
  name: string;
  columns: readonly (keyof Row & string)[];
}

/** Declare every row column once; omitting or inventing a column fails typechecking. */
export function declareTable<Row>() {
  return <const Columns extends readonly (keyof Row & string)[]>(schema: 'access' | 'content',
    name: string, columns: Exhaustive<Row, Columns>): TableDeclaration<Row> => ({ schema, name, columns });
}

const DERIVED_GENERATION_FAMILIES = ['ranking', 'event-interval', 'discovery'] as const;
type DerivedGenerationFamily = (typeof DERIVED_GENERATION_FAMILIES)[number];
const DERIVED_GENERATION_STATES =
  ['building', 'ready', 'failed', 'cancelled', 'superseded', 'expired'] as const;
type DerivedGenerationState = (typeof DERIVED_GENERATION_STATES)[number];
/** Owner streams whose application {dataEpoch, sequence} positions a generation pins. */
const DERIVED_GENERATION_SOURCES = ['main-graph', 'content', 'access'] as const;
type DerivedGenerationSource = (typeof DERIVED_GENERATION_SOURCES)[number];

export interface DerivedGenerationFamilyRow {
  family: DerivedGenerationFamily;
  max_retained: number;
  retain_for: string;
}

export interface DerivedGenerationRow {
  id: string;
  family: DerivedGenerationFamily;
  scope_key: string;
  input_digest: string;
  input_manifest: Record<string, unknown>;
  state: DerivedGenerationState;
  lease_epoch: string;
  lease_expires_at: Date | null;
  validation_digest: string | null;
  failure_reason: string | null;
  created_at: Date;
  ready_at: Date | null;
  finished_at: Date | null;
}

export interface DerivedGenerationInputRow {
  generation_id: string;
  source: DerivedGenerationSource;
  data_epoch: string;
  pinned_sequence: string;
  snapshot_cursor: string | null;
  snapshot_complete: boolean;
  checkpoint_sequence: string;
  checkpoint_event: string | null;
}

export interface DerivedGenerationHeadRow {
  family: DerivedGenerationFamily;
  scope_key: string;
  active_generation: string;
  revision: string;
  activated_at: Date;
}

export interface DerivedGenerationActivationRow {
  family: DerivedGenerationFamily;
  scope_key: string;
  revision: string;
  generation_id: string;
  predecessor: string | null;
  lease_epoch: string;
  input_positions: { source: DerivedGenerationSource; dataEpoch: string; sequence: string }[];
  activated_at: Date;
}

export interface DerivedGenerationReceiptRow {
  principal_id: string;
  idempotency_key: string;
  request_digest: string;
  action: 'build' | 'activate' | 'cancel';
  generation_id: string;
  outcome: 'succeeded' | 'stale_head' | 'rejected';
  head_revision: string | null;
  created_at: Date;
}

export const derivedGenerationTables = [
  declareTable<DerivedGenerationFamilyRow>()('access', 'derived_generation_family',
    ['family', 'max_retained', 'retain_for']),
  declareTable<DerivedGenerationRow>()('access', 'derived_generation',
    ['id', 'family', 'scope_key', 'input_digest', 'input_manifest', 'state', 'lease_epoch',
      'lease_expires_at', 'validation_digest', 'failure_reason', 'created_at', 'ready_at', 'finished_at']),
  declareTable<DerivedGenerationInputRow>()('access', 'derived_generation_input',
    ['generation_id', 'source', 'data_epoch', 'pinned_sequence', 'snapshot_cursor',
      'snapshot_complete', 'checkpoint_sequence', 'checkpoint_event']),
  declareTable<DerivedGenerationHeadRow>()('access', 'derived_generation_head',
    ['family', 'scope_key', 'active_generation', 'revision', 'activated_at']),
  declareTable<DerivedGenerationActivationRow>()('access', 'derived_generation_activation',
    ['family', 'scope_key', 'revision', 'generation_id', 'predecessor', 'lease_epoch',
      'input_positions', 'activated_at']),
  declareTable<DerivedGenerationReceiptRow>()('access', 'derived_generation_receipt',
    ['principal_id', 'idempotency_key', 'request_digest', 'action', 'generation_id', 'outcome',
      'head_revision', 'created_at']),
] as const;
