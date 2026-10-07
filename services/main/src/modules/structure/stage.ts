import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { hash } from '../work/activate.ts';
import { COMPOSITION_PROFILE, NATIVE_ID, derivedId, orderTreeKey, recordTreeKey } from './graph.ts';
import { orderTree, recordTree } from './change.ts';
import { checkOccurrenceRecord, checkStructureManifest, checkStructurePage,
  STRUCTURE_LIMITS, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT,
  type OccurrenceRecord, type OrderEntry } from './format.ts';
import { newCost } from './tree.ts';
import { deepestLevel, structureProfileFor } from './profiles.ts';

const book = structureProfileFor('book-composition');

export class StructureStageInvalid extends Error {}
export class StructureStageConflict extends Error {}
export class StructureStageUnavailable extends Error {}
const STAGE_MATERIALIZATION_LIMIT = STRUCTURE_LIMITS.stageRecords;

interface StageRow {
  id: string; principal_id: string; structure: string; generation: string;
  kind: 'replace' | 'import' | 'refresh'; source_ref: string | null;
  source_revision: string | null; mapping_policy: 'source-key' | 'explicit' | null;
  base_head: string; status: 'staging' | 'sealed' | 'activated' | 'cancelled' | 'failed';
  lease_holder: string | null; lease_fence: string; lease_expires_at: Date | null;
  staged_pages: number; staged_records: string; staged_bytes: string;
  graph_started: boolean; projection_batches: number;
  root_manifest: string | null; placement_count: number | null;
  graph_receipt: string | null; graph_data_epoch: string | null;
  graph_sequence: string | null; revision: string | null;
}

export interface StructureStage {
  id: string; structure: string; generation: string; baseHead: string;
  kind: StageRow['kind']; sourceRef: string | null; sourceRevision: string | null;
  mappingPolicy: StageRow['mapping_policy'];
  revision: string; status: StageRow['status']; holder: string | null; fence: string;
  pages: number; records: number; bytes: number; manifest: string | null;
  graphStarted: boolean; projectionBatches: number;
  placementCount: number | null; graphReceipt: string | null;
  graphDataEpoch: string | null; graphSequence: string | null;
}

function view(row: StageRow): StructureStage {
  return { id: row.id, structure: row.structure, generation: row.generation,
    kind: row.kind, sourceRef: row.source_ref, sourceRevision: row.source_revision,
    mappingPolicy: row.mapping_policy,
    baseHead: row.base_head, revision: row.revision
      ?? derivedId(`${row.id}\0composition\0revision`), status: row.status,
    holder: row.lease_holder, fence: String(row.lease_fence), pages: row.staged_pages,
    records: Number(row.staged_records), bytes: Number(row.staged_bytes),
    manifest: row.root_manifest, graphStarted: row.graph_started,
    projectionBatches: row.projection_batches, placementCount: row.placement_count,
    graphReceipt: row.graph_receipt, graphDataEpoch: row.graph_data_epoch,
    graphSequence: row.graph_sequence === null ? null : String(row.graph_sequence) };
}

/** Content DB checkpoint and RustFS pages; no stage row is a Structure revision. */
export class StructureStageStore {
  constructor(private readonly pool: Pool, private readonly objects: ImmutableObjects) {}

  async create(input: { principalId: string; idempotencyKey: string; scope: string;
    structure: string; baseHead: string; kind?: 'replace' | 'import' | 'refresh';
    sourceRef?: string; sourceRevision?: string; mappingPolicy?: 'source-key' | 'explicit' }):
    Promise<StructureStage> {
    const kind = input.kind ?? 'replace';
    if ((kind === 'replace') !== (input.sourceRef === undefined && input.sourceRevision === undefined
      && input.mappingPolicy === undefined) || kind !== 'replace'
      && (!NATIVE_ID.test(input.sourceRef ?? '') || !NATIVE_ID.test(input.sourceRevision ?? '')
        || !input.mappingPolicy)) throw new StructureStageInvalid('stage source metadata is invalid');
    const digest = hash(JSON.stringify({ family: 'structure-stage-create-v1',
      structure: input.structure, baseHead: input.baseHead, kind,
      ...(kind !== 'replace' ? { sourceRef: input.sourceRef,
        sourceRevision: input.sourceRevision, mappingPolicy: input.mappingPolicy } : {}) }));
    const prior = await this.pool.query<StageRow & { request_digest: string }>(
      'SELECT * FROM structure.stage_job WHERE principal_id = $1 AND idempotency_key = $2',
      [input.principalId, input.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== digest) throw new StructureStageConflict('stage key has another intent');
      return view(prior.rows[0]);
    }
    const id = randomUUID(), holder = randomUUID();
    const generation = derivedId(`${id}\0composition\0generation`);
    try {
      const inserted = await this.pool.query<StageRow>(`INSERT INTO structure.stage_job
        (id, principal_id, idempotency_key, request_digest, authority_scope, structure,
          generation, kind, base_head, source_ref, source_revision, mapping_policy,
          status, lease_holder, lease_fence, lease_expires_at, deadline_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'staging',$13,1,
          clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 day')
        RETURNING *`, [id, input.principalId, input.idempotencyKey, digest, input.scope,
        input.structure, generation, kind, input.baseHead, input.sourceRef ?? null,
        input.sourceRevision ?? null, input.mappingPolicy ?? null, holder]);
      return view(inserted.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new StructureStageConflict('another stage is open or this key was used concurrently');
      }
      throw error;
    }
  }

  async read(id: string, principalId: string, structure: string): Promise<StructureStage> {
    const result = await this.pool.query<StageRow>(`SELECT * FROM structure.stage_job
      WHERE id = $1 AND principal_id = $2 AND structure = $3`, [id, principalId, structure]);
    if (!result.rows[0]) throw new StructureStageUnavailable('stage is unavailable');
    return view(result.rows[0]);
  }

  async renew(id: string, principalId: string, structure: string): Promise<StructureStage> {
    const holder = randomUUID();
    const result = await this.pool.query<StageRow>(`UPDATE structure.stage_job
      SET lease_holder = $4, lease_fence = lease_fence + 1,
        lease_expires_at = clock_timestamp() + interval '5 minutes'
      WHERE id = $1 AND principal_id = $2 AND structure = $3
        AND status IN ('staging','sealed') AND NOT graph_started
        AND deadline_at > clock_timestamp()
      RETURNING *`, [id, principalId, structure, holder]);
    if (!result.rows[0]) throw new StructureStageConflict('stage cannot renew its lease');
    return view(result.rows[0]);
  }

  async upload(input: { id: string; principalId: string; structure: string; holder: string;
    fence: string; ordinal: number; entries: readonly OccurrenceRecord[] }): Promise<StructureStage> {
    if (!Number.isInteger(input.ordinal) || input.ordinal < 0
      || input.ordinal >= STRUCTURE_LIMITS.stagePages || !input.entries.length
      || input.entries.length > STRUCTURE_LIMITS.pageEntries) {
      throw new StructureStageInvalid('stage page exceeds its bounds');
    }
    const page = { format: STRUCTURE_PAGE_FORMAT, tree: 'record' as const,
      level: 0 as const, entries: input.entries };
    const bytes = new TextEncoder().encode(JSON.stringify(page));
    checkStructurePage(bytes);
    for (const record of input.entries) checkOccurrenceRecord(record, 'book-composition');
    const digest = hash(bytes);
    const stage = await this.read(input.id, input.principalId, input.structure);
    if (input.ordinal < stage.pages) {
      const prior = await this.pool.query<{ page_digest: string }>(`SELECT page_digest
        FROM structure.stage_page WHERE job_id = $1 AND ordinal = $2`, [input.id, input.ordinal]);
      if (prior.rows[0]?.page_digest !== digest) throw new StructureStageConflict('checkpoint page differs');
      return stage;
    }
    if (stage.status !== 'staging' || stage.holder !== input.holder || stage.fence !== input.fence
      || input.ordinal !== stage.pages) throw new StructureStageConflict('stage lease or checkpoint is stale');
    if (stage.records + input.entries.length > STAGE_MATERIALIZATION_LIMIT) {
      throw new StructureStageInvalid('stage exceeds the bounded manifest builder');
    }
    if (await this.objects.put(bytes) !== digest) {
      throw new StructureStageInvalid('immutable stage page digest differs');
    }
    try {
      await this.pool.query(`INSERT INTO structure.stage_page
        (job_id, ordinal, page_digest, tree, level, entry_count, byte_length, lease_fence)
        VALUES ($1,$2,$3,'record',0,$4,$5,$6)`, [input.id, input.ordinal, digest,
        input.entries.length, bytes.length, input.fence]);
    } catch (error) {
      if (['23514', '23505'].includes((error as { code?: string }).code ?? '')) {
        throw new StructureStageConflict('stage lease or checkpoint is stale');
      }
      throw error;
    }
    return this.read(input.id, input.principalId, input.structure);
  }

  async seal(input: { id: string; principalId: string; structure: string; mainVersion: string;
    holder: string; fence: string; canReadTarget: (target: string) => Promise<boolean> }):
    Promise<StructureStage> {
    const stage = await this.read(input.id, input.principalId, input.structure);
    if (stage.status === 'sealed') return stage;
    if (stage.status !== 'staging' || stage.holder !== input.holder || stage.fence !== input.fence) {
      throw new StructureStageConflict('stage lease is stale');
    }
    const pages = await this.pool.query<{ ordinal: number; page_digest: string }>(
      'SELECT ordinal, page_digest FROM structure.stage_page WHERE job_id = $1 ORDER BY ordinal', [input.id]);
    if (pages.rows.length !== stage.pages || pages.rows.some((row, index) => row.ordinal !== index)) {
      throw new StructureStageConflict('stage checkpoint has a gap');
    }
    const records: OccurrenceRecord[] = [];
    for (const row of pages.rows) {
      const page = checkStructurePage(await this.objects.get(row.page_digest));
      if (page.tree !== 'record' || page.level !== 0) throw new StructureStageInvalid('stage page tree differs');
      records.push(...page.entries as OccurrenceRecord[]);
    }
    if (records.length !== stage.records || records.length > STAGE_MATERIALIZATION_LIMIT) {
      throw new StructureStageInvalid('stage record count differs');
    }
    const byId = new Map(records.map(record => [record.occurrence, record]));
    if (byId.size !== records.length) throw new StructureStageInvalid('stage repeats an occurrence');
    const segments = new Map<string, number>();
    const order = new Map<string, OrderEntry>();
    const groups = new Map<string, OrderEntry>();
    // Authorization belongs to this seal request, not each use of the target.
    // Activation makes a fresh decision so revocation between requests is seen.
    const readableTargets = new Set<string>();
    for (const record of records) {
      checkOccurrenceRecord(record, 'book-composition');
      if (record.state !== 'active') continue;
      const chain = new Set([record.occurrence]);
      let parent = record.parent;
      while (parent !== stage.structure) {
        const owner = byId.get(parent);
        if (!owner || owner.state !== 'active' || owner.role !== 'group'
          || chain.has(parent) || chain.size > STRUCTURE_LIMITS.maxDepth) {
          throw new StructureStageInvalid('stage parent chain is unavailable or cyclic');
        }
        chain.add(parent);
        parent = owner.parent;
      }
      if (chain.size > deepestLevel(book, record.role)) {
        throw new StructureStageInvalid('stage nests deeper than a Book allows');
      }
      if (record.target && !readableTargets.has(record.target)) {
        if (!await input.canReadTarget(record.target)) throw new StructureStageUnavailable('staged target is undisclosed');
        readableTargets.add(record.target);
      }
      const segment = `${record.parent}\0${record.segmentKey}`;
      segments.set(segment, (segments.get(segment) ?? 0) + 1);
      const entry = { parent: record.parent, segmentKey: record.segmentKey!,
        orderKey: record.orderKey!, occurrence: record.occurrence };
      const key = orderTreeKey(entry);
      if (order.has(key)) throw new StructureStageInvalid('stage order position repeats');
      order.set(key, entry);
      if (record.role === 'group' && record.parent === stage.structure) groups.set(key, entry);
    }
    if ([...segments.values()].some(count => count > STRUCTURE_LIMITS.segmentMembers)) {
      throw new StructureStageInvalid('stage order segment exceeds its bound');
    }
    const cost = newCost();
    const recordRoot = await recordTree(this.objects).apply(await recordTree(this.objects).empty(cost),
      new Map(records.map(record => [recordTreeKey(record), record])), cost);
    const orderRoot = await orderTree(this.objects).apply(await orderTree(this.objects).empty(cost),
      order, cost);
    const groupRoot = await orderTree(this.objects).apply(await orderTree(this.objects).empty(cost),
      groups, cost);
    const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure: stage.structure,
      structureOf: input.mainVersion, profile: 'book-composition' as const,
      generation: stage.generation, pageFormat: STRUCTURE_PAGE_FORMAT,
      records: recordRoot, order: orderRoot, topGroups: groupRoot, placementCount: order.size, measures: [],
      ...(stage.sourceRef && stage.sourceRevision && stage.mappingPolicy
        ? { source: { ref: stage.sourceRef, revision: stage.sourceRevision,
          mappingPolicy: stage.mappingPolicy } } : {}),
      model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    checkStructureManifest(bytes);
    const digest = await this.objects.put(bytes);
    const result = await this.pool.query<StageRow>(`UPDATE structure.stage_job
      SET status = 'sealed', root_manifest = $7, placement_count = $8
      WHERE id = $1 AND principal_id = $2 AND structure = $3 AND status = 'staging'
        AND lease_holder = $4 AND lease_fence = $5
        AND lease_expires_at > clock_timestamp() AND deadline_at > clock_timestamp()
        AND staged_pages = $6
      RETURNING *`, [input.id, input.principalId, input.structure, input.holder,
      input.fence, stage.pages, digest, order.size]);
    if (!result.rows[0]) throw new StructureStageConflict('stage changed while sealing');
    return view(result.rows[0]);
  }

  async activate(id: string, principalId: string, structure: string,
    result: { receipt: string; dataEpoch: string; sequence: string; revision: string }):
    Promise<StructureStage> {
    const updated = await this.pool.query<StageRow>(`UPDATE structure.stage_job
      SET status = 'activated', graph_started = true, graph_receipt = $4,
        graph_data_epoch = $5, graph_sequence = $6, revision = $7,
        lease_holder = NULL, lease_expires_at = NULL, settled_at = clock_timestamp()
      WHERE id = $1 AND principal_id = $2 AND structure = $3
        AND status = 'sealed' AND graph_started
      RETURNING *`, [id, principalId, structure, result.receipt, result.dataEpoch,
      result.sequence, result.revision]);
    if (updated.rows[0]) return view(updated.rows[0]);
    const prior = await this.read(id, principalId, structure);
    if (prior.status === 'activated' && prior.graphReceipt === result.receipt) return prior;
    throw new StructureStageConflict('stage could not settle its graph receipt');
  }

  async beginActivation(id: string, principalId: string, structure: string): Promise<number> {
    const result = await this.pool.query(`UPDATE structure.stage_job SET graph_started = true
      WHERE id = $1 AND principal_id = $2 AND structure = $3 AND status = 'sealed' AND graph_started = false
        AND deadline_at > clock_timestamp() RETURNING id`, [id, principalId, structure]);
    if (result.rowCount) return 0;
    const prior = await this.read(id, principalId, structure);
    if (prior.status !== 'sealed' || !prior.graphStarted) {
      throw new StructureStageConflict('stage cannot start graph activation');
    }
    return prior.projectionBatches;
  }

  async advanceProjectionBatch(id: string, principalId: string, structure: string,
    previous: number): Promise<number> {
    if (!Number.isSafeInteger(previous) || previous < 0
      || previous >= STRUCTURE_LIMITS.stagePages) {
      throw new StructureStageConflict('stage projection checkpoint is invalid');
    }
    const result = await this.pool.query<StageRow>(`UPDATE structure.stage_job
      SET projection_batches = projection_batches + 1
      WHERE id = $1 AND principal_id = $2 AND structure = $3 AND status = 'sealed'
        AND graph_started AND projection_batches = $4 RETURNING *`,
    [id, principalId, structure, previous]);
    if (result.rows[0]) return view(result.rows[0]).projectionBatches;
    const prior = await this.read(id, principalId, structure);
    if (prior.status === 'sealed' && prior.graphStarted
      && prior.projectionBatches >= previous + 1) return prior.projectionBatches;
    throw new StructureStageConflict('stage projection checkpoint changed');
  }

  async fail(id: string, principalId: string, structure: string,
    result: { receipt: string; dataEpoch: string; sequence: string; reason: string }):
    Promise<StructureStage> {
    const updated = await this.pool.query<StageRow>(`UPDATE structure.stage_job
      SET status = 'failed', graph_receipt = $4, graph_data_epoch = $5,
        graph_sequence = $6, failure_reason = $7,
        lease_holder = NULL, lease_expires_at = NULL, settled_at = clock_timestamp()
      WHERE id = $1 AND principal_id = $2 AND structure = $3
        AND status = 'sealed' AND graph_started RETURNING *`,
    [id, principalId, structure, result.receipt, result.dataEpoch, result.sequence,
      result.reason.slice(0, 500)]);
    if (updated.rows[0]) return view(updated.rows[0]);
    const prior = await this.read(id, principalId, structure);
    if (prior.status === 'failed' && prior.graphReceipt === result.receipt) return prior;
    throw new StructureStageConflict('stage could not settle its failed graph receipt');
  }

  async cancel(id: string, principalId: string, structure: string,
    receipt?: { receipt: string; dataEpoch: string; sequence: string }): Promise<StructureStage> {
    const stage = await this.read(id, principalId, structure);
    if (stage.graphStarted && !receipt) {
      throw new StructureStageConflict('graph-started stage cancellation needs its graph receipt');
    }
    const result = await this.pool.query<StageRow>(`UPDATE structure.stage_job
      SET status = 'cancelled', lease_holder = NULL, lease_expires_at = NULL,
        graph_started = graph_started OR $4::boolean,
        graph_receipt = COALESCE(graph_receipt, $5), graph_data_epoch = COALESCE(graph_data_epoch, $6),
        graph_sequence = COALESCE(graph_sequence, $7), settled_at = clock_timestamp()
      WHERE id = $1 AND principal_id = $2 AND structure = $3
        AND status IN ('staging','sealed')
        AND (graph_started = false OR $4::boolean) RETURNING *`,
    [id, principalId, structure, Boolean(receipt), receipt?.receipt ?? null,
      receipt?.dataEpoch ?? null, receipt?.sequence ?? null]);
    if (result.rows[0]) return view(result.rows[0]);
    const prior = await this.read(id, principalId, structure);
    if (prior.status === 'cancelled') return prior;
    throw new StructureStageConflict('stage can no longer be cancelled');
  }
}
