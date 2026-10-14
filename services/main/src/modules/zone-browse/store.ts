import type { Pool, PoolClient } from 'pg';
import { logWorkerFault, telemetryLog } from '@rezics/observability/log';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadUnavailable, type ReadPosition } from '../work/read-session.ts';
import { compareRelayPositions, MAIN_RELAY_STREAM_SCOPE, RelayHandoffPositions, type RelayHandoffPosition } from '../outbox/relay-position.ts';
import { classifyDeliveredRelayBatch, OutboxGap, readMainOutboxEnvelope, readNextMainOutboxBatch, type CustodiedOutbox } from '../outbox/relay.ts';

export const ZONE_BROWSE_PROJECTION_COST = {
  batch: 64, relayEvents: 64, relayBatches: 16, pollMs: 500, recoveryPageMs: 5_000,
  recoveryPassPages: 128, recoveryPassMs: 30_000,
  recoveryRetries: 3, recoveryWaitMs: 30_000,
} as const;
const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAIN_RELAY_SOURCE = 'https://rezics.com/services/main';
export interface BrowseEntry { work: string; adoptedOrder: string; updatedAt: string | null; words: number | null }
export interface BrowseAfter { work: string; key: string | null }
type ProjectionKey = { realm: string; work: string };
type GraphCut = ReadPosition & { relaySequence: string };
interface Reconciliation {
  cut: GraphCut;
  coverage: RelayHandoffPosition;
  epochs: string;
  phase: 'project' | 'prune';
  after?: ProjectionKey;
}
type RelayEventRow = { stream_scope: string; data_epoch: string; event_id: string; envelope: {
  type: string; data?: { receipt?: { outcome?: string; realm?: string; work?: string } } } };
type CustodyLookup = { supplied: boolean; found: boolean };
export interface ZoneBrowseRecoveryStatus {
  state: 'ready' | 'reconciling' | 'waiting-for-cut' | 'incomplete-healing';
  deferral?: { code: 'main_relay_handoff_incomplete'; retries: number; intervalMs: number };
  attempts: number;
  retryAfterMs: number;
  checkpoint: RelayHandoffPosition;
}
export interface BrowseEntryReader {
  current(position: ReadPosition): boolean | Promise<boolean>;
  batch(realm: string, sort: 'newest' | 'updated', after: BrowseAfter | null, position?: ReadPosition): Promise<BrowseEntry[]>;
}

/** One index seek per batch, O(log N + 64), O(64) memory. RDF remains the
 * disclosure authority. The table contains candidates, never public counts. */
export class ZoneBrowseProjection implements BrowseEntryReader {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;
  private usableCut = false;
  private checkpoint: RelayHandoffPosition;
  private verifiedCoverage: RelayHandoffPosition;
  private afterEvent: string | null = null;
  private reconciliation: Reconciliation | undefined;
  private recoveryAttempts = 0;
  private retryAfter = 0;
  private recoveryProbe: GraphCut | undefined;
  private handoffRetries = 0;
  private handoffDeferred = false;
  constructor(private readonly access: Pool, private readonly relay: Pool,
    private readonly env: WorkActivationEnvironment, private readonly relayConsumer?: string) {
    this.checkpoint = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: env.lineage.dataEpoch, sequence: '0' };
    this.verifiedCoverage = { ...this.checkpoint };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.zone-browse.projection', () => withWorkerTelemetry<number | void>('main.zone-browse.projection', async () => this.usableCut ? this.catchUp() : this.reconcilePage(), count => ({
        outcome: ['waiting-for-cut', 'incomplete-healing'].includes(this.recoveryStatus().state) ? 'deferred'
          : count === undefined ? 'completed' : count ? 'worked' : 'idle',
        ...(count === undefined ? {} : { processed: count, unit: 'event' as const }),
      })))
        .catch(error => { logWorkerFault('main.zone-browse.projection', error); })
        .finally(() => { this.running = undefined; });
    }, ZONE_BROWSE_PROJECTION_COST.pollMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async epochs(): Promise<string> {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?prior WHERE {
      GRAPH ${iri(GRAPHS.control)} { ?cutover a rv:RestoreCutover ;
        rv:dataEpoch ?epoch ; rv:priorDataEpoch ?prior . } } LIMIT 33`, 8192)).results?.bindings ?? [];
    if (rows.length > 32) throw new WorkReadUnavailable('Zone browse restore lineage exceeds its budget');
    const prior = new Map<string, string>();
    for (const row of rows) {
      if (!row.epoch || !row.prior || prior.has(row.epoch.value)
        && prior.get(row.epoch.value) !== row.prior.value) throw new WorkReadUnavailable('Zone browse lineage is ambiguous');
      prior.set(row.epoch.value, row.prior.value);
    }
    // Absolute retained-lineage ranks stay stable when a restore adds an epoch.
    // Existing adoption keys remain immutable, so newest continuations may
    // cross later selections while every disclosure is checked live.
    const epochs: string[] = [];
    let epoch: string | undefined = this.env.lineage.dataEpoch;
    while (epoch) {
      if (epochs.includes(epoch)) throw new WorkReadUnavailable('Zone browse lineage contains a cycle');
      epochs.push(epoch);
      epoch = prior.get(epoch);
    }
    return `VALUES (?epoch ?epochOrder) { ${epochs.map((value, index) => `(${lit(value)} ${epochs.length - index})`).join(' ')} }`;
  }

  private checkDeadline(deadline?: number): void {
    if (deadline !== undefined && performance.now() >= deadline) {
      throw new WorkReadUnavailable('Zone browse reconciliation page exceeded its time budget');
    }
  }

  private async poolPage<T>(pool: Pool, deadline: number | undefined, apply: (client: PoolClient) => Promise<T>): Promise<T> {
    this.checkDeadline(deadline);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (deadline !== undefined) {
        await client.query("SET LOCAL lock_timeout = '1s'");
        await client.query("SET LOCAL statement_timeout = '2s'");
        await client.query("SET LOCAL transaction_timeout = '5s'");
      }
      this.checkDeadline(deadline);
      const result = await apply(client);
      this.checkDeadline(deadline);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async project(where: string, epochs: string, deadline?: number): Promise<ProjectionKey[]> {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT DISTINCT ?realm ?work ?sequence ?epochOrder WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} .
          FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
        ${epochs}
        { GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmPublicationSlot ;
            rv:realm ?realm ; rv:work ?work ; rv:selectionHead ?selection . }
          GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection } }
        UNION
        { GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmResourceSlot ;
            rv:realm ?realm ; rv:work ?work ; rv:selectionHead ?selection . }
          GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:RealmSubmissionSelection }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?publicationSlot a rv:RealmPublicationSlot ;
              rv:realm ?realm ; rv:work ?work ; rv:selectionHead ?publicationSelection . }
            GRAPH ${iri(GRAPHS.revisions)} { ?publicationSelection a rv:PublicationSelection } } }
        GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
        ${where}
      } ORDER BY STR(?realm) STR(?work) LIMIT ${ZONE_BROWSE_PROJECTION_COST.batch}`, 128 * 1024)).results?.bindings ?? [];
    if (rows.length > ZONE_BROWSE_PROJECTION_COST.batch) {
      throw new WorkReadUnavailable('Zone browse adoption page exceeds its bound');
    }
    const examined: ProjectionKey[] = [];
    if (!rows.length) return examined;
    await this.poolPage(this.access, deadline, async client => {
      // SerialStatisticsProjection holds this row FOR UPDATE while changing
      // summaries. Its triggers cannot race an adoption's initial stats copy.
      await client.query('SELECT generation FROM access.serial_stats_checkpoint WHERE singleton FOR SHARE');
      const candidates = rows.map(row => {
        const realm = row.realm?.value, work = row.work?.value;
        if (!realm || !work || !ID.test(realm) || !ID.test(work)
          || !/^\d{1,38}$/.test(row.sequence?.value ?? '') || !/^\d+$/.test(row.epochOrder?.value ?? '')) {
          throw new WorkReadUnavailable('Zone browse graph has a malformed adoption');
        }
        this.checkDeadline(deadline);
        examined.push({ realm, work });
        const order = BigInt(row.sequence!.value) + BigInt(row.epochOrder!.value) * 10n ** 38n;
        return { realm, work, adopted_order: order.toString() };
      });
      // The native seek already bounds this relation to 64 rows. Keep the
      // statistics lock and atomic page, without one network trip per Work.
      await client.query(`INSERT INTO access.zone_browse_entry (realm, work, adopted_order, updated_at, word_count)
        SELECT candidate.realm, candidate.work, candidate.adopted_order, s.last_updated_at, s.word_count
        FROM jsonb_to_recordset($1::jsonb) AS candidate(realm text, work text, adopted_order numeric)
        LEFT JOIN access.serial_stats_checkpoint c ON c.singleton
        LEFT JOIN LATERAL (
          SELECT last_updated_at, word_count FROM access.serial_summary
          WHERE generation = c.generation AND work = candidate.work LIMIT 1
        ) s ON true
        ON CONFLICT (realm, work) DO UPDATE SET updated_at = EXCLUDED.updated_at, word_count = EXCLUDED.word_count`,
      [JSON.stringify(candidates)]);
    });
    return examined;
  }

  /** Explicit preparation waits for a complete reconciliation, or refuses at
   * its budget. A later call resumes; the worker never drains in one poll. */
  async backfill(): Promise<void> {
    this.usableCut = false;
    const deadline = performance.now() + ZONE_BROWSE_PROJECTION_COST.recoveryPassMs;
    for (let page = 0; page < ZONE_BROWSE_PROJECTION_COST.recoveryPassPages; page++) {
      this.checkDeadline(deadline);
      await this.reconcilePage();
      if (this.usableCut) return;
      if (this.recoveryStatus().state === 'waiting-for-cut') {
        throw new WorkReadUnavailable('Zone browse recovery waiting for a stable cut');
      }
    }
    throw new WorkReadUnavailable('Zone browse reconciliation exceeded its preparation page budget');
  }

  /** One bounded reconciliation page per poll, also used after a relay gap.
   * A stable graph cut proves all pages describe the same authoritative state.
   * Partial pages remain unreadable and never move the relay checkpoint. */
  private async reconcilePage(): Promise<void> {
    this.usableCut = false;
    const deadline = performance.now() + ZONE_BROWSE_PROJECTION_COST.recoveryPageMs;
    await fusekiReadBudget.run({ signal: AbortSignal.timeout(ZONE_BROWSE_PROJECTION_COST.recoveryPageMs),
      callsLeft: 6, bytesLeft: 256 * 1024 }, async () => {
      if (this.retryAfter > performance.now()) {
        // Cool down expensive scans while writes continue, but observe their
        // cessation. This probe is only permission to retry: the full scan
        // and its before/after cut validation still prove readiness.
        const cut = await this.graphCut();
        const prior = this.recoveryProbe;
        this.recoveryProbe = cut;
        if (!prior || !this.sameCut(prior, cut)) return;
      }
      if (this.retryAfter) {
        this.retryAfter = 0;
        this.recoveryAttempts = 0;
        this.recoveryProbe = undefined;
      }
      const coverage = await this.mainStreamCoverage(deadline);
      // Delivery proof concerns retained relay history, not the moving graph.
      // Verify its prefix before capturing a source cut, and keep that work
      // across graph retries. A rewind or gap requires proving it anew.
      if (compareRelayPositions(this.verifiedCoverage, coverage) > 0) {
        this.verifiedCoverage = { ...coverage, sequence: '0' };
        this.reconciliation = undefined;
      }
      for (let batch = 0; batch < ZONE_BROWSE_PROJECTION_COST.relayBatches
        && BigInt(this.verifiedCoverage.sequence) < BigInt(coverage.sequence); batch++) {
        const sequence = String(BigInt(this.verifiedCoverage.sequence) + 1n);
        const classification = await this.classifyBatch(sequence, deadline);
        if (classification.state === 'incomplete-healing') { this.deferHandoff(sequence); return; }
        if (classification.state === 'gap-conflict') {
          return this.relayGap(classification.error.message, sequence, coverage,
            { supplied: Boolean(this.env.receiptCustody), found: false });
        }
        this.verifiedCoverage = { ...coverage, sequence };
        if (classification.events) break;
      }
      if (this.verifiedCoverage.sequence !== coverage.sequence) return;
      const cut = await this.graphCut();
      let state = this.reconciliation;
      if (!state) {
        if (BigInt(coverage.sequence) > BigInt(cut.relaySequence)) {
          throw new WorkReadUnavailable('Zone browse relay coverage exceeds authoritative Main cut');
        }
        state = { cut, coverage, epochs: await this.epochs(), phase: 'project' };
        this.reconciliation = state;
      }
      this.validateCut(state.cut, cut);
      this.checkDeadline(deadline);
      this.handoffDeferred = false;
      let complete = false;
      if (state.phase === 'project') {
        const after = state.after;
        const rows = await this.project(after ? `FILTER(STR(?realm) > ${lit(after.realm)}
          || (STR(?realm) = ${lit(after.realm)} && STR(?work) > ${lit(after.work)}))` : '', state.epochs, deadline);
        if (rows.length < ZONE_BROWSE_PROJECTION_COST.batch) {
          state.phase = 'prune';
          state.after = undefined;
        } else state.after = rows.at(-1)!;
      } else {
        const after = state.after;
        const candidates = await this.poolPage(this.access, deadline, async client => (await client.query<ProjectionKey>(
          `SELECT realm, work FROM access.zone_browse_entry
            ${after ? 'WHERE (realm, work) > ($1::text, $2::text)' : ''}
            ORDER BY realm, work LIMIT ${ZONE_BROWSE_PROJECTION_COST.batch}`,
          after ? [after.realm, after.work] : [])).rows);
        if (candidates.length) {
          const found = await this.project(`VALUES (?realm ?work) { ${candidates.map(row =>
            `(${iri(row.realm)} ${iri(row.work)})`).join(' ')} }`, state.epochs, deadline);
          const retained = new Set(found.map(row => `${row.realm}\n${row.work}`));
          await this.poolPage(this.access, deadline, async client => {
            for (const row of candidates) if (!retained.has(`${row.realm}\n${row.work}`)) {
              this.checkDeadline(deadline);
              await client.query('DELETE FROM access.zone_browse_entry WHERE realm = $1 AND work = $2',
                [row.realm, row.work]);
            }
          });
        }
        complete = candidates.length < ZONE_BROWSE_PROJECTION_COST.batch;
        state.after = candidates.at(-1);
      }
      // Deliveries below the captured acknowledgement can arrive late without changing
      // it: the validated graph already includes those effects. A new maximum
      // or graph mutation requires another scan, never a checkpoint jump.
      if (complete && compareRelayPositions(state.coverage, await this.mainStreamCoverage(deadline)) !== 0) {
        this.invalidateCut('Zone browse relay coverage changed during reconciliation');
      }
      this.validateCut(state.cut, await this.graphCut());
      this.checkDeadline(deadline);
      if (complete) {
        this.checkpoint = state.coverage;
        this.afterEvent = null;
        this.reconciliation = undefined;
        this.recoveryAttempts = 0;
        this.usableCut = true;
        this.handoffRetries = 0;
      }
    });
  }

  private validateCut(before: GraphCut, after: GraphCut): void {
    if (!this.sameCut(before, after)) {
      this.invalidateCut('Zone browse authoritative cut changed during reconciliation');
    }
  }

  private sameCut(before: GraphCut, after: GraphCut): boolean {
    return before.dataEpoch === after.dataEpoch && before.sequence === after.sequence
      && before.relaySequence === after.relaySequence;
  }

  /** Kernel's scoped native capture is not yet available to this reader.
   * Do not replace its source fence with count/max or invent another clock:
   * either can miss a removed selection or a new slot between pages. */
  private invalidateCut(reason: string): never {
    this.handoffDeferred = false;
    this.handoffRetries = 0;
    this.reconciliation = undefined;
    this.recoveryProbe = undefined;
    this.recoveryAttempts++;
    if (this.recoveryAttempts >= ZONE_BROWSE_PROJECTION_COST.recoveryRetries) {
      this.retryAfter = performance.now() + ZONE_BROWSE_PROJECTION_COST.recoveryWaitMs;
      telemetryLog('worker_run_deferred', 'warn', {
        'rezics.worker.name': 'main.zone-browse.projection',
        'error.code': 'zone_browse_recovery_waiting',
        'rezics.projection.recovery_state': 'waiting-for-cut',
        'rezics.projection.recovery_attempts': this.recoveryAttempts,
        'rezics.projection.recovery_retry_ms': ZONE_BROWSE_PROJECTION_COST.recoveryWaitMs,
        'rezics.projection.checkpoint_sequence': this.checkpoint.sequence,
        'rezics.relay.data_epoch': this.checkpoint.dataEpoch,
        'rezics.relay.routing_epoch': this.env.lineage.routingEpoch,
      });
    }
    throw new WorkReadUnavailable(reason);
  }

  recoveryStatus(): ZoneBrowseRecoveryStatus {
    return { state: this.handoffDeferred ? 'incomplete-healing' : this.usableCut ? 'ready' : this.retryAfter > performance.now() ? 'waiting-for-cut' : 'reconciling',
      attempts: this.recoveryAttempts, retryAfterMs: Math.max(0, Math.ceil(this.retryAfter - performance.now())),
      checkpoint: { ...this.checkpoint },
      ...(this.handoffDeferred ? { deferral: { code: 'main_relay_handoff_incomplete' as const,
        retries: this.handoffRetries, intervalMs: ZONE_BROWSE_PROJECTION_COST.pollMs } } : {}) };
  }

  private async mainStreamCoverage(deadline?: number): Promise<RelayHandoffPosition> {
    const read = async (client: Pool | PoolClient): Promise<RelayHandoffPosition | null> => {
      if (this.relayConsumer) return new RelayHandoffPositions(client, this.relayConsumer).read();
      const rows = (await client.query<{ stream_scope: string; data_epoch: string; sequence: string }>(
        'SELECT stream_scope, data_epoch, sequence::text AS sequence FROM relay.checkpoint')).rows;
      let maximum: RelayHandoffPosition | null = null;
      for (const row of rows) {
        const position = { streamScope: row.stream_scope, dataEpoch: row.data_epoch, sequence: row.sequence };
        if (position.streamScope !== MAIN_RELAY_STREAM_SCOPE || position.dataEpoch !== this.env.lineage.dataEpoch) {
          throw new WorkReadUnavailable('Zone browse Main stream coverage has a foreign position');
        }
        if (!maximum || compareRelayPositions(position, maximum) > 0) maximum = position;
      }
      return maximum;
    };
    const coverage = (deadline === undefined ? await read(this.relay)
      : await this.poolPage(this.relay, deadline, read))
      ?? { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: this.env.lineage.dataEpoch, sequence: '0' };
    if (coverage.streamScope !== MAIN_RELAY_STREAM_SCOPE || coverage.dataEpoch !== this.env.lineage.dataEpoch) {
      throw new WorkReadUnavailable('Zone browse Main stream coverage has a foreign position');
    }
    try { compareRelayPositions(coverage, coverage); }
    catch (error) { throw new WorkReadUnavailable('Zone browse Main stream coverage is invalid', { cause: error }); }
    return coverage;
  }

  private async graphCut(): Promise<GraphCut> {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence ?relaySequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} ; rv:sequence ?sequence .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ; rv:streamSequence ?relaySequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.sequence?.value ?? '')
      || !/^\d+$/.test(rows[0]?.relaySequence?.value ?? '')) {
      throw new WorkReadUnavailable('Zone browse graph cut is unavailable');
    }
    return { dataEpoch: this.env.lineage.dataEpoch, sequence: rows[0]!.sequence!.value,
      relaySequence: rows[0]!.relaySequence!.value };
  }

  /** Reuse the relay owner's exact native proof and envelope validation. A
   * slim command has no physical RDF header; custody is its existing owner. */
  private async custodiedBatch(lookup: CustodyLookup, sequence: string): Promise<CustodiedOutbox | null> {
    const custody = this.env.receiptCustody;
    if (!custody) return null;
    const ownerOutbox = { read: async (epoch: string, sequence: string) => {
      const retained = await custody.read(epoch, sequence);
      lookup.found ||= retained !== null;
      return retained;
    } };
    let batch;
    try {
      batch = await readNextMainOutboxBatch(this.env.fuseki, this.checkpoint.dataEpoch,
        String(BigInt(sequence) - 1n), ownerOutbox);
    } catch (error) {
      if (error instanceof OutboxGap) return null;
      throw error;
    }
    if (!batch?.custodiedReceipt) return null;
    const events: CustodiedOutbox['events'] = [];
    for (const eventId of batch.eventIds) {
      const envelope = await readMainOutboxEnvelope(this.env.fuseki, batch, eventId, undefined, ownerOutbox);
      if (envelope.source !== MAIN_RELAY_SOURCE) {
        throw new WorkReadUnavailable('Zone browse custodied event belongs to another source');
      }
      events.push(envelope);
    }
    return { batch, events };
  }

  private async classifyBatch(sequence: string, deadline?: number) {
    const custody: CustodyLookup = { supplied: Boolean(this.env.receiptCustody), found: false };
    const read = (client: Pool | PoolClient) => classifyDeliveredRelayBatch(client,
      { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: this.env.lineage.dataEpoch, sequence },
      { custody: () => this.custodiedBatch(custody, sequence) });
    return deadline === undefined ? read(this.relay) : this.poolPage(this.relay, deadline, read);
  }

  private async relayGap(message: string, expected: string, coverage: RelayHandoffPosition,
    custody: CustodyLookup): Promise<never> {
    const error = new WorkReadUnavailable(message);
    this.usableCut = false;
    this.handoffDeferred = false;
    this.handoffRetries = 0;
    this.reconciliation = undefined;
    const deadline = performance.now() + ZONE_BROWSE_PROJECTION_COST.recoveryPageMs;
    this.verifiedCoverage = { ...this.checkpoint, sequence: '0' };
    let minimum = 'unavailable', acknowledged = 'unavailable', committed = 'unavailable';
    let delivered = coverage.sequence;
    // Fault diagnostics must not hide the original gap if an owner is down.
    // No admitted retention floor is computed by the relay owner today; its
    // explicit absence is different from the first row we happen to retain.
    try {
      await this.poolPage(this.relay, deadline, async client => {
        const row = (await client.query<{ minimum_sequence: string | null; newest_delivered_sequence: string | null }>(
          `SELECT min(sequence)::text AS minimum_sequence, max(sequence)::text AS newest_delivered_sequence
            FROM relay.delivered_batch WHERE stream_scope = $1 AND data_epoch = $2`,
          [this.checkpoint.streamScope, this.checkpoint.dataEpoch])).rows[0];
        minimum = row?.minimum_sequence ?? 'absent';
        delivered = row?.newest_delivered_sequence ?? '0';
        const position = this.relayConsumer ? await new RelayHandoffPositions(client, this.relayConsumer).read() : null;
        if (position) {
          compareRelayPositions(this.checkpoint, position);
          acknowledged = position.sequence;
        } else acknowledged = 'absent';
      });
    } catch { /* bounded absence/unavailability is retained in the fault */ }
    try {
      committed = await fusekiReadBudget.run({ signal: AbortSignal.timeout(ZONE_BROWSE_PROJECTION_COST.recoveryPageMs),
        callsLeft: 1, bytesLeft: 8192 }, async () => (await this.graphCut()).relaySequence);
    } catch { /* a graph hold or changed epoch cannot suppress gap diagnostics */ }
    telemetryLog('worker_fault', 'error', {
      'rezics.worker.name': 'main.zone-browse.projection',
      'error.class': 'WorkReadUnavailable', 'error.code': error.code,
      'rezics.relay.requested_sequence': expected,
      'rezics.projection.checkpoint_sequence': this.checkpoint.sequence,
      'rezics.relay.data_epoch': this.checkpoint.dataEpoch,
      'rezics.relay.routing_epoch': this.env.lineage.routingEpoch ?? 'unavailable',
      'rezics.relay.retention_floor': 'absent',
      'rezics.relay.minimum_retained_sequence': minimum,
      'rezics.relay.newest_committed_sequence': committed,
      'rezics.relay.newest_delivered_sequence': delivered,
      'rezics.relay.acknowledged_sequence': acknowledged,
      'rezics.relay.custody_supplied': custody.supplied,
      'rezics.relay.custody_found': custody.found,
    });
    throw error;
  }

  private deferHandoff(sequence: string): number {
    this.handoffDeferred = true;
    this.handoffRetries++;
    recordWorkerOutcome({ outcome: 'deferred' });
    telemetryLog('worker_run_deferred', 'warn', {
      'rezics.worker.name': 'main.zone-browse.projection',
      'error.code': 'main_relay_handoff_incomplete',
      'rezics.relay.data_epoch': this.checkpoint.dataEpoch,
      'rezics.relay.requested_sequence': sequence,
      'rezics.projection.recovery_retry_ms': ZONE_BROWSE_PROJECTION_COST.pollMs,
      'rezics.projection.recovery_attempts': this.handoffRetries,
    });
    return 0;
  }

  async tick(): Promise<number> {
    if (!this.usableCut) { await this.reconcilePage(); return 0; }
    const coverage = await this.mainStreamCoverage();
    let covered: number;
    try { covered = compareRelayPositions(this.checkpoint, coverage); }
    catch (error) { throw new WorkReadUnavailable('Zone browse checkpoint belongs to another Main stream', { cause: error }); }
    if (covered > 0) return this.deferHandoff(this.checkpoint.sequence);
    if (covered === 0) { this.handoffDeferred = false; this.handoffRetries = 0; return 0; }

    const expected = (BigInt(this.checkpoint.sequence) + 1n).toString();
    const classification = await this.classifyBatch(expected);
    if (classification.state === 'incomplete-healing') return this.deferHandoff(expected);
    if (classification.state === 'gap-conflict') return this.relayGap(classification.error.message,
      expected, coverage, { supplied: Boolean(this.env.receiptCustody), found: false });
    this.handoffDeferred = false;
    this.handoffRetries = 0;
    const batchPosition: RelayHandoffPosition = { streamScope: classification.header.stream_scope,
      dataEpoch: classification.header.data_epoch, sequence: classification.header.sequence };
    const rows: RelayEventRow[] = classification.events ? classification.events
      .map(envelope => ({ stream_scope: batchPosition.streamScope, data_epoch: batchPosition.dataEpoch,
        event_id: envelope.id, envelope }))
      .filter(row => this.afterEvent === null || row.event_id > this.afterEvent).sort((a,b) => a.event_id.localeCompare(b.event_id))
      : (await this.relay.query<RelayEventRow>(`
      SELECT stream_scope, data_epoch, event_id, envelope FROM relay.delivered_event
      WHERE stream_scope = $1 AND source = $2 AND data_epoch = $3 AND sequence = $4::numeric
        AND ($5::text IS NULL OR event_id > $5::text)
      ORDER BY event_id LIMIT $6`,
    [batchPosition.streamScope, MAIN_RELAY_SOURCE, batchPosition.dataEpoch, batchPosition.sequence,
      this.afterEvent, ZONE_BROWSE_PROJECTION_COST.relayEvents + 1])).rows;
    const events = rows.slice(0, ZONE_BROWSE_PROJECTION_COST.relayEvents);
    const epochs = events.length ? await this.epochs() : '';
    for (const row of events) {
      if (row.stream_scope !== MAIN_RELAY_STREAM_SCOPE || row.data_epoch !== this.env.lineage.dataEpoch) {
        throw new WorkReadUnavailable('Zone browse relay event belongs to another Main stream');
      }
      if (!row.envelope || typeof row.envelope.type !== 'string') {
        throw new WorkReadUnavailable('Zone browse relay event is malformed');
      }
      const receipt = row.envelope.data?.receipt;
      if (/(?:realm\.selection-changed|realm\.publication-suppressed|realm\.submission-selected|realm\.resource-selected)/.test(row.envelope.type)
        && !receipt?.outcome) {
        throw new WorkReadUnavailable('Zone browse relay event has no receipt');
      }
      if (/(?:realm\.selection-changed|realm\.publication-suppressed|realm\.submission-selected|realm\.resource-selected)/.test(row.envelope?.type ?? '')
        && receipt?.outcome === 'succeeded') {
        if (!receipt.realm || !receipt.work || !ID.test(receipt.realm) || !ID.test(receipt.work)) {
          throw new WorkReadUnavailable('Zone browse relay event has a malformed adoption');
        }
        const values = `VALUES (?realm ?work) { (${iri(receipt.realm)} ${iri(receipt.work)}) }`;
        const projected = await this.project(values, epochs);
        if (!projected.length) await this.access.query('DELETE FROM access.zone_browse_entry WHERE realm = $1 AND work = $2',
          [receipt.realm, receipt.work]);
      }
    }
    if (rows.length > ZONE_BROWSE_PROJECTION_COST.relayEvents) {
      this.afterEvent = events.at(-1)!.event_id;
    } else {
      this.checkpoint = batchPosition;
      this.afterEvent = null;
    }
    return events.length;
  }

  /** Drain up to 1,024 events per poll; a full batch never pays another 500 ms wait. */
  async catchUp(): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < ZONE_BROWSE_PROJECTION_COST.relayBatches; batch++) {
      const before = this.checkpoint.sequence, beforeEvent = this.afterEvent;
      const count = await this.tick();
      total += count;
      if (before === this.checkpoint.sequence && beforeEvent === this.afterEvent) break;
    }
    return total;
  }

  async current(position: ReadPosition): Promise<boolean> {
    // The read position is a graph diagnostic. Compare only Main stream
    // positions for projection coverage; the shared epoch remains a recovery fence.
    if (this.handoffDeferred || !this.usableCut || position.dataEpoch !== this.env.lineage.dataEpoch) return false;
    try {
      const coverage = await this.mainStreamCoverage();
      const cut = fusekiReadBudget.getStore() ? await this.graphCut()
        : await fusekiReadBudget.run({ signal: AbortSignal.timeout(ZONE_BROWSE_PROJECTION_COST.recoveryPageMs),
          callsLeft: 1, bytesLeft: 8192 }, () => this.graphCut());
      // Delivered coverage can itself lag committed Main selections. The
      // existing Main stream cut, never the graph diagnostic counter, proves
      // that a seek cannot omit an already admitted candidate.
      return compareRelayPositions(this.checkpoint, coverage) === 0
        && compareRelayPositions(this.checkpoint, { streamScope: MAIN_RELAY_STREAM_SCOPE,
          dataEpoch: cut.dataEpoch, sequence: cut.relaySequence }) === 0;
    } catch { return false; }
  }

  async batch(realm: string, sort: 'newest' | 'updated', after: BrowseAfter | null, position?: ReadPosition): Promise<BrowseEntry[]> {
    if (!this.usableCut && this.handoffDeferred) return [];
    if (!this.usableCut) throw new WorkReadUnavailable(this.recoveryStatus().state === 'waiting-for-cut'
      ? 'Zone browse recovery waiting for a stable cut' : 'Zone browse backfill is not ready');
    if (position && position.dataEpoch !== this.env.lineage.dataEpoch) {
      throw new WorkReadUnavailable('Zone browse projection belongs to another data epoch');
    }
    type Row = { work: string; adopted_order: string; updated_at: string | null; word_count: string | null };
    const read = async (seek: string, values: (string | null)[], limit: number) =>
      (await this.access.query<Row>(`SELECT work, adopted_order::text,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
        word_count::text FROM access.zone_browse_entry AS entry WHERE realm = $1 ${seek}
        ORDER BY ${sort === 'newest' ? 'entry.adopted_order DESC' : 'entry.updated_at DESC NULLS LAST'}, work DESC
        LIMIT ${limit}`, values)).rows;
    let rows: Row[];
    if (sort === 'newest') {
      rows = await read(after ? 'AND (adopted_order, work) < ($2::numeric, $3::text)' : '',
        after ? [realm, after.key, after.work] : [realm], ZONE_BROWSE_PROJECTION_COST.batch);
    } else {
      // SQL row comparison with null is unknown; seek each index partition
      // separately, avoiding both a lost null tail and a growing OR scan.
      // https://www.postgresql.org/docs/current/functions-comparisons.html
      rows = after?.key === null ? [] : await read('AND updated_at IS NOT NULL'
        + (after ? ' AND (updated_at, work) < ($2::timestamptz, $3::text)' : ''),
      after ? [realm, after.key, after.work] : [realm], ZONE_BROWSE_PROJECTION_COST.batch);
      if (rows.length < ZONE_BROWSE_PROJECTION_COST.batch) {
        rows.push(...await read('AND updated_at IS NULL' + (after?.key === null ? ' AND work < $2::text' : ''),
          after?.key === null ? [realm, after.work] : [realm], ZONE_BROWSE_PROJECTION_COST.batch - rows.length));
      }
    }
    return rows.map(row => ({ work: row.work, adoptedOrder: row.adopted_order,
      updatedAt: row.updated_at, words: row.word_count === null ? null : Number(row.word_count) }));
  }
}
