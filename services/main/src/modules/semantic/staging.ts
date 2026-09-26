import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { ProfileId } from '../../infrastructure/profile.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { DATASET, GRAPHS, ID, PendingActivation, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { ModelGenerationChanged, modelGenerationHeadGuard, readActiveModelGeneration } from './generation-guard.ts';
import { STAGE_LIMITS, STAGE_PROFILE, type ChangeStageRow, type ChangeStagePageRow,
  type ChangeStageValidationRow, type ChangeStageOutcomeRow } from './stage-schema.ts';
import { checkedComponentState, ownedTriples, propertyRdf, referencedResources,
  valueValidations, type ComponentInput, type ComponentState } from './change.ts';
import { allocateNativeIri, checkedNativeIri, PROFILES } from './schema.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { referenceReader, SEMANTIC_WRITE_SCOPE, type SemanticAccess } from './admitted.ts';
import { cancelSemanticAdmission, ensureModelGeneration, familyReceiptIri, sealSemanticRejection,
  sealComponentState, SemanticChangeRejected, validationsFor, type SemanticAdmission,
  type SemanticTerminal } from './command.ts';

export const semanticStageCostContract = {
  variables: ['pages', 'items', 'pageBytes', 'totalBytes', 'assertions'],
  bound: 'Page normalization, immutable object checks and RDF preparation are O(items + assertions + totalBytes); activation checks O(pages) metadata and submits one bounded Jena update.',
  limits: STAGE_LIMITS,
  retry: 'Page rows are immutable and unique by stage/ordinal; retries must present the same digest and count.',
} as const;

export interface SemanticStageItem {
  target?: string;
  expectedHead: string | null;
  state: unknown;
}

export interface PreparedSemanticStagePage {
  ordinal: number;
  bytes: Uint8Array;
  digest: string;
  itemCount: number;
}

export class SemanticStageRejected extends Error {
  constructor(readonly reason: 'unsupported' | 'too-large' | 'nonconforming' | 'generation-changed') {
    super(`semantic import stage is ${reason}`);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Validate and canonicalize one bounded import page before Content owns its digest. */
export function prepareSemanticStagePage(ordinal: number, items: readonly SemanticStageItem[]): PreparedSemanticStagePage {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= STAGE_LIMITS.pages
    || !Array.isArray(items) || items.length < 1 || items.length > STAGE_LIMITS.itemsPerPage) {
    throw new SemanticStageRejected('too-large');
  }
  const targets = new Set<string>();
  const canonical = items.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key =>
      key !== 'target' && key !== 'expectedHead' && key !== 'state')
      || !Object.prototype.hasOwnProperty.call(item, 'expectedHead')) {
      throw new SemanticStageRejected('nonconforming');
    }
    try {
      if (item.target !== undefined) checkedNativeIri(item.target);
      if (item.expectedHead !== null) checkedNativeIri(item.expectedHead);
    } catch { throw new SemanticStageRejected('nonconforming'); }
    if (item.target === undefined && item.expectedHead !== null) {
      throw new SemanticStageRejected('nonconforming');
    }
    if (item.target) {
      if (targets.has(item.target)) throw new SemanticStageRejected('nonconforming');
      targets.add(item.target);
    }
    return { ...(item.target ? { target: item.target } : {}), expectedHead: item.expectedHead,
      state: checkedComponentState(item.state) };
  });
  const bytes = Buffer.from(JSON.stringify(stable({ profile: STAGE_PROFILE, items: canonical })));
  if (bytes.byteLength > STAGE_LIMITS.pageBytes) throw new SemanticStageRejected('too-large');
  return { ordinal, bytes, digest: sha256(bytes), itemCount: canonical.length };
}

export function prepareSemanticStagePages(items: readonly SemanticStageItem[]): {
  pages: PreparedSemanticStagePage[]; itemCount: number; byteCount: number;
} {
  if (items.length < 1 || items.length > STAGE_LIMITS.items) throw new SemanticStageRejected('too-large');
  const pages: PreparedSemanticStagePage[] = [];
  let byteCount = 0;
  for (let start = 0, ordinal = 0; start < items.length; start += STAGE_LIMITS.itemsPerPage, ordinal++) {
    const page = prepareSemanticStagePage(ordinal, items.slice(start, start + STAGE_LIMITS.itemsPerPage));
    byteCount += page.bytes.byteLength;
    if (byteCount > STAGE_LIMITS.totalBytes) throw new SemanticStageRejected('too-large');
    pages.push(page);
  }
  if (pages.length > STAGE_LIMITS.pages) throw new SemanticStageRejected('too-large');
  return { pages, itemCount: items.length, byteCount };
}

/**
 * Prove that every staged page is complete under the exact Content-captured model
 * generation and that the same immutable revision is still the Main head. Call
 * immediately before activation; the writer must also include this head guard in
 * its TDB2 update WHERE so a race after this read cannot activate stale data.
 */
export function checkedStageActivationBasis(stage: ChangeStageRow, pages: readonly ChangeStagePageRow[],
  validations: readonly ChangeStageValidationRow[], activeGeneration: string, requireValidation = true): {
    generation: string; headGuard: string;
  } {
  if (stage.profile !== STAGE_PROFILE || stage.validation_posture !== 'reject') {
    throw new SemanticStageRejected('unsupported');
  }
  if (!/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(stage.model_generation)
    || activeGeneration !== stage.model_generation) {
    throw new SemanticStageRejected('generation-changed');
  }
  if (pages.length !== stage.page_count || pages.some((page, ordinal) => page.ordinal !== ordinal
    || !/^[0-9a-f]{64}$/.test(page.page_digest) || page.byte_size < 1 || page.byte_size > STAGE_LIMITS.pageBytes
    || page.item_count < 1 || page.item_count > STAGE_LIMITS.itemsPerPage)) {
    throw new SemanticStageRejected('nonconforming');
  }
  const conforming = new Set(validations.filter(validation => validation.model_generation === stage.model_generation
    && validation.outcome === 'conforming').map(validation => validation.ordinal));
  if (requireValidation && (conforming.size !== stage.page_count || Array.from({ length: stage.page_count }, (_, ordinal) => ordinal)
    .some(ordinal => !conforming.has(ordinal)))) {
    throw new SemanticStageRejected('nonconforming');
  }
  return { generation: stage.model_generation, headGuard: modelGenerationHeadGuard(stage.model_generation) };
}

interface LoadedStage {
  stage: ChangeStageRow;
  pages: { row: ChangeStagePageRow; items: SemanticStageItem[] }[];
}

export class SemanticStageConflict extends Error {}
export class SemanticStageUnavailable extends Error {}
export class PendingSemanticBulkChange extends PendingAdmittedWork {
  constructor(admissionId: string) { super(admissionId, 'semantic-change-bulk'); }
}

const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function semanticBulkDigest(states: readonly ComponentInput[]): string {
  return hash(JSON.stringify({ family: 'semantic-change-bulk-v1', profile: STAGE_PROFILE,
    states: states.map(state => checkedComponentState(state)) }));
}

function pageItems(bytes: Uint8Array, ordinal: number, row: ChangeStagePageRow): SemanticStageItem[] {
  if (digestBytes(bytes) !== row.page_digest || bytes.byteLength !== row.byte_size) {
    throw new SemanticStageUnavailable('stored semantic stage page failed its digest or size check');
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new SemanticStageUnavailable('stored semantic stage page is not JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SemanticStageUnavailable('stored semantic stage page is not an object');
  }
  const page = value as { profile?: unknown; items?: unknown };
  if (page.profile !== STAGE_PROFILE || !Array.isArray(page.items) || page.items.length !== row.item_count) {
    throw new SemanticStageUnavailable('stored semantic stage page profile or count differs');
  }
  const checked = prepareSemanticStagePage(ordinal, page.items as SemanticStageItem[]);
  if (checked.digest !== row.page_digest || Buffer.compare(Buffer.from(checked.bytes), Buffer.from(bytes)) !== 0) {
    throw new SemanticStageUnavailable('stored semantic stage page is not canonical');
  }
  return page.items as SemanticStageItem[];
}

/** Content transaction plus immutable page objects. Rows become visible only after read-back. */
export class SemanticStageStore {
  constructor(private readonly pool: Pool, private readonly objects: ImmutableObjects) {}

  private async readByKey(principalId: string, key: string): Promise<ChangeStageRow | null> {
    const result = await this.pool.query<ChangeStageRow>(`SELECT * FROM semantic.change_stage
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key]);
    return result.rows[0] ?? null;
  }

  async loadByKey(principalId: string, key: string, requestDigest: string): Promise<LoadedStage | null> {
    const stage = await this.readByKey(principalId, key);
    if (!stage) return null;
    if (stage.request_digest !== requestDigest) throw new SemanticStageConflict('stage key binds another intent');
    return this.load(stage);
  }

  private async load(stage: ChangeStageRow): Promise<LoadedStage> {
    const rows = await this.pool.query<ChangeStagePageRow>(`SELECT * FROM semantic.change_stage_page
      WHERE stage_id = $1 ORDER BY ordinal`, [stage.id]);
    if (rows.rows.length !== stage.page_count || rows.rows.some((row, ordinal) => row.ordinal !== ordinal)) {
      throw new SemanticStageUnavailable('semantic stage page ledger is incomplete');
    }
    const pages = [];
    let total = 0;
    let items = 0;
    const targets = new Set<string>();
    for (const row of rows.rows) {
      const bytes = await this.objects.get(row.page_digest);
      const page = pageItems(bytes, row.ordinal, row);
      for (const item of page) {
        if (item.target) {
          if (targets.has(item.target)) throw new SemanticStageUnavailable('semantic stage repeats a target');
          targets.add(item.target);
        }
      }
      total += bytes.byteLength;
      items += page.length;
      pages.push({ row, items: page });
    }
    const manifestDigest = hash(JSON.stringify({ profile: STAGE_PROFILE,
      pages: rows.rows.map(row => [row.ordinal, row.page_digest, row.item_count, row.byte_size]) }));
    if (total !== Number(stage.byte_count) || items !== Number(stage.item_count)
      || total > STAGE_LIMITS.totalBytes || items > STAGE_LIMITS.items
      || manifestDigest !== stage.manifest_digest) {
      throw new SemanticStageUnavailable('semantic stage manifest counts differ');
    }
    return { stage, pages };
  }

  async create(input: { admission: SemanticAdmission; principalId: string; actingSubject: string;
    idempotencyKey: string; requestDigest: string; generation: string;
    pages: readonly PreparedSemanticStagePage[]; itemCount: number }): Promise<LoadedStage> {
    const existing = await this.loadByKey(input.principalId, input.idempotencyKey, input.requestDigest);
    if (existing) {
      if (existing.stage.admission_id !== input.admission.id) {
        throw new SemanticStageConflict('stage admission differs from its Access key');
      }
      return existing;
    }
    if (!/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(input.generation)
      || input.pages.length < 1 || input.pages.length > STAGE_LIMITS.pages
      || input.itemCount < 1 || input.itemCount > STAGE_LIMITS.items) {
      throw new SemanticStageRejected('too-large');
    }
    const pages = [];
    let totalBytes = 0;
    for (const page of input.pages) {
      if (page.ordinal !== pages.length || page.itemCount < 1 || page.itemCount > STAGE_LIMITS.itemsPerPage
        || page.bytes.byteLength < 1 || page.bytes.byteLength > STAGE_LIMITS.pageBytes
        || digestBytes(page.bytes) !== page.digest) throw new SemanticStageRejected('nonconforming');
      totalBytes += page.bytes.byteLength;
      if (totalBytes > STAGE_LIMITS.totalBytes) throw new SemanticStageRejected('too-large');
      const stored = await this.objects.put(page.bytes);
      if (stored !== page.digest) throw new SemanticStageUnavailable('immutable page store returned another digest');
      const readback = await this.objects.get(page.digest);
      if (Buffer.compare(Buffer.from(page.bytes), Buffer.from(readback)) !== 0
        || digestBytes(readback) !== page.digest) {
        throw new SemanticStageUnavailable('immutable page read-back differs');
      }
      pages.push({ ...page, bytes: readback });
    }
    if (pages.reduce((sum, page) => sum + page.itemCount, 0) !== input.itemCount) {
      throw new SemanticStageRejected('nonconforming');
    }
    const manifestDigest = hash(JSON.stringify({ profile: STAGE_PROFILE,
      pages: pages.map(page => [page.ordinal, page.digest, page.itemCount, page.bytes.byteLength]) }));
    const stageId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query(`INSERT INTO semantic.change_stage
        (id, admission_id, principal_id, acting_subject, idempotency_key, request_digest, profile,
         model_generation, validation_posture, manifest_digest, page_count, item_count, byte_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reject',$9,$10,$11,$12)`,
      [stageId, input.admission.id, input.principalId, input.actingSubject, input.idempotencyKey,
        input.requestDigest, STAGE_PROFILE, input.generation, manifestDigest, pages.length,
        input.itemCount, totalBytes]);
      for (const page of pages) {
        await client.query(`INSERT INTO semantic.change_stage_page
          (stage_id, ordinal, page_digest, item_count, byte_size) VALUES ($1,$2,$3,$4,$5)`,
        [stageId, page.ordinal, page.digest, page.itemCount, page.bytes.byteLength]);
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* keep the primary error */ }
      if ((error as { code?: string }).code !== '23505') throw error;
      const winner = await this.loadByKey(input.principalId, input.idempotencyKey, input.requestDigest);
      if (!winner || winner.stage.admission_id !== input.admission.id) {
        throw new SemanticStageConflict('concurrent stage admission differs');
      }
      return winner;
    } finally { client.release(); }
    const created = await this.readByKey(input.principalId, input.idempotencyKey);
    if (!created) throw new SemanticStageUnavailable('Content stage was not readable after creation');
    return this.load(created);
  }

  async settle(stageId: string, principalId: string, outcome: {
    outcome: 'activated' | 'rejected'; reason?: 'nonconforming' | 'unsupported' | 'generation-changed'
      | 'stale-head' | 'denied'; modelGeneration: string; graphReceipt?: string; dataEpoch?: string; sequence?: string;
    }, validation: 'conforming' | 'nonconforming', reportDigest?: string): Promise<ChangeStageOutcomeRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stageResult = await client.query<ChangeStageRow>(`SELECT * FROM semantic.change_stage
        WHERE id = $1 AND principal_id = $2 FOR UPDATE`, [stageId, principalId]);
      const stage = stageResult.rows[0];
      if (!stage) throw new SemanticStageUnavailable('stage is unavailable');
      const prior = await client.query<ChangeStageOutcomeRow>(
        'SELECT * FROM semantic.change_stage_outcome WHERE stage_id = $1', [stageId]);
      if (prior.rows[0]) {
        if (prior.rows[0].outcome !== outcome.outcome || prior.rows[0].model_generation !== outcome.modelGeneration
          || prior.rows[0].graph_receipt !== (outcome.graphReceipt ?? null)) {
          throw new SemanticStageConflict('stage already has another terminal outcome');
        }
        await client.query('COMMIT');
        return prior.rows[0];
      }
      if (outcome.modelGeneration !== stage.model_generation) {
        throw new SemanticStageConflict('settlement generation differs from staged generation');
      }
      for (let ordinal = 0; ordinal < stage.page_count; ordinal++) {
        await client.query(`INSERT INTO semantic.change_stage_validation
          (stage_id, ordinal, model_generation, outcome, report_digest)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [stageId, ordinal, outcome.modelGeneration, validation,
          validation === 'conforming' ? null : reportDigest ?? hash(`${stageId}\0${ordinal}\0${outcome.reason ?? 'nonconforming'}`)]);
      }
      const insert = await client.query<ChangeStageOutcomeRow>(`INSERT INTO semantic.change_stage_outcome
        (stage_id, outcome, reason, model_generation, graph_receipt, data_epoch, sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [stageId, outcome.outcome, outcome.reason ?? null,
        outcome.modelGeneration, outcome.graphReceipt ?? null, outcome.dataEpoch ?? null, outcome.sequence ?? null]);
      await client.query('COMMIT');
      return insert.rows[0]!;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* keep the primary error */ }
      throw error;
    } finally { client.release(); }
  }
}

interface BulkTerminal extends SemanticTerminal {
  generation?: string;
  manifestDigest?: string;
  itemCount?: number;
  items?: { component: string; revision: string }[];
}

async function readBulkTerminal(env: WorkActivationEnvironment, receipt: string): Promise<BulkTerminal | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?kind ?digest ?admission
    ?authority ?scope ?sequence ?epoch ?generation ?count ?manifestDigest ?ordinal ?component ?revision WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
      rv:admissionId ?admission ; rv:authorityEpoch ?authority ; rv:admittedScope ?scope ;
      rv:sequence ?sequence ; rv:dataEpoch ?epoch .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:rejectionKind ?kind }
      OPTIONAL { ${iri(receipt)} rv:bulkGeneration ?generation ; rv:bulkCount ?count ; rv:bulkManifestDigest ?manifestDigest }
    }
    OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:bulkItem ?item }
      GRAPH ${iri(GRAPHS.revisions)} { ?item rv:ordinal ?ordinal ; rv:component ?component ; rv:revision ?revision } }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length < 1 || rows.some(entry => !entry.outcome || entry.outcome.value !== row?.outcome?.value
    || entry.digest?.value !== row?.digest?.value || entry.admission?.value !== row?.admission?.value
    || entry.authority?.value !== row?.authority?.value || entry.scope?.value !== row?.scope?.value
    || entry.sequence?.value !== row?.sequence?.value || entry.epoch?.value !== row?.epoch?.value
    || entry.manifestDigest?.value !== row?.manifestDigest?.value)
    || !row?.outcome || !row.digest || !row.admission || !row.authority
    || !row.scope || !row.sequence || !row.epoch) throw new Error('semantic bulk receipt is incomplete');
  if (row.outcome.value === `${RV}Succeeded`) {
    if (!row.generation || !row.count || !/^[1-9][0-9]*$/.test(row.count.value)
      || Number(row.count.value) > STAGE_LIMITS.items || !row.manifestDigest
      || !/^[0-9a-f]{64}$/.test(row.manifestDigest.value)) throw new Error('semantic bulk receipt lacks its manifest');
    const ordered = rows.map(entry => ({ ordinal: Number(entry.ordinal?.value),
      component: entry.component?.value, revision: entry.revision?.value }))
      .filter(entry => Number.isInteger(entry.ordinal) && entry.component && entry.revision)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (ordered.length !== Number(row.count.value) || ordered.some((item, ordinal) => item.ordinal !== ordinal
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(item.component!)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(item.revision!))) {
      throw new Error('semantic bulk receipt item manifest is incomplete');
    }
    return { outcome: 'succeeded', receipt, admissionId: row.admission.value, requestDigest: row.digest.value,
      authorityEpoch: row.authority.value, scope: row.scope.value, dataEpoch: row.epoch.value,
      sequence: row.sequence.value, generation: row.generation.value, manifestDigest: row.manifestDigest.value,
      itemCount: Number(row.count.value),
      items: ordered.map(({ component, revision }) => ({ component: component!, revision: revision! })) };
  }
  if (row.outcome.value !== `${RV}Cancelled`) throw new Error('semantic bulk receipt has unknown outcome');
  return { outcome: 'cancelled', ...(row.kind?.value === `${RV}InvalidProfile` ? { reason: 'invalid-profile' as const }
    : row.reason?.value === `${RV}GenerationChanged` ? { reason: 'generation-changed' as const }
      : row.reason?.value === `${RV}StaleHead` ? { reason: 'stale-head' as const }
        : row.reason?.value === `${RV}UnavailableReference` ? { reason: 'unavailable-reference' as const } : {}),
    receipt, admissionId: row.admission.value, requestDigest: row.digest.value,
    authorityEpoch: row.authority.value, scope: row.scope.value, dataEpoch: row.epoch.value,
    sequence: row.sequence.value };
}

function proof(terminal: SemanticTerminal): GraphTerminalProof {
  return { outcome: terminal.outcome, receipt: terminal.receipt, admissionId: terminal.admissionId,
    requestDigest: terminal.requestDigest, authorityEpoch: terminal.authorityEpoch,
    scope: terminal.scope, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
}

function bulkResult(terminal: BulkTerminal, stage: ChangeStageRow, replayed: boolean) {
  if (terminal.outcome !== 'succeeded') {
    if (terminal.reason === 'generation-changed') throw new ModelGenerationChanged('model generation changed after semantic staging');
    if (terminal.reason === 'invalid-profile') throw new CommandRejected({ status: 'invalid' });
    if (terminal.reason === 'stale-head') throw new SemanticStageRejected('nonconforming');
    throw new PendingActivation('semantic bulk admission was cancelled');
  }
  if (terminal.generation !== stage.model_generation || terminal.manifestDigest !== stage.manifest_digest
    || terminal.itemCount !== Number(stage.item_count)) {
    throw new SemanticStageConflict('graph receipt differs from the Content stage');
  }
  return { profile: STAGE_PROFILE, stageId: stage.id, modelGeneration: stage.model_generation,
    receipt: terminal.receipt, sourcePosition: { datasetId: 'product' as const,
      dataEpoch: terminal.dataEpoch, sequence: terminal.sequence }, itemCount: terminal.itemCount,
    items: terminal.items ?? [], replayed };
}

interface PreparedBulkItem {
  target: string; state: ComponentInput; stored: ComponentState; manifest: string;
  revision: string; operation: string; triples: string[]; anchor: string; rdf: ReturnType<typeof propertyRdf>['rdf'];
}

async function prepareItems(env: WorkActivationEnvironment, pages: LoadedStage['pages'], generation: string) {
  const output: PreparedBulkItem[] = [];
  const profileEntries = new Map<ProfileId, Map<string, string[]>>();
  const operation = `${ID}${Bun.randomUUIDv7()}`;
  for (const page of pages) for (const item of page.items) {
    const state = checkedComponentState(item.state);
    if (!item.target || item.expectedHead !== null) throw new SemanticStageRejected('unsupported');
    const target = checkedNativeIri(item.target);
    const revision = `${ID}${Bun.randomUUIDv7()}`;
    const { stored, rdf } = state.component === 'resource'
      ? propertyRdf(state.properties, []) : { stored: [], rdf: [] };
    const exact: ComponentState = state.component === 'resource' ? { ...state, properties: stored } : state;
    const profile: ProfileId = state.component === 'resource' ? 'semantic-resource-v1' : 'semantic-definition-v1';
    const profileIri = state.component === 'resource' ? PROFILES.resource : PROFILES.definition;
    const manifest = await sealComponentState(env, target, profileIri, exact);
    const triples = ownedTriples(target, exact, revision);
    const revisionType = state.component === 'resource' ? 'SemanticRevision' : 'DefinitionRevision';
    const anchor = `${iri(revision)} a rv:${revisionType}, rv:RevisionAnchor ; rv:component ${iri(target)} ;
      ${state.component === 'definition' ? `rv:definitionKind ${iri(`https://rezics.com/vocab/${state.kind[0]!.toUpperCase()}${state.kind.slice(1)}Definition`)} ;` : ''}
      rv:lifecycle rv:${state.lifecycle === 'active' ? 'Active' : 'Retired'} ; rv:operation ${iri(operation)} ;
      rv:manifest ${iri(manifest)} ; rv:modelGeneration ${iri(generation)} ;
      rv:modelRevision ${iri(profileIri)} ; rv:shapeRevision ${iri(profileIri)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      ${rdf.flatMap(value => value.node ? value.node.triples.map(triple => `${triple} .`) : []).join('\n')}`;
    const entries = profileEntries.get(profile) ?? new Map<string, string[]>();
    const role = state.component === 'resource' ? 'resource' : 'definition';
    entries.set(role, [...entries.get(role) ?? [], target]);
    entries.set('revision', [...entries.get('revision') ?? [], revision]);
    profileEntries.set(profile, entries);
    output.push({ target, state, stored: exact, manifest, revision, operation, triples, anchor, rdf });
  }
  const validations = [];
  for (const [profile, roles] of profileEntries) {
    validations.push(...await validationsFor(env, profile, [...roles].map(([role, focus]) => ({ role, focus }))));
  }
  for (const item of output) {
    if (item.state.component === 'resource') {
      validations.push(...await valueValidations(env, item.rdf));
    }
  }
  return { items: output, validations, operation };
}

function createBulkUpdate(env: WorkActivationEnvironment, admission: SemanticAdmission, receipt: string,
  digest: string, generation: string, manifestDigest: string, prepared: Awaited<ReturnType<typeof prepareItems>>) {
  const itemLinks = prepared.items.map((item, ordinal) => {
    const link = `urn:rezics:semantic-bulk-item:${hash(`${receipt}\0${ordinal}`)}`;
    return `${iri(receipt)} rv:bulkItem ${iri(link)} .`;
  }).join('\n');
  const itemRecords = prepared.items.map((item, ordinal) => {
    const link = `urn:rezics:semantic-bulk-item:${hash(`${receipt}\0${ordinal}`)}`;
    return `${iri(link)} a rv:SemanticBulkItem ; rv:ordinal ${ordinal} ;
      rv:component ${iri(item.target)} ; rv:revision ${iri(item.revision)} .`;
  }).join('\n');
  const inserts = prepared.items.map(item => `GRAPH ${iri(GRAPHS.current)} {
      ${item.triples.map(triple => `${iri(item.target)} ${triple} .`).join('\n')} }
    GRAPH ${iri(GRAPHS.revisions)} { ${item.anchor} }`).join('\n');
  const absent = prepared.items.map(item => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(item.target)} ?targetP ?targetO } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(item.revision)} ?revisionP ?revisionO } }`).join('\n');
  const refs = [...new Set(prepared.items.flatMap(item => referencedResources(item.state)))];
  return `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      ${inserts}
      GRAPH ${iri(GRAPHS.revisions)} { ${itemRecords} }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Succeeded ; rv:operation ${iri(prepared.operation)} ;
        rv:bulkGeneration ${iri(generation)} ; rv:bulkCount ${prepared.items.length} ;
        rv:bulkManifestDigest ${lit(manifestDigest)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${itemLinks} }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
        rv:event ${iri(`urn:rezics:event:${hash(`${receipt}\0semantic-bulk`)}`)} .
        ${iri(`urn:rezics:event:${hash(`${receipt}\0semantic-bulk`)}`)} a rv:SemanticBulkChangedEvent ;
          rv:ordinal 0 ; rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} . }
    }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      ${modelGenerationHeadGuard(generation)} ${absent}
      ${refs.map(ref => `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(ref)} a ?refType } }`).join('\n')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?receiptP ?receiptO } }
      BIND(?n + 1 AS ?next) }`;
}

async function activate(env: WorkActivationEnvironment, access: Pick<AccessAdmissionRegistry, 'recordGraphOutcome'>,
  admission: SemanticAdmission, loaded: LoadedStage): Promise<BulkTerminal> {
  const receipt = familyReceiptIri(admission.id, 'semantic-change-bulk');
  const before = await readBulkTerminal(env, receipt);
  if (before) {
    await access.recordGraphOutcome(admission.id, proof(before));
    return before;
  }
  const active = await readActiveModelGeneration(env.fuseki);
  if (active.generation !== loaded.stage.model_generation) {
    const terminal = await sealSemanticRejection(env, receipt, admission.requestDigest, admission,
      'generation-changed', `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri('urn:rezics:model:product')} rv:generationHead ${iri(loaded.stage.model_generation)} } }`);
    if (!terminal) throw new PendingSemanticBulkChange(admission.id);
    await access.recordGraphOutcome(admission.id, proof(terminal));
    return terminal as BulkTerminal;
  }
  checkedStageActivationBasis(loaded.stage, loaded.pages.map(page => page.row), [], active.generation, false);
  const prepared = await prepareItems(env, loaded.pages, loaded.stage.model_generation);
  if ((await readActiveModelGeneration(env.fuseki)).generation !== loaded.stage.model_generation) {
    const rejected = await sealSemanticRejection(env, receipt, admission.requestDigest, admission,
      'generation-changed', `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri('urn:rezics:model:product')} rv:generationHead ${iri(loaded.stage.model_generation)} } }`);
    if (rejected) {
      await access.recordGraphOutcome(admission.id, proof(rejected));
      return rejected as BulkTerminal;
    }
  }
  const update = createBulkUpdate(env, admission, receipt, admission.requestDigest,
    loaded.stage.model_generation, loaded.stage.manifest_digest, prepared);
  try {
    const result = await validatedCommand(env, { receipt, digest: admission.requestDigest, update,
      validations: prepared.validations, deadlineMs: 10_000 }, admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  } catch (error) { if (error instanceof CommandRejected) { /* invalid receipt is terminal and read below */ }
    else { /* ambiguous Jena response is resolved from the same graph receipt */ } }
  let terminal = await readBulkTerminal(env, receipt);
  if (!terminal) {
    const rejected = await sealSemanticRejection(env, receipt, admission.requestDigest, admission,
      'generation-changed', `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri('urn:rezics:model:product')} rv:generationHead ${iri(loaded.stage.model_generation)} } }`);
    terminal = rejected as BulkTerminal | null;
  }
  if (!terminal) throw new PendingSemanticBulkChange(admission.id);
  await access.recordGraphOutcome(admission.id, proof(terminal));
  return terminal;
}

/** Access admission, Content page stage/read-back, exact-generation validation and one atomic Jena activation. */
export async function admittedSemanticBulkChange(input: {
  env: WorkActivationEnvironment; account: Pick<AccountAssertionVerifier, 'verify'>; access: SemanticAccess;
  store: SemanticStageStore; request: Request; actingSubject: string; idempotencyKey: string; states: unknown[];
}) {
  await assertGraphAdmissionOpen(input.env.fuseki, input.env.lineage);
  const principal = await input.account.verify(input.request, [SEMANTIC_WRITE_SCOPE]);
  const states = input.states.map(state => checkedComponentState(state));
  if (states.length < 1 || states.length > STAGE_LIMITS.items) throw new SemanticStageRejected('too-large');
  const preparedPages = prepareSemanticStagePages(states.map(state => ({ target: allocateNativeIri(),
    expectedHead: null, state })));
  const digest = semanticBulkDigest(states);
  const readable = referenceReader(input.access, principal, input.actingSubject);
  const refs = [...new Set(states.flatMap(referencedResources))];
  for (const ref of refs) if (!await readable(ref)) {
    throw new SemanticChangeRejected('unavailable-reference', 'a referenced resource is unavailable');
  }
  const registered = await input.access.register({ principal, actingSubject: input.actingSubject,
    scope: 'semantic:create:root', action: 'semantic.change.bulk', idempotencyKey: input.idempotencyKey,
    requestDigest: digest });
  const receipt = familyReceiptIri(registered.id, 'semantic-change-bulk');
  let admission: RegisteredAdmission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await input.access.claim(registered.id, digest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  const semanticAdmission: SemanticAdmission = admission;
  let loaded = await input.store.loadByKey(registered.principalId, input.idempotencyKey, digest);
  if (admission.state === 'sealed') {
    const terminal = await readBulkTerminal(input.env, receipt);
    if (!terminal) throw new PendingSemanticBulkChange(registered.id);
    await input.access.recordGraphOutcome(registered.id, proof(terminal));
    if (loaded && !await input.env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome rv:Succeeded } }`).then(answer => answer.boolean === true)) {
      await input.store.settle(loaded.stage.id, registered.principalId, { outcome: 'rejected',
        reason: terminal.reason === 'generation-changed' ? 'generation-changed' : 'nonconforming',
        modelGeneration: loaded.stage.model_generation, graphReceipt: terminal.receipt,
        dataEpoch: terminal.dataEpoch, sequence: terminal.sequence }, 'nonconforming');
    } else if (loaded) {
      await input.store.settle(loaded.stage.id, registered.principalId, { outcome: 'activated',
        modelGeneration: loaded.stage.model_generation, graphReceipt: terminal.receipt,
        dataEpoch: terminal.dataEpoch, sequence: terminal.sequence }, 'conforming');
    }
    if (loaded) return bulkResult(terminal, loaded.stage, true);
    throw new PendingSemanticBulkChange(registered.id);
  }
  if (!admission.dispatchEligible || admission.state === 'registered') {
    await cancelSemanticAdmission(input.env, receipt, admission);
    const terminal = await readBulkTerminal(input.env, receipt);
    if (!terminal) throw new PendingSemanticBulkChange(registered.id);
    await input.access.recordGraphOutcome(registered.id, proof(terminal));
    throw new PendingActivation('semantic bulk admission was cancelled');
  }
  if (!loaded) {
    await ensureModelGeneration(input.env);
    const generation = (await readActiveModelGeneration(input.env.fuseki)).generation;
    loaded = await input.store.create({ admission: semanticAdmission, principalId: registered.principalId,
      actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey, requestDigest: digest,
      generation, pages: preparedPages.pages, itemCount: preparedPages.itemCount });
  }
  if (loaded.stage.admission_id !== registered.id || loaded.stage.acting_subject !== input.actingSubject) {
    throw new SemanticStageConflict('Content stage differs from its admission');
  }
  const terminal = await activate(input.env, input.access, semanticAdmission, loaded);
  if (terminal.outcome === 'succeeded') {
    await input.store.settle(loaded.stage.id, registered.principalId, { outcome: 'activated',
      modelGeneration: loaded.stage.model_generation, graphReceipt: terminal.receipt,
      dataEpoch: terminal.dataEpoch, sequence: terminal.sequence }, 'conforming');
  } else {
    await input.store.settle(loaded.stage.id, registered.principalId, { outcome: 'rejected',
      reason: terminal.reason === 'generation-changed' ? 'generation-changed'
        : terminal.reason === 'stale-head' ? 'stale-head' : 'nonconforming',
      modelGeneration: loaded.stage.model_generation, graphReceipt: terminal.receipt,
      dataEpoch: terminal.dataEpoch, sequence: terminal.sequence }, 'nonconforming');
  }
  return bulkResult(terminal, loaded.stage, false);
}
