import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  activateHead, authorizeManager, claimLease, digest, fenceLease, inAccess, markFailed,
  type Activation, type ManageContext, nativeIri, type ReceiptKey, RecommendationDenied,
  RecommendationMissing, RecommendationNotReady, RecommendationRestart, RecommendationStale,
  RecommendationUnavailable, recordReceipt, replayReceipt, requireRecoveryOpen,
} from './derived-generation.ts';

export const RANKING_PROFILE = 'ranking-rating-latest-per-slot-v1';
export const RANKING_POLICY = `https://rezics.com/definition/${RANKING_PROFILE}`;
export const MAX_RANKING_PAGE = 20;
/** Relay batches (each at most 100 events) folded into one Access transaction. */
export const DEFAULT_SIGNAL_BATCHES = 16;
const RELAY_SOURCE = 'https://rezics.com/services/main';
const OBSERVATION_CHANGED = 'com.rezics.rating.observation-changed.v1';
const slotPattern = /^urn:rezics:rating-slot:[0-9a-f]{64}$/;
const CURSOR_BYTES = 480;
const CURSOR_TTL_MS = 5 * 60_000;

export type RankingPopulation = { kind: 'public' } | { kind: 'realm'; realm: string } | { kind: 'personal' };
/** An exact semantic criterion: Context, its definition revision, the selection that chose
 * it and the separately versioned preference ordering. None of them changes signal meaning. */
export interface RankingSemanticBasis {
  context: string; contextRevision: string; selectionRevision: string; preferenceRevision: string | null;
}
export interface RankingBasis {
  profile: typeof RANKING_PROFILE;
  population: RankingPopulation;
  candidateGrain: 'work';
  semantic: RankingSemanticBasis | null;
}
export type RankingViewer = { principal: VerifiedPrincipal; actingSubject: string } | { public: true; principal: null; actingSubject: null };
export interface RankingPage { generation: string; items: { candidate: string }[]; continuation: string | null }
export interface GenerationView {
  generation: string; state: string; population: RankingPopulation['kind']; leaseEpoch: string;
  checkpoint: { dataEpoch: string; sequence: string; snapshotComplete: boolean };
  failureReason: string | null; activeRevision: string | null; replayed?: boolean;
}
export interface BatchResult { relayBatches: number; signals: number; checkpoint: string; snapshotComplete: boolean;
  failed?: string }

export interface RankingOptions {
  access: Pool;
  relay: Pool;
  dataEpoch: string;
  /** 32-byte key sealing client cursors so positions and skipped candidates stay private. */
  cursorKey: Uint8Array;
  canReadWork: (principal: VerifiedPrincipal, actingSubject: string, work: string) => Promise<boolean>;
  /** Current Context definition and selection proof supplied by the Context owner. */
  verifySemantic?: (viewer: RankingViewer, basis: RankingBasis) => Promise<boolean>;
  zeroSnapshot?: () => Promise<string>;
  /** Ordered Work heads within the pinned graph checkpoint; absent in legacy synthetic fixtures. */
  zeroCandidates?: (after: string | null, snapshotTarget: string, limit: number) => Promise<string[]>;
  /** Live trust fence covers both scored candidates and the zero-score tail. */
  unverifiedWorks?: (works: readonly string[]) => Promise<ReadonlySet<string>>;
  leaseMs?: number;
  signalBatches?: number;
}

interface SlotSignal { slot: string; candidate: string; weight: bigint; sequence: string; event: string;
  admission: string; requestDigest: string; authorityEpoch: string; contributor?: string }
interface Totals { score: bigint; signals: bigint }

function validBasis(basis: RankingBasis): void {
  const population = basis.population;
  const semantic = basis.semantic;
  if (basis.profile !== RANKING_PROFILE || basis.candidateGrain !== 'work'
    || !population || !['public', 'realm', 'personal'].includes(population.kind)
    || (population.kind === 'realm' && !nativeIri.test(population.realm))
    || (semantic && (!nativeIri.test(semantic.context) || !nativeIri.test(semantic.contextRevision)
      || !(population.kind === 'personal'
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(semantic.selectionRevision)
          || nativeIri.test(semantic.selectionRevision)
        : nativeIri.test(semantic.selectionRevision))
      || (semantic.preferenceRevision !== null && !nativeIri.test(semantic.preferenceRevision))))) {
    throw new RecommendationDenied('ranking basis is not admitted');
  }
}

/** The scope names population identity; personal scopes include the private owner. */
function scopeKey(basis: RankingBasis, owner: string | null, dataEpoch: string): string {
  return digest({ policy: RANKING_POLICY, dataEpoch, population: basis.population.kind,
    realm: basis.population.kind === 'realm' ? basis.population.realm : null, owner,
    candidateGrain: basis.candidateGrain, semantic: basis.semantic });
}

export function partitionOf(candidate: string, partitionCount: number): number {
  return createHash('sha256').update(candidate).digest().readUInt32BE(0) % partitionCount;
}

/** Ranking generations over admitted Realm rating observations retained by the relay.
 * Each slot counts its latest available value (1-10); a withdrawn slot counts 0. */
export class RankingGenerations {
  private readonly leaseMs: number;
  private readonly signalBatches: number;

  constructor(private readonly options: RankingOptions) {
    if (options.cursorKey.length !== 32) throw new Error('ranking cursor key must be 32 bytes');
    this.leaseMs = options.leaseMs ?? 30_000;
    this.signalBatches = options.signalBatches ?? DEFAULT_SIGNAL_BATCHES;
  }

  private async relayHead(): Promise<string> {
    try {
      return (await this.options.relay.query<{ head: string }>(`SELECT coalesce(max(sequence), 0)::text AS head
        FROM relay.delivered_batch WHERE data_epoch = $1`, [this.options.dataEpoch])).rows[0]!.head;
    } catch { throw new RecommendationUnavailable('relay retention is unavailable'); }
  }

  private async erasureHead(): Promise<string> {
    try {
      return (await this.options.relay.query<{ head: string }>(`SELECT coalesce(max(erasure_epoch), 0)::text AS head
        FROM relay.erasure`)).rows[0]!.head;
    } catch { throw new RecommendationUnavailable('erasure journal is unavailable'); }
  }

  private async describe(client: PoolClient, generation: string): Promise<GenerationView> {
    const row = (await client.query<{ state: string; population: RankingPopulation['kind']; lease_epoch: string;
      data_epoch: string; checkpoint: string; complete: boolean; failure_reason: string | null;
      revision: string | null }>(`SELECT g.state, r.population, g.lease_epoch::text, i.data_epoch,
        i.checkpoint_sequence::text AS checkpoint, i.snapshot_complete AS complete, g.failure_reason,
        h.revision::text AS revision
      FROM access.derived_generation g
      JOIN access.ranking_generation r ON r.generation_id = g.id
      JOIN access.derived_generation_input i ON i.generation_id = g.id AND i.source = 'main-graph'
      LEFT JOIN access.derived_generation_head h ON h.active_generation = g.id
      WHERE g.id = $1`, [generation])).rows[0];
    if (!row) throw new RecommendationMissing('generation is unavailable');
    return { generation, state: row.state, population: row.population, leaseEpoch: row.lease_epoch,
      checkpoint: { dataEpoch: row.data_epoch, sequence: row.checkpoint, snapshotComplete: row.complete },
      failureReason: row.failure_reason, activeRevision: row.revision };
  }

  /** Register one building generation with pinned basis and relay snapshot target. */
  async registerBuild(context: ManageContext, basis: RankingBasis, partitionCount: number,
    receipt: ReceiptKey): Promise<GenerationView> {
    validBasis(basis);
    if (basis.semantic && this.options.verifySemantic) {
      await inAccess(this.options.access, async client => {
        await requireRecoveryOpen(client);
        await authorizeManager(client, context);
      });
      if (!await this.options.verifySemantic(context, basis)) {
        throw new RecommendationDenied('ranking semantic basis is not current');
      }
    }
    if (!Number.isInteger(partitionCount) || partitionCount < 1 || partitionCount > 256) {
      throw new RecommendationDenied('partition count is not admitted');
    }
    const snapshotTarget = await this.relayHead();
    const erasureEpoch = await this.erasureHead();
    let zeroSnapshot: string | null = null;
    if (this.options.zeroSnapshot) {
      try { zeroSnapshot = await this.options.zeroSnapshot(); }
      catch { throw new RecommendationUnavailable('zero-score source snapshot is unavailable'); }
    }
    return inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      const principalId = await authorizeManager(client, context);
      const replay = await replayReceipt(client, principalId, receipt, 'build');
      if (replay) return { ...await this.describe(client, replay.generation_id), replayed: true };
      const owner = basis.population.kind === 'personal' ? principalId : null;
      const scope = scopeKey(basis, owner, this.options.dataEpoch);
      const manifest = { basis, owner, partitionCount,
        source: { source: 'main-graph', relay: RELAY_SOURCE, dataEpoch: this.options.dataEpoch,
          snapshotTarget, erasureEpoch, zeroSnapshot } };
      const generation = randomUUID();
      await client.query(`INSERT INTO access.derived_generation
        (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
        VALUES ($1, 'ranking', $2, $3, $4, clock_timestamp())`,
      [generation, scope, digest(manifest), manifest]);
      const semantic = basis.semantic;
      await client.query(`INSERT INTO access.ranking_generation (generation_id, population, realm,
        principal_id, candidate_grain, score_policy, context, context_revision,
        semantic_selection_revision, preference_revision, partition_count)
        VALUES ($1, $2, $3, $4, 'work', $5, $6, $7, $8, $9, $10)`,
      [generation, basis.population.kind, basis.population.kind === 'realm' ? basis.population.realm : null,
        owner, RANKING_POLICY, semantic?.context ?? null, semantic?.contextRevision ?? null,
        semantic?.selectionRevision ?? null, semantic?.preferenceRevision ?? null, partitionCount]);
      await client.query(`INSERT INTO access.ranking_partition (generation_id, partition)
        SELECT $1, generate_series(0, $2 - 1)`, [generation, partitionCount]);
      await client.query(`INSERT INTO access.derived_generation_input (generation_id, source,
        data_epoch, pinned_sequence, checkpoint_sequence, snapshot_complete)
        VALUES ($1, 'main-graph', $2, 0, 0, $3)`, [generation, this.options.dataEpoch, snapshotTarget === '0']);
      await recordReceipt(client, principalId, receipt, { action: 'build', generation_id: generation,
        outcome: 'succeeded', head_revision: null });
      return { ...await this.describe(client, generation), replayed: false };
    });
  }

  async readGeneration(context: ManageContext, generation: string): Promise<GenerationView> {
    return inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      await authorizeManager(client, context);
      return this.describe(client, generation);
    });
  }

  /** Worker entry: take an unclaimed or expired lease. */
  async claim(generation: string): Promise<string> {
    return inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      await this.requireCurrentEpoch(client, generation);
      return claimLease(client, generation, this.leaseMs);
    });
  }

  private async requireCurrentEpoch(client: PoolClient, generation: string): Promise<void> {
    const source = (await client.query<{ data_epoch: string }>(`SELECT data_epoch
      FROM access.derived_generation_input WHERE generation_id = $1 AND source = 'main-graph'`,
    [generation])).rows[0];
    if (source?.data_epoch !== this.options.dataEpoch) {
      throw new RecommendationStale('generation belongs to another source epoch');
    }
  }

  async fail(generation: string, leaseEpoch: string, reason: string): Promise<void> {
    await inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      await this.requireCurrentEpoch(client, generation);
      await markFailed(client, generation, leaseEpoch, reason);
    });
  }

  /** Apply one bounded, coalesced batch of contiguous relay batches under the caller's lease. */
  async runBatch(generation: string, leaseEpoch: string): Promise<BatchResult> {
    const basis = (await this.options.access.query<{ population: RankingPopulation['kind']; realm: string | null;
      principal_id: string | null; partition_count: number; data_epoch: string; checkpoint: string;
      target: string }>(`SELECT r.population, r.realm, r.principal_id::text, r.partition_count, i.data_epoch,
        i.checkpoint_sequence::text AS checkpoint, g.input_manifest->'source'->>'snapshotTarget' AS target
      FROM access.derived_generation g JOIN access.ranking_generation r ON r.generation_id = g.id
      JOIN access.derived_generation_input i ON i.generation_id = g.id AND i.source = 'main-graph'
      WHERE g.id = $1 AND g.state = 'building'`, [generation]).catch(() => {
      throw new RecommendationUnavailable('Access owner is unavailable');
    })).rows[0];
    if (!basis) throw new RecommendationStale('generation is not building');
    if (basis.data_epoch !== this.options.dataEpoch) {
      throw new RecommendationStale('generation belongs to another source epoch');
    }
    const relay = this.options.relay;
    let batches: { sequence: string; event_count: number }[];
    let events: { event_id: string; sequence: string; envelope: { type?: string; data?: {
      ordinal?: number; receipt?: Record<string, unknown> } } }[] = [];
    try {
      batches = (await relay.query<{ sequence: string; event_count: number }>(`SELECT sequence::text, event_count
        FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence > $2::numeric
        ORDER BY relay.delivered_batch.sequence LIMIT $3`,
      [basis.data_epoch, basis.checkpoint, this.signalBatches])).rows;
      let expected = BigInt(basis.checkpoint) + 1n;
      const contiguous = [];
      for (const batch of batches) {
        if (BigInt(batch.sequence) !== expected) break;
        contiguous.push(batch);
        expected++;
      }
      if (batches.length && !contiguous.length) {
        await this.fail(generation, leaseEpoch, 'source-gap');
        return { relayBatches: 0, signals: 0, checkpoint: basis.checkpoint, snapshotComplete: false,
          failed: 'source-gap' };
      }
      batches = contiguous;
      if (batches.length) {
        events = (await relay.query(`SELECT event_id, sequence::text, envelope FROM relay.delivered_event
          WHERE source = $1 AND data_epoch = $2 AND sequence BETWEEN $3::numeric AND $4::numeric`,
        [RELAY_SOURCE, basis.data_epoch, batches[0]!.sequence, batches.at(-1)!.sequence])).rows;
      }
    } catch (error) {
      if (error instanceof RecommendationStale) throw error;
      throw new RecommendationUnavailable('relay retention is unavailable');
    }
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.sequence, (counts.get(event.sequence) ?? 0) + 1);
    if (batches.some(batch => (counts.get(batch.sequence) ?? 0) !== batch.event_count)) {
      await this.fail(generation, leaseEpoch, 'source-incomplete');
      return { relayBatches: 0, signals: 0, checkpoint: basis.checkpoint, snapshotComplete: false,
        failed: 'source-incomplete' };
    }
    events.sort((a, b) => {
      const order = BigInt(a.sequence) - BigInt(b.sequence);
      return order !== 0n ? (order < 0n ? -1 : 1) : (a.envelope.data?.ordinal ?? 0) - (b.envelope.data?.ordinal ?? 0);
    });
    // Only succeeded, validated observation changes are admitted signals.
    const signals: SlotSignal[] = [];
    for (const event of events) {
      if (event.envelope.type !== OBSERVATION_CHANGED) continue;
      const receipt = event.envelope.data?.receipt ?? {};
      if (receipt.action !== 'rating.observation.set' || receipt.outcome !== 'succeeded') continue;
      const { work, realm, ratingSlot, ratingObservation, ratingAvailability, ratingValue,
        admissionId, requestDigest, authorityEpoch } = receipt as Record<string, unknown>;
      const valid = typeof work === 'string' && nativeIri.test(work) && typeof realm === 'string'
        && nativeIri.test(realm) && typeof ratingSlot === 'string' && slotPattern.test(ratingSlot)
        && typeof ratingObservation === 'string' && nativeIri.test(ratingObservation)
        && typeof admissionId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admissionId)
        && typeof requestDigest === 'string' && /^[0-9a-f]{64}$/.test(requestDigest)
        && typeof authorityEpoch === 'string' && /^\d+$/.test(authorityEpoch)
        && ((ratingAvailability === 'available' && Number.isInteger(ratingValue)
          && (ratingValue as number) >= 1 && (ratingValue as number) <= 10)
          || (ratingAvailability === 'withdrawn' && ratingValue === undefined));
      if (!valid) {
        await this.fail(generation, leaseEpoch, 'source-invalid');
        return { relayBatches: 0, signals: 0, checkpoint: basis.checkpoint, snapshotComplete: false,
          failed: 'source-invalid' };
      }
      if (basis.population === 'realm' && realm !== basis.realm) continue;
      signals.push({ slot: ratingSlot as string, candidate: work as string, sequence: event.sequence,
        event: event.event_id, admission: admissionId as string, requestDigest: requestDigest as string,
        authorityEpoch: authorityEpoch as string,
        weight: ratingAvailability === 'available' ? BigInt(ratingValue as number) : 0n });
    }
    const last = batches.at(-1)?.sequence ?? basis.checkpoint;
    return inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      await fenceLease(client, generation, leaseEpoch, this.leaseMs);
      const admissions = signals.length ? (await client.query<{ id: string; principal_id: string;
        account_issuer: string; account_subject: string; request_digest: string; authority_epoch: string;
        graph_data_epoch: string; graph_sequence: string }>(`SELECT a.id::text, a.principal_id::text,
          p.account_issuer, p.account_subject, a.request_digest, a.authority_epoch::text,
          a.graph_data_epoch, a.graph_sequence FROM access.admission a
          JOIN access.principal p ON p.id = a.principal_id
          WHERE a.id = ANY($1::uuid[]) AND a.action = 'rating.observation.set'
            AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'`,
        [[...new Set(signals.map(signal => signal.admission))]])).rows : [];
      const byAdmission = new Map(admissions.map(row => [row.id, row]));
      for (const signal of signals) {
        const owner = byAdmission.get(signal.admission);
        if (!owner || owner.request_digest !== signal.requestDigest
          || owner.authority_epoch !== signal.authorityEpoch
          || owner.graph_data_epoch !== basis.data_epoch || owner.graph_sequence !== signal.sequence) {
          throw new RecommendationUnavailable('rating contributor admission is unavailable');
        }
        signal.contributor = owner.principal_id;
      }
      let erasedContributors = new Set<string>();
      if (admissions.length) {
        try {
          erasedContributors = new Set((await this.options.relay.query<{ account_issuer: string;
            account_subject: string }>(`SELECT e.account_issuer, e.account_subject FROM relay.erasure e
              JOIN unnest($1::text[], $2::text[]) subject(issuer, account_subject)
                ON e.account_issuer = subject.issuer AND e.account_subject = subject.account_subject
              WHERE e.kind = 'account' AND e.stage <> 'blocked'`,
          [admissions.map(row => row.account_issuer), admissions.map(row => row.account_subject)]))
            .rows.map(row => `${row.account_issuer}\0${row.account_subject}`));
        } catch { throw new RecommendationUnavailable('erasure journal is unavailable'); }
      }
      const admitted = signals.filter(signal => {
        const owner = byAdmission.get(signal.admission)!;
        return (basis.population !== 'personal' || owner.principal_id === basis.principal_id)
          && !erasedContributors.has(`${owner.account_issuer}\0${owner.account_subject}`);
      });
      const latest = new Map<string, SlotSignal>();
      for (const signal of admitted) latest.set(signal.slot, signal);
      if (latest.size) await this.apply(client, generation, basis.partition_count, [...latest.values()]);
      const advanced = await client.query<{ complete: boolean }>(`UPDATE access.derived_generation_input
        SET checkpoint_sequence = $3::numeric, checkpoint_event = $4,
          snapshot_complete = snapshot_complete OR $3::numeric >= $5::numeric
        WHERE generation_id = $1 AND source = 'main-graph' AND checkpoint_sequence = $2::numeric
        RETURNING snapshot_complete AS complete`,
      [generation, basis.checkpoint, last, `relay-batch:${last}`, basis.target]);
      if (advanced.rowCount !== 1) throw new RecommendationStale('checkpoint moved');
      return { relayBatches: batches.length, signals: latest.size, checkpoint: last,
        snapshotComplete: advanced.rows[0]!.complete };
    });
  }

  /** One slot write, one score write and one partition write per touched key, whatever the event count. */
  private async apply(client: PoolClient, generation: string, partitionCount: number,
    slots: SlotSignal[]): Promise<void> {
    const previous = new Map((await client.query<{ slot: string; candidate: string; weight: string }>(
      `SELECT slot, candidate, weight::text FROM access.ranking_signal_slot
       WHERE generation_id = $1 AND slot = ANY($2::text[])`, [generation, slots.map(slot => slot.slot)]))
      .rows.map(row => [row.slot, row]));
    const delta = new Map<string, Totals>();
    const bump = (candidate: string, score: bigint, signals: bigint) => {
      const current = delta.get(candidate) ?? { score: 0n, signals: 0n };
      delta.set(candidate, { score: current.score + score, signals: current.signals + signals });
    };
    for (const slot of slots) {
      const old = previous.get(slot.slot);
      if (old) bump(old.candidate, -BigInt(old.weight), BigInt(old.weight) > 0n ? -1n : 0n);
      bump(slot.candidate, slot.weight, slot.weight > 0n ? 1n : 0n);
    }
    await client.query(`INSERT INTO access.ranking_signal_slot
      (generation_id, slot, candidate, weight, source_sequence, source_event, contributor_principal_id)
      SELECT $1, * FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::uuid[])
      ON CONFLICT (generation_id, slot) DO UPDATE SET candidate = EXCLUDED.candidate,
        weight = EXCLUDED.weight, source_sequence = EXCLUDED.source_sequence,
        source_event = EXCLUDED.source_event, contributor_principal_id = EXCLUDED.contributor_principal_id`,
    [generation, slots.map(slot => slot.slot), slots.map(slot => slot.candidate),
      slots.map(slot => slot.weight.toString()), slots.map(slot => slot.sequence), slots.map(slot => slot.event),
      slots.map(slot => slot.contributor)]);
    const candidates = [...delta.keys()];
    const current = new Map((await client.query<{ candidate: string; score: string; signal_count: string }>(
      `SELECT candidate, score::text, signal_count::text FROM access.ranking_score
       WHERE generation_id = $1 AND candidate = ANY($2::text[])`, [generation, candidates])).rows
      .map(row => [row.candidate, { score: BigInt(row.score), signals: BigInt(row.signal_count) }]));
    const upsert: { partition: number; candidate: string; score: bigint; signals: bigint }[] = [];
    const removed: string[] = [];
    const partitions = new Map<number, { candidates: bigint; signals: bigint; score: bigint }>();
    for (const [candidate, change] of delta) {
      const before = current.get(candidate) ?? { score: 0n, signals: 0n };
      const after = { score: before.score + change.score, signals: before.signals + change.signals };
      if (after.score < 0n || after.signals < 0n || (after.score === 0n) !== (after.signals === 0n)) {
        throw new RecommendationStale('ranking signal totals are inconsistent');
      }
      const partition = partitionOf(candidate, partitionCount);
      const total = partitions.get(partition) ?? { candidates: 0n, signals: 0n, score: 0n };
      total.candidates += (after.score > 0n ? 1n : 0n) - (before.score > 0n ? 1n : 0n);
      total.signals += change.signals;
      total.score += change.score;
      partitions.set(partition, total);
      if (after.score > 0n) upsert.push({ partition, candidate, ...after });
      else if (before.score > 0n) removed.push(candidate);
    }
    if (upsert.length) {
      await client.query(`INSERT INTO access.ranking_score (generation_id, partition, candidate, score, signal_count)
        SELECT $1, * FROM unnest($2::smallint[], $3::text[], $4::numeric[], $5::bigint[])
        ON CONFLICT (generation_id, candidate) DO UPDATE SET score = EXCLUDED.score,
          signal_count = EXCLUDED.signal_count`,
      [generation, upsert.map(row => row.partition), upsert.map(row => row.candidate),
        upsert.map(row => row.score.toString()), upsert.map(row => row.signals.toString())]);
    }
    if (removed.length) {
      await client.query('DELETE FROM access.ranking_score WHERE generation_id = $1 AND candidate = ANY($2::text[])',
        [generation, removed]);
    }
    const touched = [...partitions.entries()];
    await client.query(`UPDATE access.ranking_partition p SET candidate_count = p.candidate_count + d.candidates,
        signal_count = p.signal_count + d.signals, score_total = p.score_total + d.score
      FROM unnest($2::smallint[], $3::bigint[], $4::bigint[], $5::numeric[]) d(partition, candidates, signals, score)
      WHERE p.generation_id = $1 AND p.partition = d.partition`,
    [generation, touched.map(([partition]) => partition), touched.map(([, total]) => total.candidates.toString()),
      touched.map(([, total]) => total.signals.toString()), touched.map(([, total]) => total.score.toString())]);
  }

  /** Ready only after catch-up to the current relay head and a partition-total validation. */
  async finish(generation: string, leaseEpoch: string): Promise<GenerationView> {
    const head = await this.relayHead();
    return inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      await fenceLease(client, generation, leaseEpoch, this.leaseMs);
      const input = (await client.query<{ checkpoint: string; complete: boolean; data_epoch: string }>(`SELECT
        checkpoint_sequence::text AS checkpoint, snapshot_complete AS complete, data_epoch
        FROM access.derived_generation_input WHERE generation_id = $1 AND source = 'main-graph'`,
      [generation])).rows[0]!;
      if (input.data_epoch !== this.options.dataEpoch) {
        throw new RecommendationStale('generation belongs to another source epoch');
      }
      if (!input.complete || BigInt(input.checkpoint) < BigInt(head)) {
        throw new RecommendationNotReady('generation has not caught up with the relay');
      }
      const partitions = (await client.query<{ partition: number; candidates: string; signals: string;
        score: string; valid: boolean }>(`SELECT p.partition, p.candidate_count::text AS candidates,
          p.signal_count::text AS signals, p.score_total::text AS score,
          p.candidate_count = count(s.candidate) AND p.signal_count = coalesce(sum(s.signal_count), 0)
            AND p.score_total = coalesce(sum(s.score), 0) AS valid
        FROM access.ranking_partition p LEFT JOIN access.ranking_score s
          ON s.generation_id = p.generation_id AND s.partition = p.partition
        WHERE p.generation_id = $1 GROUP BY p.partition, p.candidate_count, p.signal_count, p.score_total
        ORDER BY p.partition`, [generation])).rows;
      if (partitions.some(row => !row.valid)) {
        await markFailed(client, generation, leaseEpoch, 'validation-mismatch');
        return this.describe(client, generation);
      }
      const validation = digest({ checkpoint: input.checkpoint, partitions: partitions
        .map(({ partition, candidates, signals, score }) => ({ partition, candidates, signals, score })) });
      const ready = await client.query(`UPDATE access.derived_generation SET state = 'ready',
        lease_expires_at = NULL, validation_digest = $3, ready_at = clock_timestamp()
        WHERE id = $1 AND lease_epoch = $2 AND state = 'building'`, [generation, leaseEpoch, validation]);
      if (ready.rowCount !== 1) throw new RecommendationStale('build lease is no longer held');
      return this.describe(client, generation);
    });
  }

  async activate(context: ManageContext, generation: string, expectedHeadRevision: string | null,
    receipt: ReceiptKey): Promise<Activation> {
    if (this.options.verifySemantic) {
      await inAccess(this.options.access, async client => {
        await requireRecoveryOpen(client);
        await authorizeManager(client, context);
      });
      let manifest: { basis: RankingBasis } | undefined;
      try {
        manifest = (await this.options.access.query<{ basis: RankingBasis }>(`SELECT
          input_manifest->'basis' AS basis FROM access.derived_generation
          WHERE id = $1 AND family = 'ranking'`, [generation])).rows[0];
      } catch { throw new RecommendationUnavailable('Access owner is unavailable'); }
      if (manifest?.basis?.semantic && !await this.options.verifySemantic(context, manifest.basis)) {
        throw new RecommendationStale('ranking semantic basis changed');
      }
    }
    return inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      const principalId = await authorizeManager(client, context);
      await this.requireCurrentEpoch(client, generation);
      const family = (await client.query<{ family: string }>(
        'SELECT family FROM access.derived_generation WHERE id = $1', [generation])).rows[0];
      if (family?.family !== 'ranking') throw new RecommendationMissing('generation is unavailable');
      return activateHead(client, principalId, receipt, generation, expectedHeadRevision);
    });
  }

  private seal(token: object): string {
    const plain = Buffer.from(JSON.stringify(token), 'utf8');
    if (plain.length > CURSOR_BYTES) throw new RecommendationUnavailable('cursor exceeds its bound');
    const padded = Buffer.concat([plain, Buffer.alloc(CURSOR_BYTES - plain.length, 0x20)]);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.options.cursorKey, iv);
    const body = Buffer.concat([cipher.update(padded), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  }

  private open(value: string): CursorToken {
    try {
      const raw = Buffer.from(value, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.options.cursorKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
      return JSON.parse(plain.toString('utf8').trimEnd()) as CursorToken;
    } catch { throw new RecommendationRestart('continuation is not valid'); }
  }

  /** First page from the active generation, or the next page of the cursor's own generation. */
  async page(viewer: RankingViewer, basis: RankingBasis, pageSize: number,
    continuation?: string): Promise<RankingPage> {
    validBasis(basis);
    if (!viewer.principal && (basis.population.kind !== 'public' || basis.semantic)) throw new RecommendationDenied('Public viewer requires public ranking');

    if (basis.semantic && this.options.verifySemantic
      && !await this.options.verifySemantic(viewer, basis)) {
      if (continuation) throw new RecommendationRestart('ranking semantic basis changed');
      throw new RecommendationMissing('ranking semantic basis is unavailable');
    }
    if ((viewer.principal && !nativeIri.test(viewer.actingSubject)) || !Number.isInteger(pageSize)
      || pageSize < 1 || pageSize > MAX_RANKING_PAGE) {
      throw new RecommendationDenied('ranking page request is not admitted');
    }
    try {
      const erasedViewer = viewer.principal ? await this.options.relay.query(`SELECT 1 FROM relay.erasure
        WHERE kind = 'account' AND account_issuer = $1 AND account_subject = $2
          AND stage <> 'blocked' LIMIT 1`, [viewer.principal.issuer, viewer.principal.subject]) : null;
      if (erasedViewer?.rowCount) throw new RecommendationMissing('ranking viewer is unavailable');
    } catch (error) {
      if (error instanceof RecommendationMissing) throw error;
      throw new RecommendationUnavailable('erasure journal is unavailable');
    }
    const viewerDigest = digest({ issuer: viewer.principal?.issuer ?? null, subject: viewer.principal?.subject ?? null,
      actingSubject: viewer.actingSubject });
    const basisDigest = digest(basis);
    const token = continuation === undefined ? undefined : this.open(continuation);
    if (token && (token.v !== 1 || token.viewer !== viewerDigest || token.basis !== basisDigest
      || token.expiresAt < Date.now())) {
      throw new RecommendationRestart('continuation does not match this query');
    }
    const scanLimit = pageSize * 2;
    const window = await inAccess(this.options.access, async client => {
      await requireRecoveryOpen(client);
      let owner: string | null = null;
      if (basis.population.kind === 'personal') {
        owner = (await client.query<{ id: string }>(`SELECT id FROM access.principal
          WHERE account_issuer = $1 AND account_subject = $2 AND active`,
        [viewer.principal!.issuer, viewer.principal!.subject])).rows[0]?.id ?? null;
        if (!owner) throw new RecommendationMissing('no active ranking');
      }
      const scope = scopeKey(basis, owner, this.options.dataEpoch);
      let generation: string;
      if (token) {
        const retained = (await client.query(`SELECT 1 FROM access.derived_generation
          WHERE id = $1 AND family = 'ranking' AND scope_key = $2 AND state IN ('ready', 'superseded')`,
        [token.generation, scope])).rows[0];
        if (!retained) throw new RecommendationRestart('generation is no longer retained');
        generation = token.generation;
      } else {
        const head = (await client.query<{ active_generation: string }>(`SELECT active_generation::text
          FROM access.derived_generation_head WHERE family = 'ranking' AND scope_key = $1`, [scope])).rows[0];
        // Declared fallback for this profile is none: no active generation is not an empty ranking.
        if (!head) throw new RecommendationMissing('no active ranking');
        generation = head.active_generation;
      }
      // Order on the numeric column; the text form only carries it exactly to the cursor.
      const rows = token?.after.score === '0' ? [] : (await client.query<{ candidate: string; score: string }>(token
        ? `SELECT candidate, score::text AS score FROM (
             (SELECT candidate, score FROM access.ranking_score
              WHERE generation_id = $1 AND score = $2::numeric AND candidate > $3
              ORDER BY candidate LIMIT $4)
             UNION ALL
             (SELECT candidate, score FROM access.ranking_score
              WHERE generation_id = $1 AND score < $2::numeric
              ORDER BY score DESC, candidate LIMIT $4)) next
           ORDER BY next.score DESC, next.candidate LIMIT $4`
        : `SELECT candidate, score::text AS score FROM (SELECT candidate, score FROM access.ranking_score
             WHERE generation_id = $1 ORDER BY score DESC, candidate LIMIT $2) first
           ORDER BY first.score DESC, first.candidate`,
      token ? [generation, token.after.score, token.after.candidate, scanLimit + 1]
        : [generation, scanLimit + 1])).rows;
      const source = (await client.query<{ target: string; erasure_epoch: string;
        zero_snapshot: string | null }>(`SELECT
        input_manifest->'source'->>'snapshotTarget' AS target,
        input_manifest->'source'->>'erasureEpoch' AS erasure_epoch,
        input_manifest->'source'->>'zeroSnapshot' AS zero_snapshot
        FROM access.derived_generation WHERE id = $1`, [generation])).rows[0];
      return { generation, rows, zeroSnapshot: source?.zero_snapshot ?? null,
        erasureEpoch: source?.erasure_epoch ?? '0' };
    });
    await this.assertContributorsCurrent(window.generation, window.erasureEpoch);
    // A zero tail starts only after the positive window is exhausted. The graph
    // window is bounded by the same candidate budget and retains IRI ordering.
    let rows = window.rows;
    if (this.options.zeroCandidates && window.zeroSnapshot !== null && rows.length <= scanLimit) {
      const after = token?.after.score === '0' ? token.after.candidate : null;
      let zero: string[];
      try {
        zero = await this.options.zeroCandidates(after, window.zeroSnapshot, scanLimit - rows.length + 1);
      } catch { throw new RecommendationUnavailable('zero-score candidate source is unavailable'); }
      rows = [...rows, ...zero.map(candidate => ({ candidate, score: '0' }))];
    }
    const scanned = rows.slice(0, scanLimit);
    const scoredZero = scanned.filter(row => row.score === '0').map(row => row.candidate);
    const scored = scoredZero.length ? new Set((await inAccess(this.options.access, async client =>
      (await client.query<{ candidate: string }>(`SELECT candidate FROM access.ranking_score
        WHERE generation_id = $1 AND candidate = ANY($2::text[])`, [window.generation, scoredZero])).rows))
      .map(row => row.candidate)) : new Set<string>();
    const erased = await this.erased(scanned.map(row => row.candidate));
    let unverified: ReadonlySet<string> = new Set();
    try { unverified = await this.options.unverifiedWorks?.(scanned.map(row => row.candidate)) ?? unverified; }
    catch { throw new RecommendationUnavailable('candidate verification is unavailable'); }
    const items: { candidate: string }[] = [];
    let examined: { candidate: string; score: string } | undefined;
    for (const row of scanned) {
      if (items.length === pageSize) break;
      examined = row;
      if (row.score === '0' && scored.has(row.candidate)) continue;
      if (erased.has(row.candidate)) continue;
      if (unverified.has(row.candidate)) continue;
      let visible: boolean;
      try {
        visible = viewer.principal ? await this.options.canReadWork(viewer.principal, viewer.actingSubject!, row.candidate) : true;
      } catch { throw new RecommendationUnavailable('candidate disclosure is unavailable'); }
      if (visible) items.push({ candidate: row.candidate });
    }
    const more = examined !== undefined && (examined !== scanned.at(-1) || rows.length > scanLimit);
    return { generation: window.generation, items, continuation: more && examined ? this.seal({ v: 1,
      generation: window.generation, viewer: viewerDigest, basis: basisDigest,
      after: { score: examined.score, candidate: examined.candidate },
      expiresAt: Date.now() + CURSOR_TTL_MS } satisfies CursorToken) : null };
  }

  /** A new Account erasure makes a generation with that contributor unavailable immediately. */
  private async assertContributorsCurrent(generation: string, since: string): Promise<void> {
    let erased: { account_issuer: string; account_subject: string }[];
    try {
      erased = (await this.options.relay.query<{ account_issuer: string; account_subject: string }>(
        `SELECT account_issuer, account_subject FROM relay.erasure
         WHERE kind = 'account' AND stage <> 'blocked' AND erasure_epoch > $1::bigint
         ORDER BY erasure_epoch LIMIT 65`, [since])).rows;
    } catch { throw new RecommendationUnavailable('erasure journal is unavailable'); }
    if (!erased.length) return;
    if (erased.length > 64) throw new RecommendationRestart('ranking contributor fence needs a rebuild');
    const affected = await inAccess(this.options.access, async client => {
      const legacy = await client.query(`SELECT 1 FROM access.ranking_signal_slot
        WHERE generation_id = $1 AND contributor_principal_id IS NULL LIMIT 1`, [generation]);
      if (legacy.rowCount) return true;
      const principalIds = (await client.query<{ id: string }>(`SELECT p.id::text FROM access.principal p
        JOIN unnest($1::text[], $2::text[]) e(issuer, subject)
          ON p.account_issuer = e.issuer AND p.account_subject = e.subject`,
      [erased.map(row => row.account_issuer), erased.map(row => row.account_subject)])).rows
        .map(row => row.id);
      if (!principalIds.length) return false;
      return !!(await client.query(`SELECT 1 FROM access.ranking_signal_slot
        WHERE generation_id = $1 AND contributor_principal_id = ANY($2::uuid[]) LIMIT 1`,
      [generation, principalIds])).rowCount;
    });
    if (affected) throw new RecommendationRestart('ranking contributor fence needs a rebuild');
  }

  /** Erasure journal recheck at delivery: any unblocked resource erasure withholds the candidate. */
  private async erased(candidates: string[]): Promise<Set<string>> {
    if (!candidates.length) return new Set();
    try {
      return new Set((await this.options.relay.query<{ target_ref: string }>(`SELECT DISTINCT t.target_ref
        FROM relay.erasure_target t JOIN relay.erasure e ON e.id = t.erasure_id
        WHERE t.owner = 'graph' AND t.target_kind = 'resource' AND t.target_ref = ANY($1::text[])
          AND e.stage <> 'blocked'`, [candidates])).rows.map(row => row.target_ref));
    } catch { throw new RecommendationUnavailable('erasure journal is unavailable'); }
  }

  /** Bounded retention purge of an expired generation's derived rows. */
  async purgeExpired(generation: string, limit = 1000): Promise<number> {
    return inAccess(this.options.access, async client => {
      const state = (await client.query<{ state: string }>(
        'SELECT state FROM access.derived_generation WHERE id = $1 FOR SHARE', [generation])).rows[0]?.state;
      if (state !== 'expired') throw new RecommendationStale('only expired generations are purged');
      const slots = await client.query(`DELETE FROM access.ranking_signal_slot WHERE generation_id = $1
        AND slot IN (SELECT slot FROM access.ranking_signal_slot WHERE generation_id = $1 LIMIT $2)`,
      [generation, limit]);
      const scores = await client.query(`DELETE FROM access.ranking_score WHERE generation_id = $1
        AND candidate IN (SELECT candidate FROM access.ranking_score WHERE generation_id = $1 LIMIT $2)`,
      [generation, limit]);
      return (slots.rowCount ?? 0) + (scores.rowCount ?? 0);
    });
  }
}

interface CursorToken {
  v: 1; generation: string; viewer: string; basis: string;
  after: { score: string; candidate: string }; expiresAt: number;
}
