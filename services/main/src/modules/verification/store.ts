// Content-DB owner adapter for the `verification` schema. Every mutation is one
// local transaction: domain rows, the owner-local receipt and (through triggers)
// the exact head and invalidation work commit together. SQL stays here.
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LINEAGE_BUDGET, type LineageLink } from './analysis.ts';
import { verificationLimits } from './schema.ts';

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
const iso = (value: Date | string) => new Date(value).toISOString();

interface PgError { code?: string; constraint?: string }
const pg = (error: unknown) => error as PgError;

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

export interface AnalysisSnapshot {
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
    const client = await this.pool.connect().catch(error => {
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
      const code = pg(error).code;
      if (code === '23503') throw new VerificationMissing('referenced evidence or claim record is unavailable');
      if (code === '23514' || code === '22P02' || code === '23502') {
        if (pg(error).constraint === 'challenge_independent_resolution') {
          throw new VerificationDenied('a submitter cannot resolve its own challenge');
        }
        throw new VerificationInvalid(String((error as Error).message));
      }
      throw error;
    } finally { client.release(); }
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
  ): Promise<T & { replayed: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.tx(async client => {
          const existing = await this.replay(client, principal, action, key, digest);
          if (existing) return { ...await read(client, existing), replayed: true };
          const id = await write(client, result => this.receipt(client, principal, action, key, digest, result));
          return { ...await read(client, id), replayed: false };
        });
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

  /** Load one exact manifest with its bounded lineage closure and local heads. */
  async analysisSnapshot(claim: string, revision: string): Promise<AnalysisSnapshot> {
    return this.tx(async client => {
      const manifest = await this.readEvidenceWith(client, revision);
      if (manifest.claim !== claim || manifest.purpose !== 'claim-head') {
        throw new VerificationMissing('evidence revision belongs to another claim');
      }
      const head = (await client.query<{ head: string }>('SELECT head FROM verification.evidence_head WHERE claim = $1',
        [claim])).rows[0]?.head ?? null;
      const roots = [...new Set(manifest.items.flatMap(item => item.observation ? [item.observation] : []))];
      // One bounded recursive walk; the LIMIT stops expansion after the budget.
      const reached = roots.length ? (await client.query<{ observation_id: string }>(`WITH RECURSIVE reach(observation_id) AS (
          SELECT unnest($1::uuid[])
          UNION
          SELECT next.target FROM reach r CROSS JOIN LATERAL (
            SELECT e.target_observation_id AS target FROM verification.lineage_edge e
              WHERE e.observation_id = r.observation_id AND e.target_observation_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM verification.lineage_retraction x WHERE x.edge_id = e.id)
            UNION ALL
            SELECT i.input_observation_id FROM verification.derivation d
              JOIN verification.derivation_input i ON i.derivation_id = d.id
              WHERE d.output_observation_id = r.observation_id AND i.input_observation_id IS NOT NULL) next)
        SELECT observation_id FROM reach LIMIT $2`, [roots, LINEAGE_BUDGET + 1])).rows.map(row => row.observation_id) : [];
      const truncated = reached.length > LINEAGE_BUDGET;
      const visited = reached.slice(0, LINEAGE_BUDGET);
      const links = visited.length ? (await client.query(`
        SELECT e.observation_id AS source, e.relation, e.target_observation_id, e.target_origin_id, e.target_reference
          FROM verification.lineage_edge e WHERE e.observation_id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM verification.lineage_retraction x WHERE x.edge_id = e.id)
        UNION ALL
        SELECT d.output_observation_id, 'derived-from', i.input_observation_id, i.input_origin_id, i.input_reference
          FROM verification.derivation d JOIN verification.derivation_input i ON i.derivation_id = d.id
          WHERE d.output_observation_id = ANY($1::uuid[])`, [visited])).rows.map(row => ({
        source: row.source, relation: row.relation, targetObservation: row.target_observation_id,
        targetOrigin: row.target_origin_id, targetReference: row.target_reference })) : [];
      const heads = new Map<string, string | null>(visited.map(id => [id, null]));
      const dispositionHeads = new Map<string, string | null>(visited.map(id => [id, null]));
      for (const row of visited.length ? (await client.query<{ observation_id: string; revision: string }>(
        `SELECT observation_id, revision::text FROM verification.lineage_head WHERE observation_id = ANY($1::uuid[])`,
        [visited])).rows : []) heads.set(row.observation_id, row.revision);
      for (const row of visited.length ? (await client.query<{ observation_id: string; head: string }>(
        `SELECT observation_id, head FROM verification.observation_disposition_head
          WHERE observation_id = ANY($1::uuid[])`, [visited])).rows : []) {
        dispositionHeads.set(row.observation_id, nativeId(row.head));
      }
      const recordOf = new Map<string, string>();
      const observedAt = new Map<string, string>();
      for (const row of roots.length ? (await client.query<{ id: string; record_id: string; submitted_at: Date }>(
        'SELECT id, record_id, submitted_at FROM source.observation WHERE id = ANY($1::uuid[])', [roots])).rows : []) {
        recordOf.set(row.id, nativeId(row.record_id));
        observedAt.set(row.id, iso(row.submitted_at));
      }
      const challenge = (await client.query<{ revision: string; open_count: number; resolved: number }>(`
        SELECT h.revision::text, h.open_count, (SELECT count(*)::int FROM verification.challenge c
          JOIN verification.challenge_resolution r ON r.challenge_id = c.id WHERE c.claim = h.claim) AS resolved
        FROM verification.challenge_head h WHERE h.claim = $1`, [claim])).rows[0];
      return { revision: manifest, evidenceHead: head ? nativeId(head) : null, links, truncated, visited,
        lineageHeads: heads, dispositionHeads, recordOf, observedAt,
        challenge: { revision: challenge?.revision ?? null, open: challenge?.open_count ?? 0,
          resolved: challenge?.resolved ?? 0 } };
    }, true);
  }

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
    actingSubject: string): Promise<void> {
    for (const challenge of challenges) {
      if (!UUID.test(challenge)) throw new VerificationInvalid('invalid challenge');
      const digest = digestOf({ family: 'challenge-resolution-v1', claim, challenge, assessment, outcome });
      await this.keyed(principal, 'challenge.resolve', `${admission}:${challenge}`, digest,
        async (client, id) => this.readChallengeWith(client, id),
        async (client, receipt) => {
          const owner = (await client.query('SELECT claim FROM verification.challenge WHERE id = $1', [challenge])).rows[0];
          if (!owner || owner.claim !== claim) throw new VerificationMissing('challenge is unavailable');
          try {
            await client.query('SAVEPOINT resolution');
            await client.query(`INSERT INTO verification.challenge_resolution (challenge_id, outcome, assessment,
              reason, acting_subject, operation_id, principal_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [challenge, outcome, assessment, reason, actingSubject, await receipt(challenge), principal]);
          } catch (error) {
            if (pg(error).constraint === 'challenge_pending_once') throw new VerificationStale('challenge is not pending');
            throw error;
          }
          return challenge;
        });
    }
  }

  async challengeSubmitter(challenge: string): Promise<string | null> {
    if (!UUID.test(challenge)) return null;
    return (await this.pool.query<{ principal_id: string }>(
      'SELECT principal_id FROM verification.challenge WHERE id = $1', [challenge])).rows[0]?.principal_id ?? null;
  }

  // -------------------------------------------------------------- summaries

  /** Activate a generation only as the exact successor with every local pinned head still current. */
  async activateSummary(input: ActivationInput): Promise<ActivationOutcome> {
    if (input.dependencies.length > verificationLimits.summaryDependencies) {
      throw new VerificationInvalid('summary dependency manifest exceeds its ceiling');
    }
    return this.tx(async client => {
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
    });
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
        UNION ALL SELECT 1 FROM verification.invalidation i WHERE i.state = 'pending'
          AND (i.kind, i.reference) IN (SELECT kind, reference FROM verification.summary_dependency WHERE generation_id = $3)
        LIMIT 1`, [target, context, row.id]);
      return { generation: nativeId(row.id), number: String(row.generation), target: row.target, context: row.context,
        claim: row.claim, claimRevision: row.claim_revision, adoptedRevision: row.adopted_revision,
        assessment: row.assessment, policyRevision: row.policy_revision, support: row.support, review: row.review,
        dispute: row.dispute, coverage: row.coverage, dependence: row.dependence, reasonCodes: row.reason_codes,
        ownerPositions: row.owner_positions, createdAt: iso(row.created_at), dependencies: resolved,
        pendingWork: Boolean(pending.rowCount) };
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

  async reassessmentDemand(target: string, context: string): Promise<string | null> {
    return (await this.pool.query<{ latest_invalidation: string }>(`SELECT latest_invalidation
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
    return result.rowCount === 1;
  }

  /**
   * Fan out pending invalidations one keyset page per transaction. Each page
   * commits its demand and cursor together, so a crash resumes at the cursor
   * and a replayed page cannot mark a summary twice for the same invalidation.
   */
  async processInvalidations(owner: string, options: { pageSize?: number; maxPages?: number } = {}) {
    const pageSize = options.pageSize ?? 50;
    const maxPages = options.maxPages ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new VerificationInvalid('invalid page size');
    const counters = { pages: 0, rowsRead: 0, marked: 0, completed: 0 };
    while (counters.pages < maxPages) {
      const page = await this.tx(async client => {
        const work = (await client.query(`SELECT id, kind, reference, cursor_target, cursor_context
          FROM verification.invalidation WHERE state = 'pending' AND (lease_until IS NULL OR lease_until < clock_timestamp()
            OR lease_owner = $1)
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [owner])).rows[0];
        if (!work) return null;
        const rows = (await client.query<{ target: string; context: string }>(`SELECT target, context
          FROM verification.active_dependency WHERE kind = $1 AND reference = $2
            AND ($3::text IS NULL OR (target, context) > ($3::text, $4::text))
          ORDER BY target, context LIMIT $5`,
        [work.kind, work.reference, work.cursor_target, work.cursor_context, pageSize])).rows;
        let marked = 0;
        for (const row of rows) {
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
