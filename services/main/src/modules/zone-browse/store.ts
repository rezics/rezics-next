import type { Pool } from 'pg';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadUnavailable, type ReadPosition } from '../work/read-session.ts';

export const ZONE_BROWSE_PROJECTION_COST = { batch: 64, relayEvents: 64, pollMs: 500 } as const;
const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export interface BrowseEntry { work: string; adoptedOrder: string; updatedAt: string | null; words: number | null }
export interface BrowseAfter { work: string; key: string | null }
export interface BrowseEntryReader {
  batch(realm: string, sort: 'newest' | 'updated', after: BrowseAfter | null, position?: ReadPosition): Promise<BrowseEntry[]>;
}

/** One index seek per batch, O(log N + 64), O(64) memory. RDF remains the
 * disclosure authority. The table contains candidates, never public counts. */
export class ZoneBrowseProjection implements BrowseEntryReader {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;
  private ready = false;
  private after = '0';
  private afterEvent: string | null = null;
  private observed = '0';
  constructor(private readonly access: Pool, private readonly relay: Pool,
    private readonly env: WorkActivationEnvironment) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = (this.ready ? this.tick() : this.backfill())
        .catch(error => { console.error('Zone browse projection deferred', error); })
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

  private async project(where: string, epochs: string): Promise<{ realm: string; work: string }[]> {
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
    const examined: { realm: string; work: string }[] = [];
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      // SerialStatisticsProjection holds this row FOR UPDATE while changing
      // summaries. Its triggers cannot race an adoption's initial stats copy.
      await client.query('SELECT generation FROM access.serial_stats_checkpoint WHERE singleton FOR SHARE');
      for (const row of rows) {
        const realm = row.realm?.value, work = row.work?.value;
        if (realm && work) examined.push({ realm, work });
        if (!realm || !work || !ID.test(realm) || !ID.test(work)
          || !/^\d{1,38}$/.test(row.sequence?.value ?? '') || !/^\d+$/.test(row.epochOrder?.value ?? '')) {
          console.error('Zone browse backfill skipped malformed adoption', { realm, work });
          continue;
        }
        const order = BigInt(row.sequence!.value) + BigInt(row.epochOrder!.value) * 10n ** 38n;
        await client.query(`INSERT INTO access.zone_browse_entry (realm, work, adopted_order, updated_at, word_count)
          SELECT $1, $2, $3::numeric, s.last_updated_at, s.word_count
          FROM (VALUES (true)) AS anchor(singleton)
          LEFT JOIN access.serial_stats_checkpoint c USING (singleton)
          LEFT JOIN access.serial_summary s ON s.generation = c.generation AND s.work = $2
          ON CONFLICT (realm, work) DO UPDATE SET updated_at = EXCLUDED.updated_at, word_count = EXCLUDED.word_count`, [realm, work, order.toString()]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return examined;
  }

  /** Idempotent, asynchronous startup reconciliation; never runs in a read.
   * Capture the relay cut first so arrivals during backfill are replayed. */
  async backfill(): Promise<void> {
    this.ready = false;
    const cut = await this.graphCut();
    const head = (await this.relay.query<{ head: string }>(`SELECT coalesce(max(sequence),0)::text AS head
      FROM relay.delivered_batch WHERE data_epoch = $1`, [this.env.lineage.dataEpoch])).rows[0]!.head;
    const epochs = await this.epochs();
    let after: { realm: string; work: string } | undefined;
    for (;;) {
      const rows = await this.project(after ? `FILTER(STR(?realm) > ${lit(after.realm)}
        || (STR(?realm) = ${lit(after.realm)} && STR(?work) > ${lit(after.work)}))` : '', epochs);
      if (rows.length < ZONE_BROWSE_PROJECTION_COST.batch) break;
      after = rows.at(-1)!;
    }
    // Replay from the earlier relay cut covers graph writes during this pass,
    // including insertions behind the backfill's key. Only recovery fences it.
    await this.graphCut();
    this.after = head;
    this.afterEvent = null;
    this.observed = cut;
    this.ready = true;
  }

  private async graphCut(): Promise<string> {
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.sequence?.value ?? '')) {
      throw new WorkReadUnavailable('Zone browse graph cut is unavailable');
    }
    return rows[0]!.sequence!.value;
  }

  async tick(): Promise<number> {
    if (!this.ready) { await this.backfill(); return 0; }
    const head = (await this.relay.query<{ head: string }>(`SELECT coalesce(max(sequence),0)::text AS head
      FROM relay.delivered_batch WHERE data_epoch = $1`, [this.env.lineage.dataEpoch])).rows[0]!.head;
    const rows = (await this.relay.query<{ sequence: string; event_id: string; envelope: {
      type: string; data?: { receipt?: { outcome?: string; realm?: string; work?: string } } } }>(`
      SELECT sequence::text, event_id, envelope FROM relay.delivered_event AS event
      WHERE source = 'https://rezics.com/services/main' AND data_epoch = $1
        AND (sequence > $2::numeric OR (sequence = $2::numeric AND $3::text IS NOT NULL AND event_id > $3::text))
        AND sequence <= $4::numeric ORDER BY event.sequence, event_id LIMIT $5`,
    [this.env.lineage.dataEpoch, this.after, this.afterEvent, head, ZONE_BROWSE_PROJECTION_COST.relayEvents])).rows;
    const epochs = rows.length ? await this.epochs() : '';
    for (const row of rows) {
      const receipt = row.envelope.data?.receipt;
      if (receipt?.outcome === 'succeeded' && receipt.realm && receipt.work
        && /(?:realm\.selection-changed|realm\.publication-suppressed|realm\.submission-selected|realm\.resource-selected)/.test(row.envelope.type)) {
        if (!ID.test(receipt.realm) || !ID.test(receipt.work)) throw new WorkReadUnavailable('Zone browse relay identity is invalid');
        const values = `VALUES (?realm ?work) { (${iri(receipt.realm)} ${iri(receipt.work)}) }`;
        const projected = await this.project(values, epochs);
        if (!projected.length) await this.access.query('DELETE FROM access.zone_browse_entry WHERE realm = $1 AND work = $2',
          [receipt.realm, receipt.work]);
      }
    }
    if (rows.length) {
      this.after = rows.at(-1)!.sequence;
      this.afterEvent = rows.at(-1)!.event_id;
    }
    const completed = rows.length === ZONE_BROWSE_PROJECTION_COST.relayEvents
      ? (BigInt(this.after) - 1n).toString()
      : head;
    if (rows.length < ZONE_BROWSE_PROJECTION_COST.relayEvents) {
      this.after = head;
      this.afterEvent = null;
    }
    if (BigInt(completed) > BigInt(this.observed)) this.observed = completed;
    return rows.length;
  }

  async batch(realm: string, sort: 'newest' | 'updated', after: BrowseAfter | null, position?: ReadPosition): Promise<BrowseEntry[]> {
    if (!this.ready) throw new WorkReadUnavailable('Zone browse backfill is not ready');
    if (position && (position.dataEpoch !== this.env.lineage.dataEpoch
      || BigInt(position.sequence) > BigInt(this.observed))) {
      throw new WorkReadUnavailable('Zone browse relay has not reached the read position');
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
