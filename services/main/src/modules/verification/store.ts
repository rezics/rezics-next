// Content-DB owner adapter for the `verification` schema. Every mutation is one
// local transaction: domain rows, the owner-local receipt and (through triggers)
// the exact head and invalidation work commit together. SQL stays here.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LINEAGE_BUDGET, LINEAGE_EDGE_BUDGET, type LineageLink, type LineageProof } from './analysis.ts';
import { verificationLimits } from './schema.ts';
import {
  ASSESSMENT_PRODUCER_COST,
  type AssessmentProducerPermit,
  type AssessmentProducerAuditFrontier,
  type AssessmentProducerAuditEntry,
  type AssessmentProducerAuditPage,
  type AssessmentProducerOriginalLookup,
  type AssessmentProducerRecord,
  type AssessmentProducerStage,
  type AssessmentProducerTerminal,
  type StagedAssessmentProducer,
} from './assessment-producer.ts';
export type {
  AssessmentProducerPermit,
  AssessmentProducerAuditFrontier,
  AssessmentProducerAuditEntry,
  AssessmentProducerAuditPage,
  AssessmentProducerOriginalLookup,
  AssessmentProducerRecord,
  AssessmentProducerStage,
  AssessmentProducerTerminal,
  StagedAssessmentProducer,
} from './assessment-producer.ts';

export class VerificationInvalid extends Error {}
export class VerificationConflict extends Error {}
export class VerificationStale extends Error {}
export class VerificationMissing extends Error {}
export class VerificationDenied extends Error {}
export class VerificationUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = 'https://rezics.com/id/';
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
export const nativeId = (uuid: string) => `${ID}${uuid}`;
export const uuidOf = (value: string) => value.startsWith(ID) && UUID.test(value.slice(ID.length))
  ? value.slice(ID.length) : null;
const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MIN_UUID = '00000000-0000-0000-0000-000000000000';
// Native PostgreSQL top-level transaction snapshot, not a domain fingerprint.
const nativeSnapshot = (value: string) => {
  const [_xmin, xmax, active] = value.split(':');
  return { xmax: BigInt(xmax!), active: (active ? active.split(',') : []) };
};
const snapshotVisible = (xid: string, snapshot: ReturnType<typeof nativeSnapshot>) =>
  BigInt(xid) < snapshot.xmax && !snapshot.active.includes(xid);
const iso = (value: Date | string) => new Date(value).toISOString();

interface PgError { code?: string; constraint?: string }
const pg = (error: unknown) => error as PgError;
const verificationError = (error: unknown): unknown => {
  const code = pg(error).code;
  if (code === '23503')
    return new VerificationMissing('referenced evidence or claim record is unavailable');
  if (code === '23514' || code === '22P02' || code === '23502') {
    return pg(error).constraint === 'challenge_independent_resolution'
      ? new VerificationDenied('a submitter cannot resolve its own challenge')
      : new VerificationInvalid(String((error as Error).message));
  }
  return error;
};

interface AssessmentProducerRow {
  admission_id: string;
  request_digest: string;
  principal_id: string;
  acting_subject: string;
  scope: string;
  authority_epoch: string;
  idempotency_key: string;
  claim: string;
  claim_revision: string;
  intent_json: string;
  stage_generation: string;
  restore_epoch: string;
  terminal: AssessmentProducerTerminal | null;
}
const producerColumns = `admission_id, request_digest, principal_id, acting_subject, scope, authority_epoch,
  idempotency_key, claim, claim_revision, intent_json, stage_generation::text, restore_epoch::text, terminal`;
const producerRecord = (row: AssessmentProducerRow): AssessmentProducerRecord => {
  try {
    const record = {
      admission: row.admission_id,
      requestDigest: row.request_digest,
      principal: row.principal_id,
      actingSubject: row.acting_subject,
      scope: row.scope,
      authorityEpoch: row.authority_epoch,
      idempotencyKey: row.idempotency_key,
      claim: row.claim,
      claimRevision: row.claim_revision,
      intent: JSON.parse(row.intent_json),
      stageGeneration: row.stage_generation,
      restoreEpoch: row.restore_epoch,
      terminal: row.terminal,
    };
    checkProducerStage(record);
    if (record.terminal) checkProducerTerminal(record.admission, record.terminal);
    return record;
  } catch {
    throw new VerificationUnavailable('stored assessment producer intent or terminal is invalid');
  }
};
const nonnegative = (value: string) => /^(0|[1-9][0-9]*)$/.test(value);
/** A stored producer whose generation and terminal also pass the audit checks. */
function checkedProducer(row: AssessmentProducerRow): AssessmentProducerRecord {
  const producer = producerRecord(row);
  if (
    typeof producer.stageGeneration !== 'string' ||
    !nonnegative(producer.stageGeneration) ||
    typeof producer.restoreEpoch !== 'string' ||
    !nonnegative(producer.restoreEpoch)
  ) {
    throw new VerificationUnavailable('stored assessment producer generation is invalid');
  }
  if (producer.terminal !== null) checkProducerTerminal(producer.admission, producer.terminal);
  return producer;
}
const producerJob = (value: string) => /^[A-Za-z0-9:_-]{1,128}$/.test(value);
// Compare replay values independently of property order, without changing
// arrays or lexical values. The retained text separately preserves digest order.
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

// These are the existing assessment digest's only unordered/optional inputs.
// Normalize comparison copies; the original serialized intent stays untouched.
const producerReplayValue = (input: AssessmentProducerStage) => ({
  ...input,
  intent: {
    ...input.intent,
    evaluationReference: input.intent.evaluationReference ?? null,
    sourceAssessments: [...input.intent.sourceAssessments].sort(),
    resolvesChallenges: [...input.intent.resolvesChallenges].sort(),
  },
});

function checkProducerStage(input: AssessmentProducerStage) {
  const intent = input.intent;
  const native = (value: unknown) => typeof value === 'string' && uuidOf(value) !== null;
  const reference = (value: unknown) =>
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 300 &&
    /^(?:https:\/\/[^/]+(?:\/[^\s<>"{}|\\^`]+)?|urn:[^\s<>"{}|\\^`]+)$/.test(value);
  const nullableReference = (value: unknown) => value === null || reference(value);
  const keys = [
    'claimRevision',
    'evidenceSetRevision',
    'sourceAssessments',
    'method',
    'judgment',
    'evaluationContext',
    'adoptedRevision',
    'scorePerMillion',
    'calibration',
    'evaluationReference',
    'limitations',
    'expectedSummary',
    'resolvesChallenges',
    'actingSubject',
  ];
  if (
    !UUID.test(input.admission) ||
    !UUID.test(input.principal) ||
    !/^[0-9a-f]{64}$/.test(input.requestDigest) ||
    !native(input.actingSubject) ||
    !native(input.claim) ||
    !native(input.claimRevision) ||
    input.scope !== 'verification:assess:global' ||
    typeof input.authorityEpoch !== 'string' ||
    !input.authorityEpoch ||
    input.authorityEpoch.length > 300 ||
    !KEY.test(input.idempotencyKey) ||
    !intent ||
    typeof intent !== 'object' ||
    Array.isArray(intent) ||
    Object.keys(intent).some((key) => !keys.includes(key)) ||
    Buffer.byteLength(JSON.stringify(intent), 'utf8') > ASSESSMENT_PRODUCER_COST.intentBytes ||
    intent.claimRevision !== input.claimRevision ||
    intent.actingSubject !== input.actingSubject ||
    !Array.isArray(intent.sourceAssessments) ||
    intent.sourceAssessments.length > verificationLimits.sourceAssessments ||
    new Set(intent.sourceAssessments).size !== intent.sourceAssessments.length ||
    intent.sourceAssessments.some((item) => !native(item)) ||
    !Array.isArray(intent.resolvesChallenges) ||
    intent.resolvesChallenges.length > ASSESSMENT_PRODUCER_COST.challenges ||
    new Set(intent.resolvesChallenges).size !== intent.resolvesChallenges.length ||
    intent.resolvesChallenges.some((item) => typeof item !== 'string' || !UUID.test(item)) ||
    !native(intent.evidenceSetRevision) ||
    !reference(intent.evaluationContext) ||
    !nullableReference(intent.adoptedRevision) ||
    !nullableReference(intent.calibration) ||
    (intent.evaluationReference !== undefined && !nullableReference(intent.evaluationReference)) ||
    !['automated', 'human-review'].includes(intent.method) ||
    (intent.method === 'human-review'
      ? !['supported', 'contradicted', 'material-conflict', 'insufficient'].includes(
          intent.judgment!,
        )
      : intent.judgment !== null) ||
    (intent.scorePerMillion !== null &&
      (!Number.isInteger(intent.scorePerMillion) ||
        intent.scorePerMillion < 0 ||
        intent.scorePerMillion > 1_000_000)) ||
    (intent.calibration !== null && intent.scorePerMillion === null) ||
    (intent.expectedSummary !== null && !native(intent.expectedSummary)) ||
    typeof intent.limitations !== 'string' ||
    !intent.limitations.trim() ||
    intent.limitations.length > 2000
  ) {
    throw new VerificationInvalid('assessment producer needs the bounded original admitted intent');
  }
}

function checkProducerTerminal(admission: string, terminal: AssessmentProducerTerminal) {
  const receipt = `urn:rezics:receipt:${createHash('sha256').update(`${admission}\0claim-assess`).digest('hex')}`;
  const activation = terminal?.activation;
  const exactKeys = (value: object, keys: readonly string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  const native = (value: unknown) => typeof value === 'string' && uuidOf(value) !== null;
  const kinds = [
    'claim',
    'evidence-set',
    'source-assessment',
    'source-observation',
    'source-disposition',
    'challenge',
    'policy',
    'rule',
    'acceptance',
    'adopted-revision',
    'lineage-walk',
  ];
  let validActivation = false;
  if (activation && typeof activation === 'object' && !Array.isArray(activation)) {
    if (activation.status === 'activated' || activation.status === 'replayed') {
      validActivation =
        exactKeys(activation, ['status', 'generation', 'number', 'dispute']) &&
        native(activation.generation) &&
        typeof activation.number === 'string' &&
        /^[1-9][0-9]*$/.test(activation.number) &&
        ['none', 'challenge-pending', 'disputed', 'resolved'].includes(activation.dispute);
    } else if (activation.status === 'stale-summary') {
      validActivation =
        exactKeys(activation, ['status', 'active']) &&
        (activation.active === null || native(activation.active));
    } else if (activation.status === 'stale-dependency') {
      validActivation =
        exactKeys(activation, ['status', 'kinds']) &&
        Array.isArray(activation.kinds) &&
        activation.kinds.length > 0 &&
        activation.kinds.length <= verificationLimits.summaryDependencies &&
        new Set(activation.kinds).size === activation.kinds.length &&
        activation.kinds.every((kind) => kinds.includes(kind));
    } else if (
      activation.status === 'not-reproduced' ||
      activation.status === 'cancelled' ||
      activation.status === 'refused'
    ) {
      const reason = 'reason' in activation ? activation.reason : undefined;
      validActivation =
        exactKeys(activation, ['status', 'reason']) &&
        (reason === undefined ||
          (typeof reason === 'string' && reason.length > 0 && reason.length <= 2000));
    }
  }
  if (
    !terminal ||
    terminal.receipt !== receipt ||
    !exactKeys(terminal, ['status', 'receipt', 'assessment', 'activation']) ||
    Buffer.byteLength(JSON.stringify(terminal), 'utf8') > ASSESSMENT_PRODUCER_COST.terminalBytes ||
    !['activated', 'refused', 'no-activation', 'cancelled'].includes(terminal.status) ||
    !validActivation ||
    (terminal.status === 'cancelled'
      ? terminal.assessment !== null || terminal.activation.status !== 'cancelled'
      : !native(terminal.assessment)) ||
    (terminal.status === 'activated' &&
      !['activated', 'replayed'].includes(terminal.activation.status)) ||
    (terminal.status === 'no-activation' && terminal.activation.status !== 'not-reproduced') ||
    (terminal.status === 'refused' &&
      !['stale-summary', 'stale-dependency', 'refused'].includes(terminal.activation.status))
  ) {
    throw new VerificationInvalid('assessment producer terminal differs from its graph outcome');
  }
}

export interface EvidenceItemInput {
  stance: 'supports' | 'contradicts' | 'uncertain';
  observation?: string; contentRevision?: string; graphReference?: string;
  selector: Record<string, unknown>;
  availability: 'available' | 'inaccessible' | 'withdrawn' | 'erased';
}

export interface EvidenceRevision {
  revision: string; claim: string; claimRevision: string; purpose: string; predecessor: string | null;
  itemCount: number; manifestDigest: string; createdAt: string;
  items: (EvidenceItemInput & { ordinal: number; currentAvailability: string })[];
}

export interface Dependency {
  owner: 'graph' | 'content'; kind: string; reference: string; expectedHead: string | null;
}

export interface WalkAuthority {
  principal: string; actingSubject: string; scope: string; authorityEpoch: string; requestDigest: string;
}
export interface WalkProgress {
  continuation: string | null; walk: string; complete: boolean; lineageNodes: number;
  work: { expansions: number; links: number }; totalWork: { expansions: number; links: number };
  lineageProof: LineageProof;
}
interface WalkRow {
  id: string; stream_principal: string; root_ordinal: number; version: number; complete: boolean; unknown: boolean; circular: boolean;
  origin_count: string; expansions: string; edges: string; node_count: string;
}
interface FreshnessRow {
  stream_principal: string; source_epoch: string; validated_sequence: string; freshness_snapshot: string;
  freshness_target: string | null; freshness_phase: number; freshness_xid: string;
  freshness_id: string; freshness_hole: number;
}
interface SourceChange { reference: string; kind: string }
interface WalkNode {
  observation_id: string; depth: number; phase: number; done: boolean;
  edge_cursor: string | null; input_cursor: number; has_links: boolean;
}

export interface AnalysisSnapshot extends WalkProgress {
  stepReplayed: boolean;
  revision: EvidenceRevision; evidenceHead: string | null; links: LineageLink[]; truncated: boolean;
  visited: string[]; lineageHeads: Map<string, string | null>; recordOf: Map<string, string>;
  observedAt: Map<string, string>;
  dispositionHeads: Map<string, string | null>;
  challenge: { revision: string | null; open: number; resolved: number };
}

export interface ActivationInput {
  target: string; context: string; claim: string; claimRevision: string; adoptedRevision: string | null;
  assessment: string; policyRevision: string; support: string; review: string; coverage: string;
  dependence: string; reasons: string[]; dependencies: Dependency[]; ownerPositions: Record<string, unknown>;
  operationKey: string; expectedActive: string | null; observedDemand: string | null;
  openChallenges: number; resolvedChallenges: number;
}

export type ActivationOutcome = { status: 'activated' | 'replayed'; generation: string; number: string; dispute: string }
  | { status: 'stale-summary'; active: string | null } | { status: 'stale-dependency'; kinds: string[] };

export interface SummaryState {
  generation: string; number: string; target: string; context: string; claim: string;
  claimRevision: string; adoptedRevision: string | null; assessment: string | null; policyRevision: string;
  support: string; review: string; dispute: string; coverage: string; dependence: string;
  reasonCodes: string[]; ownerPositions: Record<string, unknown>; createdAt: string;
  dependencies: (Dependency & { currentHead: string | null })[];
  pendingWork: boolean;
}

function checkItems(items: readonly EvidenceItemInput[]) {
  if (items.length > verificationLimits.evidenceItems) {
    throw new VerificationInvalid('evidence manifest exceeds the admitted item ceiling');
  }
  for (const item of items) {
    const anchors = [item.observation, item.contentRevision, item.graphReference].filter(Boolean);
    if (anchors.length !== 1 || (item.observation && !UUID.test(item.observation))
      || (item.contentRevision && !UUID.test(item.contentRevision))
      || JSON.stringify(item.selector).length > 4096) {
      throw new VerificationInvalid('evidence item needs exactly one bounded anchor');
    }
  }
}

/** Private source observations are citable only by their owning principal; others read as missing. */
async function ownObservations(client: PoolClient, principal: string, ids: readonly (string | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return;
  const owned = await client.query('SELECT 1 FROM source.observation WHERE id = ANY($1::uuid[]) AND principal_id = $2',
    [wanted, principal]);
  if (owned.rowCount !== wanted.length) throw new VerificationMissing('source observation is unavailable');
}

const itemsDigest = (items: readonly EvidenceItemInput[]) => digestOf(items.map(item => ({
  stance: item.stance, observation: item.observation ?? null, contentRevision: item.contentRevision ?? null,
  graphReference: item.graphReference ?? null, selector: item.selector, availability: item.availability })));

export class VerificationStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(work: (client: PoolClient) => Promise<T>, snapshot = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.txOnce(work, snapshot); }
      catch (error) { if (!snapshot || pg(error).code !== '40001' || attempt >= 2) throw error; }
    }
  }

  private async txOnce<T>(work: (client: PoolClient) => Promise<T>, snapshot = false): Promise<T> {
    const client = await this.pool.connect().catch((error) => {
      throw new VerificationUnavailable(String(error));
    });
    try {
      await client.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw verificationError(error);
    } finally { client.release(); }
  }

  /** The singleton is maintenance configuration, read without tuple locks.
   * Producer table locks, not shared tuple ownership, establish the writer cut. */
  private async assessmentProducerPermit(
    client: PoolClient,
    expected?: AssessmentProducerPermit,
  ): Promise<AssessmentProducerPermit> {
    const epoch = (
      await client.query<{ epoch: string }>(`SELECT version::text AS epoch
      FROM reading_position.generation WHERE singleton`)
    ).rows[0]?.epoch;
    const gate = (
      await client.query<{
        mode: AssessmentProducerPermit['mode'];
        job: string | null;
        generation: string;
        restore_epoch: string;
      }>(`SELECT mode, job, generation::text, restore_epoch::text
      FROM verification.assessment_producer_gate WHERE singleton`)
    ).rows[0];
    if (!gate || epoch === undefined || gate.restore_epoch !== epoch) {
      throw new VerificationStale('assessment producer restore epoch is unavailable or changed');
    }
    const permit = {
      mode: gate.mode,
      job: gate.job,
      generation: gate.generation,
      restoreEpoch: gate.restore_epoch,
    };
    if (
      expected &&
      (permit.mode !== expected.mode ||
        permit.job !== expected.job ||
        permit.generation !== expected.generation ||
        permit.restoreEpoch !== expected.restoreEpoch)
    ) {
      throw new VerificationStale('assessment producer gate changed');
    }
    return permit;
  }

  /** Register original intent before dispatch or cancellation. Same admission
   * replays only the same original request; it cannot replace the requested tail. */
  async stageAssessmentProducer(
    request: AssessmentProducerStage,
  ): Promise<StagedAssessmentProducer> {
    checkProducerStage(request);
    const input = {
      ...request,
      intent: JSON.parse(JSON.stringify(request.intent)),
    } as AssessmentProducerStage;
    checkProducerStage(input);
    return this.tx(async (client) => {
      const permit = await this.assessmentProducerPermit(client);
      if (permit.mode !== 'ordinary')
        throw new VerificationStale('assessment producers are closed for maintenance');
      await client.query(
        `INSERT INTO verification.assessment_producer (admission_id, request_digest,
        principal_id, acting_subject, scope, authority_epoch, idempotency_key, claim, claim_revision,
        intent_json, stage_generation, restore_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (admission_id) DO NOTHING`,
        [
          input.admission,
          input.requestDigest,
          input.principal,
          input.actingSubject,
          input.scope,
          input.authorityEpoch,
          input.idempotencyKey,
          input.claim,
          input.claimRevision,
          JSON.stringify(input.intent),
          permit.generation,
          permit.restoreEpoch,
        ],
      );
      const stored = (
        await client.query<AssessmentProducerRow>(
          `SELECT ${producerColumns}
        FROM verification.assessment_producer WHERE admission_id = $1`,
          [input.admission],
        )
      ).rows[0];
      if (!stored) throw new VerificationUnavailable('assessment producer staging did not settle');
      const row = producerRecord(stored);
      const {
        stageGeneration: _generation,
        restoreEpoch: _epoch,
        terminal: _terminal,
        ...original
      } = row;
      if (canonicalJson(producerReplayValue(original)) !== canonicalJson(producerReplayValue(input))) {
        throw new VerificationConflict('assessment admission reused with another producer intent');
      }
      if (row.restoreEpoch !== permit.restoreEpoch || row.stageGeneration !== permit.generation) {
        throw new VerificationStale(
          'assessment producer belongs to another gate generation or restore epoch',
        );
      }
      // INSERT owns ROW EXCLUSIVE until commit. If it waited behind maintenance,
      // this READ COMMITTED statement sees the new mode and rolls the insert back.
      await this.assessmentProducerPermit(client, permit);
      return { row, permit };
    });
  }

  /** Historical read only: absence is unknown, including an empty pending page. */
  async readAssessmentProducer(
    admission: string,
    requestDigest?: string,
  ): Promise<AssessmentProducerRecord | null> {
    if (!UUID.test(admission)) throw new VerificationInvalid('invalid assessment admission');
    const stored = (
      await this.pool.query<AssessmentProducerRow>(
        `SELECT ${producerColumns}
      FROM verification.assessment_producer WHERE admission_id = $1`,
        [admission],
      )
    ).rows[0];
    if (!stored) return null;
    if (requestDigest !== undefined && stored.request_digest !== requestDigest) {
      throw new VerificationConflict('assessment admission reused with another request');
    }
    return producerRecord(stored);
  }

  /** Effects and the terminal append share one transaction. A transient failure
   * rolls them both back; exact terminal replay never invokes the effect callback. */
  async withAssessmentProducerEffects(
    admission: string,
    requestDigest: string,
    permit: AssessmentProducerPermit,
    work: (
      client: PoolClient,
      row: AssessmentProducerRecord,
    ) => Promise<AssessmentProducerTerminal>,
  ): Promise<AssessmentProducerRecord> {
    if (!UUID.test(admission) || !/^[0-9a-f]{64}$/.test(requestDigest)) {
      throw new VerificationInvalid('invalid assessment producer identity');
    }
    return this.tx(async (client) => {
      // Before the first SELECT fixes the REPEATABLE READ snapshot, join the
      // compatible writer barrier. Terminal replay participates without effects.
      await client.query('LOCK TABLE verification.assessment_producer IN ROW EXCLUSIVE MODE');
      await this.assessmentProducerPermit(client, permit);
      const stored = (
        await client.query<AssessmentProducerRow>(
          `SELECT ${producerColumns}
        FROM verification.assessment_producer WHERE admission_id = $1 FOR UPDATE`,
          [admission],
        )
      ).rows[0];
      if (!stored)
        throw new VerificationMissing('original assessment producer intent is unavailable');
      if (stored.request_digest !== requestDigest)
        throw new VerificationConflict('assessment producer digest differs');
      const row = producerRecord(stored);
      if (
        row.restoreEpoch !== permit.restoreEpoch ||
        (permit.mode === 'ordinary'
          ? row.stageGeneration !== permit.generation
          : BigInt(row.stageGeneration) >= BigInt(permit.generation))
      ) {
        throw new VerificationStale(
          'assessment producer belongs to another gate generation or restore epoch',
        );
      }
      if (row.terminal) {
        await this.assessmentProducerPermit(client, permit);
        return row;
      }
      const terminal = await work(client, row);
      checkProducerTerminal(admission, terminal);
      if (terminal.activation.status === 'activated' || terminal.activation.status === 'replayed') {
        const activation = terminal.activation;
        const authority = (
          await client.query<{
            claim: string;
            claim_revision: string;
            assessment: string;
            target: string;
            context: string;
            generation: string;
            dispute: string;
          }>(
            `SELECT claim, claim_revision,
          assessment, target, context, generation::text, dispute FROM verification.summary_generation
          WHERE id = $1 AND operation_key = $2`,
            [uuidOf(activation.generation), `assessment:${admission}`],
          )
        ).rows[0];
        if (
          !authority ||
          authority.claim !== row.claim ||
          authority.claim_revision !== row.claimRevision ||
          authority.assessment !== terminal.assessment ||
          authority.target !== row.claim ||
          authority.context !== row.intent.evaluationContext ||
          authority.generation !== activation.number ||
          authority.dispute !== activation.dispute
        ) {
          throw new VerificationInvalid(
            'activated assessment producer lacks its exact immutable summary authority',
          );
        }
      }
      if (terminal.status === 'activated' || terminal.status === 'no-activation') {
        // A summary alone cannot manufacture completion of the originally
        // requested challenge tail. Every requested ID has its own immutable
        // receipt/resolution authority; there are at most eight exact seeks.
        for (const challenge of row.intent.resolvesChallenges) {
          const authority = (
            await client.query<{
              request_digest: string;
              outcome: string;
              result_id: string;
              claim: string;
              resolution_outcome: string;
              assessment: string;
              acting_subject: string;
              principal_id: string;
            }>(
              `
            SELECT r.request_digest, r.outcome, r.result_id, c.claim, x.outcome AS resolution_outcome,
              x.assessment, x.acting_subject, x.principal_id FROM verification.receipt r
            JOIN verification.challenge_resolution x ON x.operation_id = r.id
            JOIN verification.challenge c ON c.id = x.challenge_id
            WHERE r.principal_id = $1 AND r.action = 'challenge.resolve' AND r.idempotency_key = $2
              AND x.challenge_id = $3`,
              [row.principal, `${admission}:${challenge}`, challenge],
            )
          ).rows[0];
          if (
            !authority ||
            authority.outcome !== 'succeeded' ||
            authority.result_id !== challenge ||
            authority.claim !== row.claim ||
            authority.assessment !== terminal.assessment ||
            authority.acting_subject !== row.actingSubject ||
            authority.principal_id !== row.principal ||
            !['material-conflict', 'not-established'].includes(authority.resolution_outcome) ||
            authority.request_digest !==
              digestOf({
                family: 'challenge-resolution-v1',
                claim: row.claim,
                challenge,
                assessment: terminal.assessment,
                outcome: authority.resolution_outcome,
              })
          ) {
            throw new VerificationInvalid(
              'completed assessment producer lacks its exact requested challenge authority',
            );
          }
        }
      }
      await client.query(
        `UPDATE verification.assessment_producer SET terminal = $2,
        terminal_at = clock_timestamp() WHERE admission_id = $1`,
        [admission, terminal],
      );
      await this.assessmentProducerPermit(client, permit);
      return { ...row, terminal };
    }, true);
  }

  /** Only maintenance writes the singleton. SHARE drains prior stage/effect
   * writers and blocks new writers until the mode update commits. */
  async closeAssessmentProducerGate(
    job: string,
    expectedGeneration: string,
  ): Promise<AssessmentProducerPermit> {
    if (!producerJob(job) || !nonnegative(expectedGeneration))
      throw new VerificationInvalid('invalid producer closure');
    return this.tx(async (client) => {
      const epoch = (
        await client.query<{ epoch: string }>(`SELECT version::text AS epoch
        FROM reading_position.generation WHERE singleton`)
      ).rows[0]?.epoch;
      // The conditional UPDATE serializes operators without ordinary readers
      // acquiring a shared tuple lock (or allocating singleton MultiXacts).
      await client.query(
        `UPDATE verification.assessment_producer_gate
        SET mode = 'maintenance', job = $1, generation = generation + 1
        WHERE singleton AND mode = 'ordinary' AND generation = $2 AND restore_epoch = $3`,
        [job, expectedGeneration, epoch],
      );
      const gate = (
        await client.query<{
          mode: AssessmentProducerPermit['mode'];
          job: string | null;
          generation: string;
          restore_epoch: string;
        }>(`SELECT mode, job, generation::text, restore_epoch::text
        FROM verification.assessment_producer_gate WHERE singleton`)
      ).rows[0];
      if (!gate || epoch === undefined || gate.restore_epoch !== epoch) {
        throw new VerificationStale('assessment producer restore epoch changed');
      }
      if (gate.mode !== 'maintenance' || gate.job !== job
        || BigInt(gate.generation) !== BigInt(expectedGeneration) + 1n) {
        throw new VerificationStale('assessment producer closure generation changed');
      }
      const permit: AssessmentProducerPermit = {
        mode: gate.mode, job: gate.job, generation: gate.generation, restoreEpoch: epoch,
      };
      await client.query('LOCK TABLE verification.assessment_producer IN SHARE MODE');
      await this.assessmentProducerPermit(client, permit);
      return permit;
    });
  }

  /** An indexed bounded pending seek. A locked earliest row waits or fails;
   * it is never omitted as evidence of an empty producer set. */
  async listPendingAssessmentProducers(
    permit: AssessmentProducerPermit,
    after: string | null = null,
    limit: number = ASSESSMENT_PRODUCER_COST.page,
  ): Promise<AssessmentProducerRecord[]> {
    if (
      permit.mode !== 'maintenance' ||
      (after !== null && !UUID.test(after)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > ASSESSMENT_PRODUCER_COST.page
    ) {
      throw new VerificationInvalid('invalid assessment producer pending seek');
    }
    return this.tx(async (client) => {
      await this.assessmentProducerPermit(client, permit);
      const rows = (
        await client.query<AssessmentProducerRow>(
          `SELECT ${producerColumns}
        FROM verification.assessment_producer WHERE terminal IS NULL AND admission_id ${after === null ? '>=' : '>'} $1::uuid
        ORDER BY admission_id LIMIT $2 FOR UPDATE`,
          [after ?? MIN_UUID, limit],
        )
      ).rows.map(producerRecord);
      if (
        rows.some(
          (row) =>
            row.restoreEpoch !== permit.restoreEpoch ||
            BigInt(row.stageGeneration) >= BigInt(permit.generation),
        )
      ) {
        throw new VerificationStale(
          'pending assessment producer belongs to another gate generation or restore epoch',
        );
      }
      return rows;
    });
  }

  /** Audit every original producer, including terminal history. This bounded
   * table read is not Access coverage, native inventory or a closure seal. */
  async auditAssessmentProducers(
    permit: AssessmentProducerPermit,
    frontier: AssessmentProducerAuditFrontier | null = null,
    limit: number = ASSESSMENT_PRODUCER_COST.page,
  ): Promise<AssessmentProducerAuditPage> {
    const { mode, job, generation, restoreEpoch } = permit;
    if (mode !== 'maintenance' || typeof job !== 'string' || !producerJob(job)
      || typeof generation !== 'string' || !nonnegative(generation)
      || typeof restoreEpoch !== 'string' || !nonnegative(restoreEpoch)
      || !Number.isInteger(limit) || limit < 1 || limit > ASSESSMENT_PRODUCER_COST.page
      || (frontier !== null && (!UUID.test(frontier.after) || frontier.job !== job
        || frontier.generation !== generation || frontier.restoreEpoch !== restoreEpoch))) {
      throw new VerificationInvalid('invalid assessment producer audit frontier or permit');
    }
    const expected: AssessmentProducerPermit = { mode, job, generation, restoreEpoch };
    const after = frontier?.after ?? null;
    return this.tx(async client => {
      // Prefer the existing ordered PK seek over a population sort even for a
      // tiny corpus. The setting lasts only for this operator transaction.
      await client.query('SET LOCAL enable_sort = off');
      await this.assessmentProducerPermit(client, expected);
      // Bound raw rows before parsing. A malformed original consumes its place
      // in the window; a locked row waits/refuses rather than silently vanishing.
      const rows = (await client.query<AssessmentProducerRow>(`SELECT ${producerColumns}
        FROM verification.assessment_producer
        WHERE admission_id ${after === null ? '>=' : '>'} $1::uuid
        ORDER BY admission_id LIMIT $2 FOR SHARE`,
      [after ?? MIN_UUID, limit + 1])).rows;
      const consumed = rows.slice(0, limit);
      const entries: AssessmentProducerAuditEntry[] = consumed.map(row => {
        try {
          const producer = checkedProducer(row);
          if (producer.terminal === null) return { status: 'unresolved', reason: 'pending', producer };
          return { status: 'terminal', producer: { ...producer, terminal: producer.terminal } };
        } catch {
          return { status: 'unresolved', reason: 'invalid-original', admission: row.admission_id };
        }
      });
      await this.assessmentProducerPermit(client, expected);
      const eof = rows.length <= limit;
      return { scope: 'content-assessment-producer', entries, eof,
        frontier: eof ? null : { after: consumed[consumed.length - 1]!.admission_id, job,
          generation, restoreEpoch } };
    });
  }

  /** Exact primary-key lookups for one saved audit window on the caller's own
   * REPEATABLE READ client. It never opens, ends or releases a transaction and
   * takes no row locks; the maintenance permit is checked before and after the
   * read. Absence and malformed originals stay unknown, never reconstructed. */
  async readAssessmentProducerOriginals(
    client: PoolClient,
    permit: AssessmentProducerPermit,
    admissions: readonly string[],
  ): Promise<AssessmentProducerOriginalLookup[]> {
    const { mode, job, generation, restoreEpoch } = permit;
    if (
      mode !== 'maintenance' ||
      typeof job !== 'string' ||
      !producerJob(job) ||
      typeof generation !== 'string' ||
      !nonnegative(generation) ||
      typeof restoreEpoch !== 'string' ||
      !nonnegative(restoreEpoch) ||
      !Array.isArray(admissions) ||
      admissions.length > ASSESSMENT_PRODUCER_COST.page ||
      new Set(admissions).size !== admissions.length ||
      admissions.some((admission) => typeof admission !== 'string' || !UUID.test(admission))
    ) {
      throw new VerificationInvalid('invalid assessment producer original lookup or permit');
    }
    const expected: AssessmentProducerPermit = { mode, job, generation, restoreEpoch };
    try {
      // SAVEPOINT fails in autocommit without starting or ending a transaction.
      await client.query('SAVEPOINT assessment_producer_original_read');
      await client.query('RELEASE SAVEPOINT assessment_producer_original_read');
    } catch {
      throw new VerificationInvalid('assessment producer originals need a caller transaction');
    }
    const isolation = (
      await client.query<{ transaction_isolation: string }>('SHOW transaction_isolation')
    ).rows[0]?.transaction_isolation;
    if (isolation !== 'repeatable read') {
      throw new VerificationInvalid(
        'assessment producer originals need a caller REPEATABLE READ transaction',
      );
    }
    await this.assessmentProducerPermit(client, expected);
    // Bound transport in SQL before the driver parses jsonb or this process
    // parses intent text; an oversized original keeps only its UUID.
    const rows =
      admissions.length === 0
        ? []
        : (
            await client.query<AssessmentProducerRow & { oversized: boolean }>(
              `WITH wanted AS (SELECT p.*,
        (octet_length(p.intent_json) > $2 OR COALESCE(octet_length(p.terminal::text), 0) > $3
          OR (octet_length(p.scope)::bigint + octet_length(p.authority_epoch) + octet_length(p.idempotency_key)
            + octet_length(p.acting_subject) + octet_length(p.claim) + octet_length(p.claim_revision)
            + octet_length(p.request_digest)) > $4) AS oversized
        FROM verification.assessment_producer AS p WHERE p.admission_id = ANY($1::uuid[]))
      SELECT admission_id, oversized,
        ${[
          'request_digest',
          'principal_id',
          'acting_subject',
          'scope',
          'authority_epoch',
          'idempotency_key',
          'claim',
          'claim_revision',
          'intent_json',
          'terminal',
        ]
          .map((column) => `CASE WHEN oversized THEN NULL ELSE ${column} END AS ${column}`)
          .join(', ')},
        CASE WHEN oversized THEN NULL ELSE stage_generation::text END AS stage_generation,
        CASE WHEN oversized THEN NULL ELSE restore_epoch::text END AS restore_epoch
      FROM wanted`,
              [
                admissions,
                ASSESSMENT_PRODUCER_COST.intentBytes,
                ASSESSMENT_PRODUCER_COST.terminalBytes,
                2048,
              ],
            )
          ).rows;
    await this.assessmentProducerPermit(client, expected);
    const byAdmission = new Map(rows.map((row) => [row.admission_id, row]));
    return admissions.map((admission): AssessmentProducerOriginalLookup => {
      const row = byAdmission.get(admission);
      if (!row) return { status: 'absent' };
      try {
        if (row.oversized)
          throw new VerificationUnavailable('stored assessment producer is oversized');
        return { status: 'found', producer: checkedProducer(row) };
      } catch {
        return { status: 'invalid-original' };
      }
    });
  }

  /** Replay by (principal, action, key): same digest returns the recorded result. */
  private async replay(client: PoolClient, principal: string, action: string, key: string,
    digest: string): Promise<string | null> {
    if (!KEY.test(key)) throw new VerificationInvalid('invalid idempotency key');
    const row = (await client.query<{ request_digest: string; result_id: string }>(`SELECT request_digest,
      result_id FROM verification.receipt WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3`,
    [principal, action, key])).rows[0];
    if (!row) return null;
    if (row.request_digest !== digest) throw new VerificationConflict('idempotency key reused with another request');
    return row.result_id;
  }

  private async receipt(client: PoolClient, principal: string, action: string, key: string,
    digest: string, result: string): Promise<string> {
    const id = crypto.randomUUID();
    await client.query(`INSERT INTO verification.receipt (id, principal_id, action, idempotency_key,
      request_digest, outcome, result_id) VALUES ($1, $2, $3, $4, $5, 'succeeded', $6)`,
    [id, principal, action, key, digest, result]);
    return id;
  }

  /** Run a keyed command; a concurrent same-key request resolves through its receipt. */
  private async keyed<T>(principal: string, action: string, key: string, digest: string,
    read: (client: PoolClient, id: string) => Promise<T>,
    write: (client: PoolClient, operation: (result: string) => Promise<string>) => Promise<string>,
    suppliedClient?: PoolClient,
  ): Promise<T & { replayed: boolean }> {
    const work = async (client: PoolClient) => {
          const existing = await this.replay(client, principal, action, key, digest);
          if (existing) return { ...(await read(client, existing)), replayed: true };
          const id = await write(client, (result) => this.receipt(client, principal, action, key, digest, result),
      );
          return { ...(await read(client, id)), replayed: false };
        };
    if (suppliedClient) {
      try {
        return await work(suppliedClient);
      } catch (error) {
        throw verificationError(error);
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.tx(work);
      } catch (error) {
        if (pg(error).code !== '23505' || pg(error).constraint !== 'receipt_principal_id_action_idempotency_key_key'
          || attempt) throw error;
      }
    }
    throw new VerificationUnavailable('receipt race did not settle');
  }

  // --------------------------------------------------------------- lineage

  /** The observation author can change current availability without rewriting evidence history. */
  async recordObservationDisposition(principal: string, key: string, observation: string,
    input: { expectedHead: string | null; state: 'available' | 'inaccessible' | 'withdrawn'; reason: string }) {
    if (!UUID.test(observation) || (input.expectedHead !== null && !UUID.test(input.expectedHead))
      || !input.reason.trim() || input.reason.length > 2000) {
      throw new VerificationInvalid('source disposition intent is invalid');
    }
    const digest = digestOf({ family: 'observation-disposition-v1', observation, ...input });
    try { return await this.keyed(principal, 'source-disposition.record', key, digest,
      async (client, id) => {
        const row = (await client.query(`SELECT id, observation_id, predecessor, state, reason, created_at
          FROM verification.observation_disposition WHERE id = $1`, [id])).rows[0];
        return { disposition: nativeId(row.id), observation: row.observation_id as string,
          predecessor: row.predecessor ? nativeId(row.predecessor) : null, state: row.state as string,
          reason: row.reason as string, createdAt: iso(row.created_at) };
      }, async (client, receipt) => {
        await ownObservations(client, principal, [observation]);
        const head = (await client.query<{ head: string }>(`SELECT head
          FROM verification.observation_disposition_head WHERE observation_id = $1 FOR UPDATE`,
        [observation])).rows[0]?.head ?? null;
        if (head !== input.expectedHead) throw new VerificationStale('source disposition head changed');
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO verification.observation_disposition
          (id, observation_id, predecessor, state, reason, operation_id, principal_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, observation, head, input.state, input.reason, await receipt(id), principal]);
        if (head) await client.query(`UPDATE verification.observation_disposition_head SET head = $1
          WHERE observation_id = $2 AND head = $3`, [id, observation, head]);
        else await client.query(`INSERT INTO verification.observation_disposition_head
          (observation_id, head) VALUES ($1, $2)`, [observation, id]);
        return id;
      });
    } catch (error) {
      if (pg(error).constraint === 'observation_disposition_head_pkey') {
        throw new VerificationStale('source disposition head changed concurrently');
      }
      throw error;
    }
  }

  async recordOrigin(principal: string, key: string, input: { kind: string; locator: string }) {
    const digest = digestOf({ family: 'origin-v1', ...input });
    return this.keyed(principal, 'origin.record', key, digest,
      async (client, id) => {
        const row = (await client.query('SELECT id, kind, locator, created_at FROM verification.origin WHERE id = $1', [id])).rows[0];
        return { origin: nativeId(row.id), kind: row.kind as string, locator: row.locator as string, createdAt: iso(row.created_at) };
      },
      async (client, receipt) => {
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO verification.origin (id, kind, locator, operation_id, principal_id)
          VALUES ($1, $2, $3, $4, $5)`, [id, input.kind, input.locator, await receipt(id), principal]);
        return id;
      });
  }

  async recordLineage(principal: string, key: string, observation: string, input: {
    relation: string; target: { observation?: string; origin?: string; reference?: string };
    basis: string; method: string | null }) {
    const targets = [input.target.observation, input.target.origin, input.target.reference].filter(Boolean);
    if (!UUID.test(observation) || targets.length !== 1
      || (input.target.observation && !UUID.test(input.target.observation))
      || (input.target.origin && !UUID.test(input.target.origin))) {
      throw new VerificationInvalid('lineage edge needs one exact target');
    }
    const digest = digestOf({ family: 'lineage-edge-v1', observation, ...input });
    return this.keyed(principal, 'lineage.record', key, digest,
      async (client, id) => this.readEdge(client, id),
      async (client, receipt) => {
        await ownObservations(client, principal, [observation, input.target.observation]);
        const id = crypto.randomUUID();
        try {
          await client.query('SAVEPOINT edge');
          await client.query(`INSERT INTO verification.lineage_edge (id, observation_id, relation,
            target_observation_id, target_origin_id, target_reference, basis, method, operation_id, principal_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, observation, input.relation,
            input.target.observation ?? null, input.target.origin ?? null, input.target.reference ?? null,
            input.basis, input.method, await receipt(id), principal]);
        } catch (error) {
          if (pg(error).constraint === 'lineage_edge_identity') {
            throw new VerificationConflict('the same lineage edge is already recorded');
          }
          throw error;
        }
        return id;
      });
  }

  private async readEdge(client: PoolClient, id: string) {
    const row = (await client.query(`SELECT e.*, r.edge_id AS retracted FROM verification.lineage_edge e
      LEFT JOIN verification.lineage_retraction r ON r.edge_id = e.id WHERE e.id = $1`, [id])).rows[0];
    return { edge: nativeId(row.id), observation: nativeId(row.observation_id), relation: row.relation as string,
      target: row.target_observation_id ? { observation: nativeId(row.target_observation_id) }
        : row.target_origin_id ? { origin: nativeId(row.target_origin_id) } : { reference: row.target_reference as string },
      basis: row.basis as string, method: row.method as string | null, retracted: Boolean(row.retracted),
      createdAt: iso(row.created_at) };
  }

  async retractLineage(principal: string, key: string, edge: string, reason: string) {
    if (!UUID.test(edge)) throw new VerificationInvalid('invalid lineage edge');
    const digest = digestOf({ family: 'lineage-retraction-v1', edge, reason });
    return this.keyed(principal, 'lineage.retract', key, digest,
      async (client, id) => this.readEdge(client, id),
      async (client, receipt) => {
        const exists = await client.query('SELECT 1 FROM verification.lineage_retraction WHERE edge_id = $1', [edge]);
        if (exists.rowCount) throw new VerificationConflict('lineage edge is already retracted');
        await client.query(`INSERT INTO verification.lineage_retraction (edge_id, reason, operation_id, principal_id)
          VALUES ($1, $2, $3, $4)`, [edge, reason, await receipt(edge), principal]);
        return edge;
      });
  }

  async recordDerivation(principal: string, key: string, observation: string, input: {
    kind: string; method: string; model: string | null; toolVersion: string | null;
    profileRevision: string | null; limitations: string;
    inputs: { observation?: string; origin?: string; reference?: string }[] }) {
    if (!UUID.test(observation) || !input.inputs.length || input.inputs.length > verificationLimits.derivationInputs
      || input.inputs.some(item => [item.observation, item.origin, item.reference].filter(Boolean).length !== 1)) {
      throw new VerificationInvalid('derivation needs 1-32 exact inputs');
    }
    const digest = digestOf({ family: 'derivation-v1', observation, ...input });
    return this.keyed(principal, 'derivation.record', key, digest,
      async (client, id) => {
        const row = (await client.query('SELECT * FROM verification.derivation WHERE id = $1', [id])).rows[0];
        const inputs = (await client.query(`SELECT * FROM verification.derivation_input WHERE derivation_id = $1
          ORDER BY ordinal`, [id])).rows;
        return { derivation: nativeId(row.id), observation: nativeId(row.output_observation_id), kind: row.kind as string,
          method: row.method as string, model: row.model as string | null, toolVersion: row.tool_version as string | null,
          profileRevision: row.profile_revision as string | null, limitations: row.limitations as string,
          inputs: inputs.map(item => item.input_observation_id ? { observation: nativeId(item.input_observation_id) }
            : item.input_origin_id ? { origin: nativeId(item.input_origin_id) } : { reference: item.input_reference as string }),
          createdAt: iso(row.created_at) };
      },
      async (client, receipt) => {
        await ownObservations(client, principal, [observation, ...input.inputs.map(item => item.observation)]);
        const existing = await client.query('SELECT 1 FROM verification.derivation WHERE output_observation_id = $1', [observation]);
        if (existing.rowCount) throw new VerificationConflict('observation already has a recorded derivation');
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO verification.derivation (id, output_observation_id, kind, method, model,
          tool_version, profile_revision, limitations, input_count, operation_id, principal_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [id, observation, input.kind, input.method,
          input.model, input.toolVersion, input.profileRevision, input.limitations, input.inputs.length,
          await receipt(id), principal]);
        for (const [ordinal, item] of input.inputs.entries()) {
          await client.query(`INSERT INTO verification.derivation_input (derivation_id, ordinal,
            input_observation_id, input_origin_id, input_reference) VALUES ($1, $2, $3, $4, $5)`,
          [id, ordinal, item.observation ?? null, item.origin ?? null, item.reference ?? null]);
        }
        return id;
      });
  }

  // -------------------------------------------------------------- evidence

  private async insertManifest(client: PoolClient, principal: string, claim: string, claimRevision: string,
    purpose: 'claim-head' | 'challenge', predecessor: string | null, items: readonly EvidenceItemInput[],
    operation: string, id: string): Promise<void> {
    await client.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
      predecessor, item_count, manifest_digest, operation_id, principal_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, claim, claimRevision, purpose, predecessor,
      items.length, itemsDigest(items), operation, principal]);
    for (const [ordinal, item] of items.entries()) {
      await client.query(`INSERT INTO verification.evidence_item (revision_id, ordinal, stance, observation_id,
        content_revision_id, graph_reference, selector, availability) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ordinal, item.stance, item.observation ?? null, item.contentRevision ?? null,
        item.graphReference ?? null, item.selector, item.availability]);
    }
  }

  /** Append the claim's next evidence revision; `expectedHead` null means no head exists yet. */
  async recordEvidence(principal: string, key: string, claim: string, input: {
    claimRevision: string; expectedHead: string | null; items: readonly EvidenceItemInput[] }) {
    checkItems(input.items);
    if (input.expectedHead !== null && !UUID.test(input.expectedHead)) throw new VerificationInvalid('invalid head');
    const digest = digestOf({ family: 'evidence-v1', claim, ...input });
    try {
      return await this.keyed(principal, 'evidence.record', key, digest,
        async (client, id) => ({ evidence: await this.readEvidenceWith(client, id) }),
        async (client, receipt) => {
          const head = (await client.query<{ head: string }>(
            'SELECT head FROM verification.evidence_head WHERE claim = $1 FOR UPDATE', [claim])).rows[0]?.head ?? null;
          if (head !== input.expectedHead) throw new VerificationStale('evidence head is stale');
          await ownObservations(client, principal, input.items.map(item => item.observation));
          const id = crypto.randomUUID();
          await this.insertManifest(client, principal, claim, input.claimRevision, 'claim-head',
            input.expectedHead, input.items, await receipt(id), id);
          if (head) await client.query('UPDATE verification.evidence_head SET head = $1 WHERE claim = $2 AND head = $3',
            [id, claim, head]);
          else await client.query('INSERT INTO verification.evidence_head (claim, head) VALUES ($1, $2)', [claim, id]);
          return id;
        });
    } catch (error) {
      if (['evidence_chain_root', 'evidence_chain_successor', 'evidence_head_pkey'].includes(pg(error).constraint ?? '')) {
        throw new VerificationStale('evidence head changed concurrently');
      }
      throw error;
    }
  }

  private async readEvidenceWith(client: PoolClient, id: string): Promise<EvidenceRevision> {
    const row = (await client.query('SELECT * FROM verification.evidence_set_revision WHERE id = $1', [id])).rows[0];
    if (!row) throw new VerificationMissing('evidence revision is unavailable');
    const items = (await client.query(`SELECT i.*, c.availability AS content_availability,
      d.state AS observation_availability
      FROM verification.evidence_item i LEFT JOIN content.revision c ON c.id = i.content_revision_id
      LEFT JOIN verification.observation_disposition_head h ON h.observation_id = i.observation_id
      LEFT JOIN verification.observation_disposition d ON d.id = h.head
      WHERE i.revision_id = $1 ORDER BY i.ordinal`, [id])).rows;
    return { revision: nativeId(row.id), claim: row.claim, claimRevision: row.claim_revision, purpose: row.purpose,
      predecessor: row.predecessor ? nativeId(row.predecessor) : null, itemCount: row.item_count,
      manifestDigest: row.manifest_digest, createdAt: iso(row.created_at),
      items: items.map(item => ({ ordinal: item.ordinal, stance: item.stance, selector: item.selector,
        availability: item.availability,
        ...(item.observation_id ? { observation: item.observation_id } : {}),
        ...(item.content_revision_id ? { contentRevision: item.content_revision_id } : {}),
        ...(item.graph_reference ? { graphReference: item.graph_reference } : {}),
        // Recorded availability is historical; an erased Content body is reported as erased now.
        currentAvailability: item.content_availability && item.content_availability !== 'available'
          ? item.content_availability : item.observation_availability && item.observation_availability !== 'available'
            ? item.observation_availability : item.availability })) };
  }

  async readEvidence(id: string): Promise<EvidenceRevision | null> {
    if (!UUID.test(id)) return null;
    try { return await this.tx(client => this.readEvidenceWith(client, id)); }
    catch (error) { if (error instanceof VerificationMissing) return null; throw error; }
  }

  /** HTTP disclosure: private observation selectors belong to their evidence author. */
  async readEvidenceFor(id: string, principal: string): Promise<EvidenceRevision | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async client => {
      const row = (await client.query<{ principal_id: string }>(`SELECT principal_id
        FROM verification.evidence_set_revision WHERE id = $1`, [id])).rows[0];
      return row?.principal_id === principal ? this.readEvidenceWith(client, id) : null;
    });
  }

  async evidenceHead(claim: string): Promise<string | null> {
    const row = (await this.pool.query<{ head: string }>('SELECT head FROM verification.evidence_head WHERE claim = $1',
      [claim])).rows[0];
    return row ? nativeId(row.head) : null;
  }

  /** Durable, owner-local DFS. A token names the input step, so lost responses replay it. */
  async analysisSnapshot(claim: string, revision: string, authority: WalkAuthority,
    continuation?: string, startKey = authority.requestDigest, readOnly = false): Promise<AnalysisSnapshot> {
    const authorityDigest = digestOf({ principal: authority.principal, actingSubject: authority.actingSubject,
      scope: authority.scope, authorityEpoch: authority.authorityEpoch, requestDigest: authority.requestDigest });
    const token = continuation?.match(/^([0-9a-f-]{36}):(\d+)$/);
    if (continuation && (!token || !UUID.test(token[1]!))) throw new VerificationMissing('lineage continuation is unavailable');
    return this.tx(async client => {
      const position = (await client.query<{ snapshot: string; epoch: string }>(`SELECT pg_current_snapshot()::text AS snapshot,
        version::text AS epoch FROM reading_position.generation WHERE singleton`)).rows[0]!;
      const snapshot = position.snapshot;
      let walk: WalkRow;
      if (token) {
        const row = (await client.query<WalkRow>(`SELECT * FROM verification.lineage_walk
          WHERE id = $1 AND claim = $2 AND evidence_revision = $3 AND authority_digest = $4 FOR UPDATE`,
        [token[1], claim, revision, authorityDigest])).rows[0];
        if (!row) throw new VerificationMissing('lineage continuation is unavailable');
        walk = row;
      } else {
        const manifest = await this.readEvidenceWith(client, revision);
        if (manifest.claim !== claim || manifest.purpose !== 'claim-head') {
          throw new VerificationMissing('evidence revision belongs to another claim');
        }
        if (!readOnly) await client.query(`INSERT INTO verification.lineage_walk (id, claim, evidence_revision, authority_digest, start_key, stream_principal, freshness_snapshot, freshness_phase, source_epoch)
          SELECT $1, $2, $3, $4, $5, e.principal_id, $6, 1, $7 FROM verification.evidence_set_revision e WHERE e.id = $3 ON CONFLICT (claim, evidence_revision, authority_digest, start_key) DO NOTHING`,
        [crypto.randomUUID(), claim, revision, authorityDigest, startKey, snapshot, position.epoch]);
        walk = (await client.query<WalkRow>(`SELECT * FROM verification.lineage_walk
          WHERE claim = $1 AND evidence_revision = $2 AND authority_digest = $3 AND start_key = $4 FOR UPDATE`,
        [claim, revision, authorityDigest, startKey])).rows[0]!;
      }
      if (!walk || (readOnly && !walk.complete)) {
        throw new VerificationStale('completed lineage proof is unavailable');
      }
      // A read never relies on asynchronous invalidation delivery.
      const freshness = await this.walkFreshness(client, walk.id);
      if (freshness === 'stale') {
        throw new VerificationStale('lineage continuation basis changed');
      }
      const manifest = await this.readEvidenceWith(client, revision);
      const roots = [...new Set(manifest.items.flatMap(item => item.observation ? [item.observation] : []))];
      const supporting = new Set(manifest.items.filter(item => item.stance === 'supports'
        && item.currentAvailability === 'available').map(item => item.observation));
      const version = readOnly ? walk.version - 1 : token ? Number(token[2]) : 0;
      if (!Number.isSafeInteger(version) || version < 0 || version > walk.version) {
        throw new VerificationStale('lineage continuation step is unavailable');
      }
      const replay = (await client.query<{ result: WalkProgress }>(`SELECT result FROM verification.lineage_walk_step
        WHERE walk_id = $1 AND version = $2`, [walk.id, version])).rows[0]?.result;
      if (!replay && (readOnly || version !== walk.version)) throw new VerificationStale('lineage continuation step is unavailable');
      const work = { expansions: 0, links: 0 };
      let progress = replay;
      if (freshness === 'pending') {
        // The journal cursor commits even while the original DFS/token is
        // suspended. Unrelated changes never invalidate or restart its frontier.
        progress = { walk: walk.id, continuation: `${walk.id}:${walk.version}`, complete: false,
          lineageNodes: Number(walk.node_count), work, totalWork: { expansions: Number(walk.expansions), links: Number(walk.edges) },
          lineageProof: { dependence: 'over-budget', independentOrigins: null, origins: [] } };
      } else if (!progress) {
        const pin = async (observation: string) => {
          // Admitted lineage stays in its evidence author's source stream.
          // Snapshot reads need no source/global writer fence.
          const owned = await client.query('SELECT id FROM source.observation WHERE id = $1 AND principal_id = $2',
            [observation, walk.stream_principal]);
          if (!owned.rowCount) throw new VerificationMissing('source observation is unavailable');
          const inserted = await client.query(`INSERT INTO verification.lineage_walk_observation
            (walk_id, observation_id, lineage_head, disposition_head)
            SELECT $1, o.id, h.revision::text, d.head FROM source.observation o
            LEFT JOIN verification.lineage_head h ON h.observation_id = o.id
            LEFT JOIN verification.observation_disposition_head d ON d.observation_id = o.id WHERE o.id = $2
            ON CONFLICT DO NOTHING`, [walk.id, observation]);
          walk.node_count = String(Number(walk.node_count) + (inserted.rowCount ?? 0));
        };
        // Pin the whole bounded manifest, including unavailable/non-supporting roots.
        for (const root of roots) await pin(root);
        const addNode = async (observation: string, depth: number) => {
          await pin(observation);
          await client.query(`INSERT INTO verification.lineage_walk_node
            (walk_id, root_ordinal, observation_id, depth) VALUES ($1, $2, $3, $4)`,
          [walk.id, walk.root_ordinal, observation, depth]);
          work.expansions++;
        };
        const origin = async (id: string) => {
          if (!supporting.has(roots[walk.root_ordinal])) return;
          const added = await client.query(`INSERT INTO verification.lineage_walk_origin (walk_id, origin_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING`, [walk.id, id]);
          walk.origin_count = String(Number(walk.origin_count) + (added.rowCount ?? 0));
        };
        // Transitions include empty phases and stack pops, keeping zero-edge work bounded.
        for (let transitions = 0; transitions < 240 && !walk.complete; transitions++) {
          if (work.expansions >= LINEAGE_BUDGET || work.links >= LINEAGE_EDGE_BUDGET) break;
          const root = roots[walk.root_ordinal];
          if (!root) { walk.complete = true; break; }
          let node = (await client.query<WalkNode>(`SELECT * FROM verification.lineage_walk_node
            WHERE walk_id = $1 AND root_ordinal = $2 AND NOT done ORDER BY depth DESC LIMIT 1`,
          [walk.id, walk.root_ordinal])).rows[0];
          if (!node) {
            const seeded = await client.query(`SELECT 1 FROM verification.lineage_walk_node
              WHERE walk_id = $1 AND root_ordinal = $2 AND observation_id = $3`, [walk.id, walk.root_ordinal, root]);
            if (seeded.rowCount) { walk.root_ordinal++; continue; }
            await addNode(root, 0);
            continue;
          }
          let link: LineageLink | undefined;
          if (node.phase === 0 || node.phase === 2) {
            const relation = node.phase === 0 ? "<> 'publishes-origin'" : "= 'publishes-origin'";
            const edge = (await client.query(`SELECT e.*, EXISTS (SELECT 1 FROM verification.lineage_retraction r
              WHERE r.edge_id = e.id) AS retracted FROM verification.lineage_edge e
              WHERE e.observation_id = $1 AND e.relation ${relation}
              AND e.id > $2::uuid ORDER BY e.id LIMIT 1`,
            [node.observation_id, node.edge_cursor ?? '00000000-0000-0000-0000-000000000000'])).rows[0];
            if (edge) {
              node.edge_cursor = edge.id;
              work.links++;
              if (!edge.retracted) link = { source: node.observation_id, relation: edge.relation,
                targetObservation: edge.target_observation_id, targetOrigin: edge.target_origin_id,
                targetReference: edge.target_reference };
            } else if (node.phase === 0) { node.phase = 1; node.edge_cursor = null; }
            else node.done = true;
          } else {
            const item = (await client.query(`SELECT i.* FROM verification.derivation d
              JOIN verification.derivation_input i ON i.derivation_id = d.id
              WHERE d.output_observation_id = $1 AND i.ordinal > $2 ORDER BY i.ordinal LIMIT 1`,
            [node.observation_id, node.input_cursor])).rows[0];
            if (item) {
              node.input_cursor = item.ordinal;
              work.links++;
              link = { source: node.observation_id, relation: 'derived-from', targetObservation: item.input_observation_id,
                targetOrigin: item.input_origin_id, targetReference: item.input_reference };
            } else if (node.has_links) node.done = true;
            else node.phase = 2;
          }
          if (link) {
            node.has_links = true;
            if (link.targetObservation) {
              const known = (await client.query<{ done: boolean }>(`SELECT done FROM verification.lineage_walk_node
                WHERE walk_id = $1 AND root_ordinal = $2 AND observation_id = $3`,
              [walk.id, walk.root_ordinal, link.targetObservation])).rows[0];
              if (!known) await addNode(link.targetObservation, node.depth + 1);
              else if (!known.done && supporting.has(root)) walk.circular = true;
            } else if (link.targetOrigin) await origin(link.targetOrigin);
            else if (supporting.has(root)) walk.unknown = true;
          }
          if (node.done && !node.has_links && supporting.has(root)) walk.unknown = true;
          await client.query(`UPDATE verification.lineage_walk_node SET done = $4, phase = $5,
            edge_cursor = $6, input_cursor = $7, has_links = $8
            WHERE walk_id = $1 AND root_ordinal = $2 AND observation_id = $3`,
          [walk.id, walk.root_ordinal, node.observation_id, node.done, node.phase,
            node.edge_cursor, node.input_cursor, node.has_links]);
        }
        walk.expansions = String(Number(walk.expansions) + work.expansions);
        walk.edges = String(Number(walk.edges) + work.links);
        await client.query(`UPDATE verification.lineage_walk SET root_ordinal = $2, complete = $3,
          unknown = $4, circular = $5, origin_count = $6, version = version + 1, expansions = $7, edges = $8, node_count = $9 WHERE id = $1`,
        [walk.id, walk.root_ordinal, walk.complete, walk.unknown, walk.circular, walk.origin_count, walk.expansions, walk.edges, walk.node_count]);
        const origins = (await client.query<{ origin_id: string }>(`SELECT origin_id FROM verification.lineage_walk_origin
          WHERE walk_id = $1 ORDER BY origin_id LIMIT 32`, [walk.id])).rows.map(row => `origin:${row.origin_id}`);
        const dependence = !walk.complete ? 'over-budget' : walk.circular ? 'circular' : walk.unknown ? 'unknown' : 'established';
        progress = { continuation: walk.complete ? null : `${walk.id}:${version + 1}`, walk: walk.id,
          complete: walk.complete, lineageNodes: Number(walk.node_count), work, totalWork: { expansions: Number(walk.expansions), links: Number(walk.edges) },
          lineageProof: { dependence, independentOrigins: dependence === 'established' ? Number(walk.origin_count) : null,
            origins: dependence === 'established' ? origins : [] } };
        await client.query(`INSERT INTO verification.lineage_walk_step (walk_id, version, result) VALUES ($1, $2, $3)`,
        [walk.id, version, progress]);
      }
      const recordOf = new Map<string, string>();
      const observedAt = new Map<string, string>();
      for (const row of (await client.query<{ id: string; record_id: string; submitted_at: Date }>(
        'SELECT id, record_id, submitted_at FROM source.observation WHERE id = ANY($1::uuid[])', [roots])).rows) {
        recordOf.set(row.id, nativeId(row.record_id));
        observedAt.set(row.id, iso(row.submitted_at));
      }
      return { revision: manifest, evidenceHead: nativeId(revision), links: [], truncated: !progress.complete,
        visited: roots, lineageHeads: new Map(), dispositionHeads: new Map(), recordOf, observedAt,
        challenge: await this.challengeStateWith(client, claim), ...progress, stepReplayed: Boolean(replay) };
    }, true);
  }

  private async challengeStateWith(client: PoolClient, claim: string): Promise<{ revision: string | null; open: number; resolved: number }> {
    const row = (await client.query<{ revision: string; open_count: number; resolved: number }>(`
      SELECT revision::text, open_count, resolved_count::int AS resolved
      FROM verification.challenge_head WHERE claim = $1`, [claim])).rows[0];
    return { revision: row?.revision ?? null, open: row?.open_count ?? 0, resolved: row?.resolved ?? 0 };
  }

  async challengeState(claim: string, client?: PoolClient) { return client ? this.challengeStateWith(client, claim) : this.tx(connection => this.challengeStateWith(connection, claim)); }

  // ------------------------------------------------------------ challenges

  async submitChallenge(principal: string, key: string, claim: string, input: {
    claimRevision: string; adoptedRevision: string | null; context: string; reason: string;
    counterevidence: readonly EvidenceItemInput[]; actingSubject: string }) {
    checkItems(input.counterevidence);
    const digest = digestOf({ family: 'challenge-v1', claim, ...input });
    return this.keyed(principal, 'challenge.submit', key, digest,
      async (client, id) => ({ challenge: await this.readChallengeWith(client, id) }),
      async (client, receipt) => {
        await ownObservations(client, principal, input.counterevidence.map(item => item.observation));
        const id = crypto.randomUUID();
        const operation = await receipt(id);
        let manifest: string | null = null;
        if (input.counterevidence.length) {
          manifest = crypto.randomUUID();
          await this.insertManifest(client, principal, claim, input.claimRevision, 'challenge', null,
            input.counterevidence, operation, manifest);
        }
        await client.query(`INSERT INTO verification.challenge (id, claim, claim_revision, adopted_revision, context,
          reason, counterevidence, acting_subject, operation_id, principal_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, claim, input.claimRevision, input.adoptedRevision,
          input.context, input.reason, manifest, input.actingSubject, operation, principal]);
        return id;
      });
  }

  private async readChallengeWith(client: PoolClient, id: string) {
    const row = (await client.query(`SELECT c.*, r.outcome, r.assessment, r.reason AS resolution_reason,
      r.acting_subject AS resolver, r.created_at AS resolved_at FROM verification.challenge c
      LEFT JOIN verification.challenge_resolution r ON r.challenge_id = c.id WHERE c.id = $1`, [id])).rows[0];
    if (!row) throw new VerificationMissing('challenge is unavailable');
    return { challenge: nativeId(row.id), claim: row.claim as string, claimRevision: row.claim_revision as string,
      adoptedRevision: row.adopted_revision as string | null, context: row.context as string, reason: row.reason as string,
      counterevidence: row.counterevidence ? nativeId(row.counterevidence) : null,
      actingSubject: row.acting_subject as string, state: row.outcome ? 'resolved' : 'pending',
      createdAt: iso(row.created_at),
      resolution: row.outcome ? { outcome: row.outcome as string, assessment: row.assessment as string | null,
        reason: row.resolution_reason as string, actingSubject: row.resolver as string,
        createdAt: iso(row.resolved_at) } : null };
  }

  async readChallenge(claim: string, id: string) {
    if (!UUID.test(id)) return null;
    try {
      const challenge = await this.tx(client => this.readChallengeWith(client, id));
      return challenge.claim === claim ? challenge : null;
    } catch (error) { if (error instanceof VerificationMissing) return null; throw error; }
  }

  async listChallenges(claim: string, limit = 50) {
    return this.tx(async client => {
      const ids = (await client.query<{ id: string }>(`SELECT id FROM verification.challenge WHERE claim = $1
        ORDER BY created_at, id LIMIT $2`, [claim, limit])).rows;
      const result = [];
      for (const row of ids) result.push(await this.readChallengeWith(client, row.id));
      return result;
    });
  }

  /** Submitter-only withdrawal; the challenge and its counterevidence remain. */
  async withdrawChallenge(principal: string, key: string, claim: string, challenge: string,
    input: { reason: string; actingSubject: string }) {
    if (!UUID.test(challenge)) throw new VerificationMissing('challenge is unavailable');
    const digest = digestOf({ family: 'challenge-withdrawal-v1', claim, challenge, ...input });
    return this.keyed(principal, 'challenge.resolve', key, digest,
      async (client, id) => ({ challenge: await this.readChallengeWith(client, id) }),
      async (client, receipt) => {
        const owner = (await client.query('SELECT claim FROM verification.challenge WHERE id = $1', [challenge])).rows[0];
        if (!owner || owner.claim !== claim) throw new VerificationMissing('challenge is unavailable');
        await client.query(`INSERT INTO verification.challenge_resolution (challenge_id, outcome, reason,
          acting_subject, operation_id, principal_id) VALUES ($1, 'withdrawn', $2, $3, $4, $5)`,
        [challenge, input.reason, input.actingSubject, await receipt(challenge), principal]);
        return challenge;
      });
  }

  /** Resolve pending challenges from a recorded qualified assessment, idempotently per admission. */
  async resolveChallenges(principal: string, admission: string, claim: string, assessment: string,
    challenges: readonly string[], outcome: 'material-conflict' | 'not-established', reason: string,
    actingSubject: string, suppliedClient?: PoolClient): Promise<void> {
    for (const challenge of challenges) {
      if (!UUID.test(challenge)) throw new VerificationInvalid('invalid challenge');
      const digest = digestOf({ family: 'challenge-resolution-v1', claim, challenge, assessment, outcome });
      await this.keyed(principal, 'challenge.resolve', `${admission}:${challenge}`, digest,
        async (client, id) => this.readChallengeWith(client, id),
        async (client, receipt) => {
          const owner = (await client.query('SELECT claim FROM verification.challenge WHERE id = $1', [challenge])).rows[0];
          if (!owner || owner.claim !== claim) throw new VerificationMissing('challenge is unavailable');
          try {
            await client.query(`INSERT INTO verification.challenge_resolution (challenge_id, outcome, assessment,
              reason, acting_subject, operation_id, principal_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [challenge, outcome, assessment, reason, actingSubject, await receipt(challenge), principal]);
          } catch (error) {
            if (pg(error).constraint === 'challenge_pending_once') throw new VerificationStale('challenge is not pending');
            throw error;
          }
          return challenge;
        }, suppliedClient);
    }
  }

  async challengeSubmitter(challenge: string): Promise<string | null> {
    if (!UUID.test(challenge)) return null;
    return (await this.pool.query<{ principal_id: string }>(
      'SELECT principal_id FROM verification.challenge WHERE id = $1', [challenge])).rows[0]?.principal_id ?? null;
  }

  // -------------------------------------------------------------- summaries

  /** Activate a generation only as the exact successor with every local pinned head still current. */
  async activateSummary(input: ActivationInput, suppliedClient?: PoolClient): Promise<ActivationOutcome> {
    if (input.dependencies.length > verificationLimits.summaryDependencies) {
      throw new VerificationInvalid('summary dependency manifest exceeds its ceiling');
    }
    const work = async (client: PoolClient): Promise<ActivationOutcome> => {
      const replay = (await client.query(`SELECT g.id, g.generation::text, g.dispute FROM verification.summary_generation g
        WHERE g.operation_key = $1`, [input.operationKey])).rows[0];
      if (replay) return { status: 'replayed', generation: nativeId(replay.id), number: replay.generation, dispute: replay.dispute };
      const head = (await client.query<{ active_generation: string; generation: string }>(`SELECT active_generation,
        generation::text FROM verification.summary_head WHERE target = $1 AND context = $2 FOR UPDATE`,
      [input.target, input.context])).rows[0];
      const active = head ? nativeId(head.active_generation) : null;
      if (active !== input.expectedActive) return { status: 'stale-summary', active };
      const stale: string[] = [];
      for (const dependency of input.dependencies.filter(item => item.owner === 'content')) {
        const current = await this.localHead(client, dependency, true);
        if (current !== dependency.expectedHead) stale.push(dependency.kind);
      }
      if (stale.length) return { status: 'stale-dependency', kinds: [...new Set(stale)] };
      const dispute = input.support === 'material-conflict' ? 'disputed'
        : input.openChallenges > 0 ? 'challenge-pending' : input.resolvedChallenges > 0 ? 'resolved' : 'none';
      const id = crypto.randomUUID();
      const number = head ? String(BigInt(head.generation) + 1n) : '1';
      const dependencyDigest = digestOf(input.dependencies);
      await client.query(`INSERT INTO verification.summary_generation (id, target, context, generation, predecessor,
        claim, claim_revision, adopted_revision, assessment, policy_revision, support, review, dispute, coverage,
        dependence, reason_codes, dependency_count, dependency_digest, owner_positions, operation_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [id, input.target, input.context, number, head?.active_generation ?? null, input.claim, input.claimRevision,
        input.adoptedRevision, input.assessment, input.policyRevision, input.support, input.review, dispute,
        input.coverage, input.dependence, input.reasons.length
          ? input.reasons.slice(0, verificationLimits.reasonCodes) : ['no-reason'],
        input.dependencies.length, dependencyDigest, input.ownerPositions, input.operationKey]);
      for (const [ordinal, dependency] of input.dependencies.entries()) {
        await client.query(`INSERT INTO verification.summary_dependency (generation_id, ordinal, owner, kind,
          reference, expected_head) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ordinal, dependency.owner, dependency.kind, dependency.reference, dependency.expectedHead]);
      }
      if (head) {
        await client.query(`UPDATE verification.summary_head SET active_generation = $1, generation = $2
          WHERE target = $3 AND context = $4 AND active_generation = $5`,
        [id, number, input.target, input.context, head.active_generation]);
      } else {
        await client.query(`INSERT INTO verification.summary_head (target, context, active_generation, generation)
          VALUES ($1, $2, $3, 1)`, [input.target, input.context, id]);
      }
      // Demand observed before the build is satisfied; a mark raised meanwhile survives.
      if (input.observedDemand) {
        await client.query(`DELETE FROM verification.reassessment_request WHERE target = $1 AND context = $2
          AND latest_invalidation = $3`, [input.target, input.context, input.observedDemand]);
      }
      return { status: 'activated', generation: nativeId(id), number, dispute };
    };
    if (suppliedClient) {
      try { return await work(suppliedClient); }
      catch (error) { throw verificationError(error); }
    }
    return this.tx(work, true);
  }

  /** Newly visible source commits are above the old xmax or in its xip holes.
   * Check only this evidence author's stream; an unrelated active transaction
   * cannot become an xmin gate. Every journal candidate consumes the step bound.
   * PostgreSQL's native active-transaction list is bounded by DB concurrency,
   * independent of retained sources, walks and journal population.
   * https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT
   */
  private async walkFreshness(client: PoolClient, id: string): Promise<'current' | 'pending' | 'stale'> {
    const position = (await client.query<{ snapshot: string; epoch: string }>(`SELECT pg_current_snapshot()::text AS snapshot,
      version::text AS epoch FROM reading_position.generation WHERE singleton`)).rows[0]!;
    const current = position.snapshot;
    const walk = (await client.query<FreshnessRow>(`SELECT w.stream_principal, w.source_epoch::text, w.validated_sequence::text,
      w.freshness_snapshot, w.freshness_target, w.freshness_phase, w.freshness_xid::text,
      w.freshness_id, w.freshness_hole FROM verification.lineage_walk w
      JOIN verification.evidence_head e ON e.claim = w.claim AND e.head = w.evidence_revision
      WHERE w.id = $1 FOR UPDATE OF w`, [id])).rows[0];
    if (!walk || walk.source_epoch !== position.epoch || (await client.query(`SELECT 1 FROM verification.lineage_walk_observation
      WHERE walk_id = $1 AND stale LIMIT 1`, [id])).rowCount) return 'stale';
    const unchanged = walk.freshness_snapshot === current && walk.freshness_phase !== 0 && !walk.freshness_target;
    if (unchanged) return 'current';
    const persist = () => client.query(`UPDATE verification.lineage_walk SET validated_sequence = $2,
      freshness_snapshot = $3, freshness_target = $4, freshness_phase = $5,
      freshness_xid = $6, freshness_id = $7, freshness_hole = $8 WHERE id = $1`,
    [id, walk.validated_sequence, walk.freshness_snapshot, walk.freshness_target, walk.freshness_phase,
      walk.freshness_xid, walk.freshness_id, walk.freshness_hole]);
    const matches = async (change: SourceChange) => {
      const witness = (await client.query<{ lineage_head: string | null; disposition_head: string | null }>(`
        SELECT lineage_head, disposition_head FROM verification.lineage_walk_observation
        WHERE walk_id = $1 AND observation_id = $2`, [id, change.reference])).rows[0];
      if (!witness) return true;
      const head = await this.localHead(client, { kind: change.kind, reference: change.reference });
      const pinned = change.kind === 'source-observation' ? witness.lineage_head
        : witness.disposition_head ? nativeId(witness.disposition_head) : null;
      return head === pinned;
    };
    let checked = 0;
    while (checked < LINEAGE_EDGE_BUDGET) {
      if (walk.freshness_phase === 0) {
        // Existing 1520 tokens retain their unchecked, commit-ordered prefix.
        const legacy = (await client.query<SourceChange & { local_sequence: string }>(`
          SELECT i.local_sequence::text, i.reference, i.kind FROM verification.invalidation i
          WHERE i.stream_principal = $1 AND i.source_xid IS NULL AND i.local_sequence > $2::bigint
          ORDER BY i.local_sequence LIMIT 1`, [walk.stream_principal, walk.validated_sequence])).rows[0];
        if (legacy) {
          checked++;
          walk.validated_sequence = legacy.local_sequence;
          if (!await matches(legacy)) return 'stale';
          continue;
        }
        walk.freshness_phase = 1;
      }
      if (!walk.freshness_target) {
        walk.freshness_target = current;
        walk.freshness_xid = nativeSnapshot(walk.freshness_snapshot).xmax.toString();
        walk.freshness_id = MIN_UUID;
        walk.freshness_hole = 0;
      }
      const basis = nativeSnapshot(walk.freshness_snapshot);
      const target = nativeSnapshot(walk.freshness_target);
      if (walk.freshness_phase === 1) {
        // Seek raw rows first, including commits invisible in the saved target.
        // Filtering visibility before LIMIT could scan an arbitrary transaction.
        const change = (await client.query<SourceChange & { source_xid: string; id: string }>(`
          SELECT i.source_xid::text, i.id, i.reference, i.kind FROM verification.invalidation i
          WHERE i.stream_principal = $1 AND i.source_epoch = $6::bigint
            AND i.source_xid >= $2::xid8 AND i.source_xid < $3::xid8
            AND (i.source_xid, i.id) > ($4::xid8, $5::uuid)
          ORDER BY i.source_xid, i.id LIMIT 1`,
        [walk.stream_principal, basis.xmax.toString(), target.xmax.toString(), walk.freshness_xid, walk.freshness_id, walk.source_epoch])).rows[0];
        if (change) {
          checked++;
          walk.freshness_xid = change.source_xid;
          walk.freshness_id = change.id;
          if (snapshotVisible(change.source_xid, target) && !await matches(change)) return 'stale';
          continue;
        }
        walk.freshness_phase = 2;
        walk.freshness_id = MIN_UUID;
      }
      // Snapshot holes still active in the target remain in that target and
      // are revisited on its next checkpoint. Completed holes are exact xid
      // seeks, so a later lower-xid commit cannot fall behind the range cursor.
      const holes = basis.active.filter(xid => snapshotVisible(xid, target));
      const hole = holes[walk.freshness_hole];
      if (hole !== undefined) {
        const change = (await client.query<SourceChange & { id: string }>(`
          SELECT i.id, i.reference, i.kind FROM verification.invalidation i
          WHERE i.stream_principal = $1 AND i.source_epoch = $4::bigint
            AND i.source_xid = $2::xid8 AND i.id > $3::uuid
          ORDER BY i.id LIMIT 1`, [walk.stream_principal, hole, walk.freshness_id, walk.source_epoch])).rows[0];
        if (change) {
          checked++;
          walk.freshness_id = change.id;
          if (!await matches(change)) return 'stale';
          continue;
        }
        // Empty native holes add no source candidates. Their number depends
        // only on the native snapshot's active transactions, not source history.
        walk.freshness_hole++;
        walk.freshness_id = MIN_UUID;
        continue;
      }
      walk.freshness_snapshot = walk.freshness_target;
      walk.freshness_target = null;
      walk.freshness_phase = 1;
      walk.freshness_id = MIN_UUID;
      walk.freshness_hole = 0;
      if (walk.freshness_snapshot === current) { await persist(); return 'current'; }
      // A completed older target is progress, not a currentness certificate.
      // Use the remaining budget to catch up to this transaction's read snapshot.
    }
    await persist();
    return 'pending';
  }

  /** Current Content-owned head for one pinned dependency. */
  private async localHead(client: PoolClient, dependency: Pick<Dependency, 'kind' | 'reference'>,
    lock = false): Promise<string | null> {
    const share = lock ? ' FOR SHARE' : '';
    if (dependency.kind === 'evidence-set') {
      const row = (await client.query<{ head: string }>(
        `SELECT head FROM verification.evidence_head WHERE claim = $1${share}`, [dependency.reference])).rows[0];
      return row ? nativeId(row.head) : null;
    }
    if (dependency.kind === 'challenge') {
      return (await client.query<{ revision: string }>(
        `SELECT revision::text FROM verification.challenge_head WHERE claim = $1${share}`, [dependency.reference]))
        .rows[0]?.revision ?? null;
    }
    if (dependency.kind === 'lineage-walk') {
      return await this.walkFreshness(client, dependency.reference) === 'current' ? dependency.reference : null;
    }
    if (dependency.kind === 'source-observation') {
      return (await client.query<{ revision: string }>(
        `SELECT revision::text FROM verification.lineage_head WHERE observation_id = $1${share}`,
        [dependency.reference])).rows[0]?.revision ?? null;
    }
    if (dependency.kind === 'source-disposition') {
      const row = (await client.query<{ head: string }>(`SELECT head FROM verification.observation_disposition_head
        WHERE observation_id = $1${share}`, [dependency.reference])).rows[0];
      return row ? nativeId(row.head) : null;
    }
    throw new VerificationInvalid(`unknown Content dependency ${dependency.kind}`);
  }

  /** The active summary with each pinned Content head re-read in one snapshot. */
  async readSummary(target: string, context: string): Promise<SummaryState | null> {
    return this.tx(async client => {
      const row = (await client.query(`SELECT g.* FROM verification.summary_head h
        JOIN verification.summary_generation g ON g.id = h.active_generation
        WHERE h.target = $1 AND h.context = $2`, [target, context])).rows[0];
      if (!row) return null;
      const dependencies = (await client.query(`SELECT owner, kind, reference, expected_head
        FROM verification.summary_dependency WHERE generation_id = $1 ORDER BY ordinal`, [row.id])).rows;
      const resolved = [];
      for (const item of dependencies) {
        const dependency: Dependency = { owner: item.owner, kind: item.kind, reference: item.reference,
          expectedHead: item.expected_head };
        resolved.push({ ...dependency, currentHead: dependency.owner === 'content'
          ? await this.localHead(client, dependency) : dependency.kind === 'policy' ? dependency.reference : null });
      }
      const pending = await client.query(`SELECT 1 FROM verification.reassessment_request WHERE target = $1 AND context = $2
        UNION ALL SELECT 1 FROM unnest($3::text[], $4::text[]) d(kind, reference)
          CROSS JOIN LATERAL (
            SELECT 1 FROM verification.invalidation i WHERE i.state = 'pending'
              AND i.kind = d.kind AND i.reference = d.reference LIMIT 1
          ) pending
        LIMIT 1`, [target, context, dependencies.map(item => item.kind), dependencies.map(item => item.reference)]);
      return { generation: nativeId(row.id), number: String(row.generation), target: row.target, context: row.context,
        claim: row.claim, claimRevision: row.claim_revision, adoptedRevision: row.adopted_revision,
        assessment: row.assessment, policyRevision: row.policy_revision, support: row.support, review: row.review,
        dispute: row.dispute, coverage: row.coverage, dependence: row.dependence, reasonCodes: row.reason_codes,
        ownerPositions: row.owner_positions, createdAt: iso(row.created_at), dependencies: resolved,
        pendingWork: Boolean(pending.rowCount) || resolved.some(item => item.owner === 'content' && item.currentHead !== item.expectedHead) };
    }, true);
  }

  async corrections(target: string, context: string, limit = 50) {
    const rows = (await this.pool.query(`SELECT n.*, g.assessment FROM verification.correction_notice n
      JOIN verification.summary_generation g ON g.id = n.generation_id
      WHERE n.target = $1 AND n.context = $2 ORDER BY n.created_at, n.generation_id LIMIT $3`,
    [target, context, limit])).rows;
    return rows.map(row => ({ generation: nativeId(row.generation_id), previousGeneration: nativeId(row.previous_generation),
      assessment: row.assessment as string | null, previousSupport: row.previous_support as string,
      support: row.support as string, previousDispute: row.previous_dispute as string, dispute: row.dispute as string,
      createdAt: iso(row.created_at) }));
  }

  /** A claim reader opts into correction delivery for one exact claim/context. */
  async setCorrectionSubscription(principal: string, key: string, claim: string,
    input: { context: string; expectedHead: string | null; state: 'subscribed' | 'unsubscribed' }) {
    if (!UUID.test(principal) || !uuidOf(claim)
      || (input.expectedHead !== null && !UUID.test(input.expectedHead))) {
      throw new VerificationInvalid('correction subscription intent is invalid');
    }
    const digest = digestOf({ family: 'correction-subscription-v1', claim, ...input });
    try {
      return await this.keyed(principal, 'correction-subscription.set', key, digest,
        async (client, id) => {
          const row = (await client.query(`SELECT * FROM verification.correction_subscription_revision
            WHERE id = $1`, [id])).rows[0];
          return { subscription: nativeId(row.id), claim: row.claim as string, context: row.context as string,
            state: row.state as string, predecessor: row.predecessor ? nativeId(row.predecessor) : null,
            createdAt: iso(row.created_at) };
        }, async (client, receipt) => {
          const head = (await client.query<{ head: string }>(`SELECT head
            FROM verification.correction_subscription_head WHERE claim = $1 AND context = $2
              AND principal_id = $3 FOR UPDATE`, [claim, input.context, principal])).rows[0]?.head ?? null;
          if (head !== input.expectedHead) throw new VerificationStale('correction subscription head changed');
          const id = crypto.randomUUID();
          await client.query(`INSERT INTO verification.correction_subscription_revision
            (id, claim, context, principal_id, predecessor, state, operation_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, claim, input.context, principal, head, input.state, await receipt(id)]);
          if (head) await client.query(`UPDATE verification.correction_subscription_head SET head = $1
            WHERE claim = $2 AND context = $3 AND principal_id = $4 AND head = $5`,
          [id, claim, input.context, principal, head]);
          else await client.query(`INSERT INTO verification.correction_subscription_head
            (claim, context, principal_id, head) VALUES ($1, $2, $3, $4)`,
          [claim, input.context, principal, id]);
          return id;
        });
    } catch (error) {
      if (pg(error).constraint === 'correction_subscription_head_pkey') {
        throw new VerificationStale('correction subscription head changed concurrently');
      }
      throw error;
    }
  }

  /** One bounded page of current, opted-in recipients for a durable correction. */
  async leaseCorrectionPage(owner: string, pageSize = 128): Promise<{
    generation: string; claim: string; context: string; cursor: string | null;
    recipients: string[]; next: string | null; complete: boolean } | null> {
    if (!owner || owner.length > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 256) {
      throw new VerificationInvalid('correction delivery page is invalid');
    }
    return this.tx(async client => {
      const notice = (await client.query<{ generation_id: string; target: string; context: string;
        created_at: Date; cursor_principal: string | null }>(`SELECT c.generation_id, n.target, n.context,
          n.created_at, c.cursor_principal FROM verification.correction_delivery_cursor c
          JOIN verification.correction_notice n ON n.generation_id = c.generation_id
          WHERE NOT c.complete AND (c.lease_until IS NULL OR c.lease_until < clock_timestamp()
            OR c.lease_owner = $1)
          ORDER BY n.created_at, c.generation_id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,
      [owner])).rows[0];
      if (!notice) return null;
      await client.query(`UPDATE verification.correction_delivery_cursor
        SET lease_owner = $2, lease_until = clock_timestamp() + interval '1 minute', updated_at = clock_timestamp()
        WHERE generation_id = $1`, [notice.generation_id, owner]);
      const rows = (await client.query<{ principal_id: string }>(`SELECT h.principal_id
        FROM verification.correction_subscription_head h
        JOIN verification.correction_subscription_revision r ON r.id = h.head
        WHERE h.claim = $1 AND h.context = $2 AND r.state = 'subscribed'
          AND r.created_at <= $3 AND ($4::uuid IS NULL OR h.principal_id > $4)
        ORDER BY h.principal_id LIMIT $5`,
      [notice.target, notice.context, notice.created_at, notice.cursor_principal, pageSize + 1])).rows;
      const recipients = rows.slice(0, pageSize).map(row => row.principal_id);
      return { generation: notice.generation_id, claim: notice.target, context: notice.context,
        cursor: notice.cursor_principal, recipients,
        next: recipients.at(-1) ?? notice.cursor_principal, complete: rows.length <= pageSize };
    });
  }

  async acknowledgeCorrectionPage(owner: string, generation: string, cursor: string | null,
    next: string | null, complete: boolean): Promise<void> {
    const result = await this.pool.query(`UPDATE verification.correction_delivery_cursor
      SET cursor_principal = $4, complete = $5, lease_owner = NULL, lease_until = NULL,
        updated_at = clock_timestamp()
      WHERE generation_id = $1 AND lease_owner = $2 AND cursor_principal IS NOT DISTINCT FROM $3
        AND lease_until > clock_timestamp() AND NOT complete`,
    [generation, owner, cursor, next, complete]);
    if (result.rowCount !== 1) throw new VerificationStale('correction delivery lease changed');
  }

  /** Delivery-time disclosure of only the pinned public correction dimensions. */
  async correctionForRecipient(principal: string, generation: string): Promise<{
    status: 'available'; claim: string; generation: string; support: string; dispute: string }
    | { status: 'undisclosed' | 'unavailable' }> {
    if (!UUID.test(principal) || !UUID.test(generation)) return { status: 'unavailable' };
    const notice = (await this.pool.query<{ target: string; context: string; support: string; dispute: string }>(
      'SELECT target, context, support, dispute FROM verification.correction_notice WHERE generation_id = $1',
      [generation])).rows[0];
    if (!notice) return { status: 'unavailable' };
    const allowed = (await this.pool.query(`SELECT 1 FROM verification.correction_subscription_head h
      JOIN verification.correction_subscription_revision r ON r.id = h.head
      WHERE h.claim = $1 AND h.context = $2 AND h.principal_id = $3 AND r.state = 'subscribed'`,
    [notice.target, notice.context, principal])).rowCount === 1;
    return allowed ? { status: 'available', claim: notice.target, generation: nativeId(generation),
      support: notice.support, dispute: notice.dispute } : { status: 'undisclosed' };
  }

  async reassessmentDemand(target: string, context: string, client?: PoolClient): Promise<string | null> {
    return (await (client ?? this.pool).query<{ latest_invalidation: string }>(`SELECT latest_invalidation
      FROM verification.reassessment_request WHERE target = $1 AND context = $2`, [target, context]))
      .rows[0]?.latest_invalidation ?? null;
  }

  // ------------------------------------------------------------ invalidation

  /** Record a graph-owned dependency change from its committed receipt event; idempotent per event. */
  async recordGraphInvalidation(event: string, kind: 'claim' | 'source-assessment', reference: string,
    head: string, position: { dataEpoch: string; sequence: string }): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO verification.invalidation (id, producer, event_key, kind,
      reference, changed_head, producer_epoch, producer_sequence) VALUES ($1, 'graph', $2, $3, $4, $5, $6, $7)
      ON CONFLICT (producer, event_key) DO NOTHING`,
    [crypto.randomUUID(), event, kind, reference, head, position.dataEpoch, position.sequence]);
    if (result.rowCount === 1) return true;
    const existing = (await this.pool.query<{ kind: string; reference: string; changed_head: string;
      producer_epoch: string; producer_sequence: string }>(`SELECT kind, reference, changed_head,
      producer_epoch, producer_sequence FROM verification.invalidation
      WHERE producer = 'graph' AND event_key = $1`, [event])).rows[0];
    if (!existing || existing.kind !== kind || existing.reference !== reference
      || existing.changed_head !== head || existing.producer_epoch !== position.dataEpoch
      || existing.producer_sequence !== position.sequence) {
      throw new VerificationConflict('graph invalidation identity was reused with another event');
    }
    return false;
  }

  /**
   * Fan out pending invalidations one keyset page per transaction. Each page
   * commits its demand and cursor together, so a crash resumes at the cursor
   * and a replayed page cannot mark a summary twice for the same invalidation.
   */
  async processInvalidations(owner: string, options: { pageSize?: number; maxPages?: number } = {}) {
    const pageSize = options.pageSize ?? 50;
    const maxPages = options.maxPages ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200
      || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) {
      throw new VerificationInvalid('invalidation page budget is invalid');
    }
    const counters = { pages: 0, rowsRead: 0, marked: 0, completed: 0 };
    while (counters.pages < maxPages) {
      const page = await this.tx(async client => {
        const work = (await client.query(`SELECT id, producer, kind, reference, cursor_target, cursor_context, cursor_walk, walks_complete
          FROM verification.invalidation WHERE state = 'pending' AND (lease_until IS NULL OR lease_until < clock_timestamp()
            OR lease_owner = $1)
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [owner])).rows[0];
        if (!work) return null;
        if (work.producer === 'content' && (work.kind === 'source-observation' || work.kind === 'source-disposition')
          && !work.walks_complete) {
          // Seek raw candidates before filtering: fresh or already stale walks
          // consume the page budget too. Old events cannot invalidate new proof.
          const candidates: { walk_id: string; lineage_head: string | null;
            disposition_head: string | null; stale: boolean }[] = [];
          let cursor = work.cursor_walk ?? '00000000-0000-0000-0000-000000000000';
          for (let checked = 0; checked < pageSize; checked++) {
            const candidate = (await client.query<typeof candidates[number]>(`SELECT walk_id, lineage_head, disposition_head, stale
              FROM verification.lineage_walk_observation WHERE observation_id = $1
                AND walk_id > $2::uuid ORDER BY walk_id LIMIT 1`, [work.reference, cursor])).rows[0];
            if (!candidate) break;
            candidates.push(candidate);
            cursor = candidate.walk_id;
          }
          const head = await this.localHead(client, { kind: work.kind, reference: work.reference });
          for (const candidate of candidates) {
            const pinned = work.kind === 'source-observation' ? candidate.lineage_head
              : candidate.disposition_head ? nativeId(candidate.disposition_head) : null;
            if (head === pinned || candidate.stale) continue;
            await client.query(`UPDATE verification.lineage_walk_observation SET stale = true
              WHERE walk_id = $1 AND observation_id = $2`, [candidate.walk_id, work.reference]);
            await client.query("SELECT verification.record_invalidation('lineage-walk', $1, NULL, $2)",
              [candidate.walk_id, `lineage-walk-stale:${candidate.walk_id}`]);
          }
          await client.query(`UPDATE verification.invalidation SET cursor_walk = COALESCE($2, cursor_walk),
            walks_complete = $3, pages = pages + 1, lease_owner = $4,
            lease_until = clock_timestamp() + interval '30 seconds' WHERE id = $1`,
          [work.id, candidates.at(-1)?.walk_id ?? null, candidates.length < pageSize, owner]);
          return { rows: candidates.length, marked: 0, done: false };
        }
        const rows = (await client.query<{ target: string; context: string }>(`SELECT target, context
          FROM verification.active_dependency WHERE kind = $1 AND reference = $2
            AND ($3::text IS NULL OR (target, context) > ($3::text, $4::text))
          ORDER BY target, context LIMIT $5`,
        [work.kind, work.reference, work.cursor_target, work.cursor_context, pageSize])).rows;
        let marked = 0;
        for (const row of rows) {
          const effect = await client.query(`INSERT INTO verification.invalidation_effect
            (invalidation_id, target, context) VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING`, [work.id, row.target, row.context]);
          if (!effect.rowCount) continue;
          const upsert = await client.query(`INSERT INTO verification.reassessment_request
            (target, context, first_invalidation, latest_invalidation) VALUES ($1, $2, $3, $3)
            ON CONFLICT (target, context) DO UPDATE SET latest_invalidation = EXCLUDED.latest_invalidation,
              marks = reassessment_request.marks + 1, updated_at = clock_timestamp()
            WHERE reassessment_request.latest_invalidation <> EXCLUDED.latest_invalidation`,
          [row.target, row.context, work.id]);
          marked += upsert.rowCount ?? 0;
        }
        const last = rows.at(-1);
        const done = rows.length < pageSize;
        await client.query(`UPDATE verification.invalidation SET cursor_target = COALESCE($2, cursor_target),
          cursor_context = COALESCE($3, cursor_context), pages = pages + 1, marked = marked + $4,
          state = CASE WHEN $5 THEN 'complete' ELSE 'pending' END,
          completed_at = CASE WHEN $5 THEN clock_timestamp() END,
          lease_owner = CASE WHEN $5 THEN NULL ELSE $6 END,
          lease_until = CASE WHEN $5 THEN NULL ELSE clock_timestamp() + interval '30 seconds' END
          WHERE id = $1`, [work.id, last?.target ?? null, last?.context ?? null, marked, done, owner]);
        return { rows: rows.length, marked, done };
      });
      if (!page) break;
      counters.pages++;
      counters.rowsRead += page.rows;
      counters.marked += page.marked;
      if (page.done) counters.completed++;
    }
    return counters;
  }
}
